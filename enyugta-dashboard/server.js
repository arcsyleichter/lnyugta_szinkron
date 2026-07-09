// L-NYUGTA élő értékesítési nézegető — önálló Node.js szerver
// Nincs npm függőség: csak a Node beépített moduljait használja,
// beleértve a Node 22.5+ -ban elérhető node:sqlite-ot.
// Indítás: node server.js   (lásd README.md)
//
// TÖBB CÉG EGYSZERRE ("multi-tenant")
// ------------------------------------------------------------------
// Minden cégnek saját SQLite fájlja van a data/companies/ mappában,
// az adószám első 8 számjegyével elnevezve (pl. data/companies/18774455.db).
// A szerver induláskor beolvassa az összes ilyen fájl "szallitot" tábláját,
// és egy memóriában tartott indexet épít belőle (cégnév, adószám, cím stb.),
// hogy bejelentkezéskor ne kelljen minden fájlt megnyitni. Az androidos app
// folyamatosan, akár több száz különböző cég nevében szinkronizálhat — minden
// feltöltés a saját adószámának megfelelő .db fájlt cseréli le, a többi cég
// adatait nem érinti.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------------------
// Konfiguráció
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = path.join(__dirname, 'data');
const COMPANIES_DIR = path.join(DATA_DIR, 'companies');
const SYNC_META_PATH = path.join(DATA_DIR, 'sync-meta.json');
const SECRETS_PATH = path.join(DATA_DIR, '.secrets.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 óra
const MAX_OPEN_DB_CONNECTIONS = 40; // ennyi cég adatbázisát tartjuk egyszerre nyitva (LRU)

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(COMPANIES_DIR)) fs.mkdirSync(COMPANIES_DIR, { recursive: true });

// Első indításkor generálunk egy munkamenet-titkot és egy szinkron API kulcsot,
// ha még nincs beállítva környezeti változóban. Éles üzemben mindkettő
// SESSION_SECRET / SYNC_API_KEY env változóból jön (lásd README.md).
function loadOrCreateSecrets() {
  let stored = {};
  if (fs.existsSync(SECRETS_PATH)) {
    try { stored = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8')); } catch (_) { stored = {}; }
  }
  const sessionSecret = process.env.SESSION_SECRET || stored.sessionSecret || crypto.randomBytes(32).toString('hex');
  const syncApiKey = process.env.SYNC_API_KEY || stored.syncApiKey || crypto.randomBytes(24).toString('hex');
  const adminPassword = process.env.ADMIN_PASSWORD || stored.adminPassword || crypto.randomBytes(9).toString('base64url');
  const next = { sessionSecret, syncApiKey, adminPassword };
  if (JSON.stringify(next) !== JSON.stringify(stored)) {
    fs.writeFileSync(SECRETS_PATH, JSON.stringify(next, null, 2));
  }
  return next;
}
const SECRETS = loadOrCreateSecrets();

if (!process.env.SYNC_API_KEY) {
  console.log('\n[info] Nincs SYNC_API_KEY env változó beállítva — generált kulcs a data/.secrets.json fájlban.');
  console.log(`[info] Az androidos szinkronhoz ezt a kulcsot kell majd megadni: ${SECRETS.syncApiKey}\n`);
}
if (!process.env.ADMIN_PASSWORD) {
  console.log('[info] Nincs ADMIN_PASSWORD env változó beállítva — generált jelszó a data/.secrets.json fájlban.');
  console.log(`[info] Admin belépéshez ezt a jelszót kell majd megadni: ${SECRETS.adminPassword}\n`);
}

function normalizeAdoszam(s) {
  return String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}
// A cég "kulcsa" mindenhol az adószám első 8 számjegye — ez azonosítja
// egyértelműen a fájlnevet, a bejelentkezést és a nyitott kapcsolatot is.
function companyKeyFromAdoszam(adoszam) {
  return normalizeAdoszam(adoszam).slice(0, 8);
}
function dbFileForKey(key) {
  return path.join(COMPANIES_DIR, `${key}.db`);
}

// ---------------------------------------------------------------------------
// Cégindex — memóriában tartott lista arról, milyen cégek (.db fájlok)
// érhetők el, és mi az adataik (cégnév, adószám, város, cím). A tényleges
// forgalmi adatokat NEM tartalmazza — azokat lekérdezéskor olvassuk ki
// a megfelelő adatbázisból.
// ---------------------------------------------------------------------------

const companyIndex = new Map(); // key(8 jegy) -> { cegid, nev, adoszam, varos, cim, dbFile }

function readCompanyIdentity(dbFile) {
  const tmp = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return tmp.prepare('SELECT cegid, nev, adoszam, varos, cim FROM szallitot LIMIT 1').get() || null;
  } finally {
    tmp.close();
  }
}

function scanCompanies() {
  companyIndex.clear();
  const files = fs.readdirSync(COMPANIES_DIR).filter((f) => f.endsWith('.db'));
  for (const f of files) {
    const key = f.replace(/\.db$/, '');
    const dbFile = path.join(COMPANIES_DIR, f);
    try {
      const identity = readCompanyIdentity(dbFile);
      if (identity) companyIndex.set(key, { ...identity, dbFile });
      else console.warn(`[warn] ${f}: nincs szallitot sor, kihagyva.`);
    } catch (e) {
      console.error(`[warn] nem sikerült beolvasni: ${f} — ${e.message}`);
    }
  }
  console.log(`[info] ${companyIndex.size} cég betöltve a data/companies/ mappából.`);
}
scanCompanies();

// ---------------------------------------------------------------------------
// Kapcsolat-gyorsítótár — cégenként lusta betöltés, LRU kiürítéssel, hogy
// több száz cég esetén se maradjon nyitva korlátlan sok fájl egyszerre.
// ---------------------------------------------------------------------------

const dbCache = new Map(); // key -> { db, lastUsed }

function getDb(key) {
  const cached = dbCache.get(key);
  if (cached) { cached.lastUsed = Date.now(); return cached.db; }
  const entry = companyIndex.get(key);
  if (!entry) { const e = new Error('COMPANY_NOT_FOUND'); e.code = 'COMPANY_NOT_FOUND'; throw e; }
  const db = new DatabaseSync(entry.dbFile, { readOnly: false });
  dbCache.set(key, { db, lastUsed: Date.now() });
  evictIfNeeded();
  return db;
}
function evictConnection(key) {
  const cached = dbCache.get(key);
  if (cached) { try { cached.db.close(); } catch (_) {} dbCache.delete(key); }
}
function evictIfNeeded() {
  if (dbCache.size <= MAX_OPEN_DB_CONNECTIONS) return;
  let oldestKey = null, oldestTime = Infinity;
  for (const [k, v] of dbCache) { if (v.lastUsed < oldestTime) { oldestTime = v.lastUsed; oldestKey = k; } }
  if (oldestKey) evictConnection(oldestKey);
}

function all(key, sql, params = []) { return getDb(key).prepare(sql).all(...params); }
function get(key, sql, params = []) { return getDb(key).prepare(sql).get(...params); }

// ---------------------------------------------------------------------------
// Készlet — bevételezések tárolása. SZÁNDÉKOSAN KÜLÖN fájlban (data/stock.db),
// NEM a cégek szinkronizált .db fájljában, mert azt az androidos app
// időnként teljes egészében felülírja egy friss szinkronnal — ha ide
// mentenénk a bevételezéseket, minden feltöltéskor elvesznének. Ez a fájl
// sosem érintkezik az android-szinkronnal, csak a webes admin/cég felület
// írja/olvassa. Egyetlen közös fájl, company_key oszloppal elkülönítve
// (nem kell cégenként külön fájlt nyitogatni, a várható adatmennyiség kicsi).
// ---------------------------------------------------------------------------
const STOCK_DB_PATH = path.join(DATA_DIR, 'stock.db');
const stockDb = new DatabaseSync(STOCK_DB_PATH, { readOnly: false });
stockDb.exec(`
  CREATE TABLE IF NOT EXISTS bevetelezesek (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_key TEXT NOT NULL,
    datum TEXT NOT NULL,
    cikk_nev TEXT NOT NULL,
    me TEXT,
    mennyiseg NUMERIC NOT NULL,
    beszerzesi_ar NUMERIC,
    szallito TEXT,
    megjegyzes TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bevetelezesek_company ON bevetelezesek(company_key);
  CREATE INDEX IF NOT EXISTS idx_bevetelezesek_cikk ON bevetelezesek(company_key, cikk_nev);

  CREATE TABLE IF NOT EXISTS keszlet_riasztas (
    company_key TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('cikk','csoport')),
    nev TEXT NOT NULL,
    kuszob NUMERIC NOT NULL,
    PRIMARY KEY (company_key, scope, nev)
  );
`);

// ---------------------------------------------------------------------------
// Szinkron-metaadat — cégenkénti utolsó szinkronizáció ideje/mérete,
// data/sync-meta.json-ban tárolva: { "<key>": { lastSync, source, bytes } }
// ---------------------------------------------------------------------------

function readSyncMeta() {
  try { return JSON.parse(fs.readFileSync(SYNC_META_PATH, 'utf8')); }
  catch (_) { return {}; }
}
function writeSyncMeta(meta) {
  fs.writeFileSync(SYNC_META_PATH, JSON.stringify(meta, null, 2));
}

// ---------------------------------------------------------------------------
// Tevékenység-napló — MINDEN releváns esemény ide kerül, cégenként és
// típusonként megkülönböztetve, sikeres és sikertelen próbálkozás is:
// céges bejelentkezés, admin bejelentkezés, admin műveletek (cég megnyitása,
// kód újragenerálás/kiküldés), szinkron feltöltés, bevételezés rögzítése/
// törlése. JSONL formátum (soronként egy JSON objektum), data/activity-log.jsonl.
// Egyszerű rotáció: ha 8000 sor fölé nő, az utolsó 3000-re vágjuk vissza.
// ---------------------------------------------------------------------------
const ACTIVITY_LOG_PATH = path.join(DATA_DIR, 'activity-log.jsonl');
const ACTIVITY_LOG_MAX_LINES = 8000;
const ACTIVITY_LOG_TRIM_TO = 3000;

// Típuscímkék — csak dokumentációs célból itt, a tényleges magyar feliratozás
// a felületen (app.js ACTIVITY_TYPE_LABELS) történik.
// 'company_login' | 'admin_login' | 'admin_impersonate' | 'admin_regen_code' |
// 'admin_send_code' | 'sync_upload' | 'stock_receipt_add' | 'stock_receipt_delete'

function logActivity(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try {
    fs.appendFileSync(ACTIVITY_LOG_PATH, line + '\n');
    maybeTrimActivityLog();
  } catch (e) {
    console.error('[hiba] tevékenység-napló írása sikertelen:', e.message);
  }
}
function maybeTrimActivityLog() {
  let stat;
  try { stat = fs.statSync(ACTIVITY_LOG_PATH); } catch (_) { return; }
  if (stat.size < 512 * 1024) return; // ne olvassuk feleslegesen minden íráskor, csak ha már számottevő a fájl
  const lines = fs.readFileSync(ACTIVITY_LOG_PATH, 'utf8').split('\n').filter(Boolean);
  if (lines.length > ACTIVITY_LOG_MAX_LINES) {
    fs.writeFileSync(ACTIVITY_LOG_PATH, lines.slice(-ACTIVITY_LOG_TRIM_TO).join('\n') + '\n');
  }
}
function readActivityLog(limit) {
  let lines;
  try { lines = fs.readFileSync(ACTIVITY_LOG_PATH, 'utf8').split('\n').filter(Boolean); }
  catch (_) { return []; }
  return lines.slice(-limit).reverse().map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Hozzáférési kódok — az adószám ÖNMAGÁBAN NEM titok (Magyarországon bárki
// lekérdezheti egy cég adószámát), ezért a bejelentkezéshez egy második,
// tényleg titkos kódot is meg kell adni. Cégenként tárolva,
// data/access-codes.json-ban: { "<companyKey>": { code, email } }.
// Az "email" a legutóbb megadott/elmentett cím, amire a kódot kiküldtük —
// csak kényelmi célból tárolt, hogy az admin panelen ne kelljen újra beírni.
// Minden cég automatikusan kap egy kódot, amint először megjelenik az
// indexben (induláskor a meglévőknek, első szinkronkor az újaknak) — ezt
// az admin panelen lehet visszanézni / újragenerálni / kiküldeni.
// ---------------------------------------------------------------------------
const ACCESS_CODES_PATH = path.join(DATA_DIR, 'access-codes.json');

function readAccessCodes() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(ACCESS_CODES_PATH, 'utf8')); }
  catch (_) { return {}; }
  // migráció: korábbi verzióban codes[key] sima string volt (csak a kód)
  for (const k of Object.keys(raw)) {
    if (typeof raw[k] === 'string') raw[k] = { code: raw[k], email: '' };
  }
  return raw;
}
function writeAccessCodes(codes) {
  fs.writeFileSync(ACCESS_CODES_PATH, JSON.stringify(codes, null, 2));
}
function generateAccessCode() {
  // 6 jegyű, könnyen diktálható/begépelhető kód (nem base64 zagyvaság)
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
// Biztosítja, hogy MINDEN, az indexben szereplő cégnek legyen kódja —
// hiányzóknak generál egyet, és elmenti. Induláskor és minden új
// cég-regisztrációkor hívjuk.
function ensureAccessCodes() {
  const codes = readAccessCodes();
  let changed = false;
  for (const key of companyIndex.keys()) {
    if (!codes[key]) { codes[key] = { code: generateAccessCode(), email: '' }; changed = true; }
  }
  if (changed) writeAccessCodes(codes);
  return codes;
}
ensureAccessCodes();

// ---------------------------------------------------------------------------
// Email küldés Brevón keresztül — a hozzáférési kód kiküldéséhez az admin
// panelről. Nincs npm-függőség: a Node beépített fetch()-ét használja.
// Konfiguráció (Render Environment fülön / .secrets.json-ban NEM tárolt,
// mert nincs értelmes véletlen alapérték — ezt neked kell megadnod):
//   BREVO_API_KEY      — a Brevo fiókod API-kulcsa
//   BREVO_SENDER_EMAIL — a Brevo-ban ELLENŐRZÖTT feladó email cím
//   BREVO_SENDER_NAME  — feladó neve (opcionális, van alapértelmezés)
// ---------------------------------------------------------------------------
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || '';
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'L-NYUGTA rendszer';

if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
  console.log('[info] Nincs BREVO_API_KEY / BREVO_SENDER_EMAIL beállítva — az admin panel email-küldés funkciója nem fog működni, amíg ezeket meg nem adod (lásd README).');
}

function escapeHtmlServer(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendBrevoEmail({ toEmail, toName, subject, html }) {
  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
    throw new Error('Nincs beállítva a Brevo email küldés (BREVO_API_KEY / BREVO_SENDER_EMAIL hiányzik).');
  }
  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
      to: [{ email: toEmail, name: toName || undefined }],
      subject,
      htmlContent: html,
    }),
  });
  if (!resp.ok) {
    let detail = await resp.text();
    try { detail = JSON.parse(detail).message || detail; } catch (_) {}
    throw new Error(`Brevo hiba (${resp.status}): ${detail}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// Apró segédfüggvények — session token (HMAC-aláírt, cookie-ban tárolt)
// ---------------------------------------------------------------------------

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

function signSession(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRETS.sessionSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRETS.sessionSecret).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (_) { return null; }
}
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

// ---------------------------------------------------------------------------
// Kis segédfüggvények a kérés/válasz kezeléshez
// ---------------------------------------------------------------------------

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}
function readBody(req, limitBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJsonBody(req) {
  const buf = await readBody(req, 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch (_) { return {}; }
}

// Bejelentkezett munkamenet ELLENŐRZÉSE + hogy a hozzá tartozó cég még
// ténylegesen létezik-e (pl. nem törölték időközben a .db fájlját).
function requireAuth(req) {
  const cookies = parseCookies(req.headers.cookie);
  const session = verifySession(cookies.enysession);
  if (!session || !session.companyKey || !companyIndex.has(session.companyKey)) return null;
  return session;
}

// Admin munkamenet — KÜLÖN cookie-ban (enyadmin), nem keverendő a cégenkénti
// bejelentkezéssel. Az admin jelszava a data/.secrets.json-ban (vagy
// ADMIN_PASSWORD env változóban) van, teljesen független a szinkron API kulcstól.
function requireAdmin(req) {
  const cookies = parseCookies(req.headers.cookie);
  const session = verifySession(cookies.enyadmin);
  if (!session || !session.isAdmin) return null;
  return session;
}

// Dátum-tartomány normalizálása: alapértelmezés az utolsó 30 nap
function todayIsoServer() { return new Date().toISOString().slice(0, 10); }

function resolveRange(query) {
  const today = new Date();
  const toDefault = today.toISOString().slice(0, 10);
  const fromDefault = new Date(today.getTime() - 29 * 86400000).toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : fromDefault;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : toDefault;
  return { from, to };
}

const NOT_STORNO = "(IFNULL(storno,'N') != 'I' AND IFNULL(stornozott,'N') != 'I')";
function notStorno(alias) { return `(IFNULL(${alias}.storno,'N') != 'I' AND IFNULL(${alias}.stornozott,'N') != 'I')`; }

// ---------------------------------------------------------------------------
// API route handlerek
// ---------------------------------------------------------------------------

const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

route('POST', '/api/auth/login', async (req, res) => {
  const ip = (req.socket && req.socket.remoteAddress) || null;
  const { adoszam, code } = await readJsonBody(req);
  const wanted = normalizeAdoszam(adoszam);
  if (wanted.length < 8) return sendJson(res, 400, { error: 'Adj meg legalább 8 számjegyet az adószámból.' });
  const key = wanted.slice(0, 8);
  const entry = companyIndex.get(key);
  if (!entry) {
    logActivity({ type: 'company_login', ok: false, companyKey: key, nev: null, detail: 'Ismeretlen adószám.', ip });
    return sendJson(res, 401, { error: 'Ismeretlen adószám. Ellenőrizd, és próbáld újra.' });
  }
  const codes = readAccessCodes();
  const expected = codes[key]?.code;
  if (!expected || !code || String(code).trim() !== expected) {
    logActivity({ type: 'company_login', ok: false, companyKey: key, nev: entry.nev, detail: 'Hibás hozzáférési kód.', ip });
    return sendJson(res, 401, { error: 'Hibás hozzáférési kód. Kérd el a céged adminisztrátorától.' });
  }
  const payload = { companyKey: key, cegid: entry.cegid, nev: entry.nev, adoszam: entry.adoszam, exp: Date.now() + SESSION_MAX_AGE_MS };
  const token = signSession(payload);
  const cookie = `enysession=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax`;
  logActivity({ type: 'company_login', ok: true, companyKey: key, nev: entry.nev, detail: 'Sikeres bejelentkezés.', ip });
  sendJson(res, 200, { ok: true, company: { nev: entry.nev, adoszam: entry.adoszam, varos: entry.varos, cim: entry.cim } }, { 'Set-Cookie': cookie });
});

route('POST', '/api/auth/logout', async (req, res) => {
  const session = requireAuth(req);
  if (session) logActivity({ type: 'company_logout', ok: true, companyKey: session.companyKey, nev: session.nev, detail: 'Kijelentkezés.' });
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'enysession=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' });
});

route('GET', '/api/me', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const meta = readSyncMeta();
  sendJson(res, 200, { company: { nev: session.nev, adoszam: session.adoszam }, sync: meta[session.companyKey] || { lastSync: null, source: null } });
});

route('GET', '/api/summary', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const k = session.companyKey;
  const { from, to } = resolveRange(query);
  const cur = get(k,
    `SELECT COUNT(*) AS cnt, IFNULL(SUM(bruttokp+bruttoafr+bruttokartya),0) AS revenue
     FROM nyfej WHERE keltdat BETWEEN ? AND ? AND ${NOT_STORNO}`,
    [from, to]
  );
  const byFizmod = all(k,
    `SELECT fizmod, COUNT(*) AS cnt, IFNULL(SUM(bruttokp+bruttoafr+bruttokartya),0) AS revenue
     FROM nyfej WHERE keltdat BETWEEN ? AND ? AND ${NOT_STORNO} GROUP BY fizmod ORDER BY revenue DESC`,
    [from, to]
  );
  // előző, azonos hosszúságú időszak a trendhez
  const spanDays = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  const prevTo = new Date(new Date(from).getTime() - 86400000).toISOString().slice(0, 10);
  const prevFrom = new Date(new Date(from).getTime() - spanDays * 86400000).toISOString().slice(0, 10);
  const prev = get(k,
    `SELECT COUNT(*) AS cnt, IFNULL(SUM(bruttokp+bruttoafr+bruttokartya),0) AS revenue
     FROM nyfej WHERE keltdat BETWEEN ? AND ? AND ${NOT_STORNO}`,
    [prevFrom, prevTo]
  );
  sendJson(res, 200, {
    from, to,
    revenue: cur.revenue, receiptCount: cur.cnt,
    avgBasket: cur.cnt ? Math.round(cur.revenue / cur.cnt) : 0,
    byFizmod,
    prev: { revenue: prev.revenue, receiptCount: prev.cnt, from: prevFrom, to: prevTo },
  });
});

route('GET', '/api/revenue-series', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const k = session.companyKey;
  const { from, to } = resolveRange(query);
  const group = ['hour', 'day', 'week', 'month'].includes(query.group) ? query.group : 'day';

  if (group === 'hour') {
    if (from !== to) {
      return sendJson(res, 400, { error: 'Óránkénti bontáshoz egyetlen napot válassz ki (a kezdő és záró dátum legyen ugyanaz).' });
    }
    // Az órás bontáshoz a rendkezdatum (a nyugta tényleges kezdési időpontja)
    // kell, NEM az umdate — utóbbi azt mutatja, mikor szinkronizálódott utoljára
    // a sor a szerverre, ami sok nyugtánál egyszerre, jóval később történik,
    // és órás bontásban félrevezető torlódást mutatna egyetlen órában.
    const rows = all(k,
      `SELECT strftime('%H', rendkezdatum) AS hh, IFNULL(SUM(bruttokp+bruttoafr+bruttokartya),0) AS revenue, COUNT(*) AS cnt
       FROM nyfej WHERE keltdat = ? AND rendkezdatum IS NOT NULL AND ${NOT_STORNO} GROUP BY hh`,
      [from]
    );
    const byHour = new Map(rows.map((r) => [r.hh, r]));
    const points = [];
    for (let h = 0; h < 24; h++) {
      const hh = String(h).padStart(2, '0');
      const row = byHour.get(hh);
      points.push({ d: hh, revenue: row ? row.revenue : 0, cnt: row ? row.cnt : 0 });
    }
    return sendJson(res, 200, { group, points });
  }

  const daily = all(k,
    `SELECT keltdat AS d, IFNULL(SUM(bruttokp+bruttoafr+bruttokartya),0) AS revenue, COUNT(*) AS cnt
     FROM nyfej WHERE keltdat BETWEEN ? AND ? AND ${NOT_STORNO} GROUP BY keltdat ORDER BY keltdat`,
    [from, to]
  );
  if (group === 'day') return sendJson(res, 200, { group, points: daily });
  const buckets = new Map();
  for (const row of daily) {
    const d = new Date(row.d);
    let key;
    if (group === 'month') {
      key = row.d.slice(0, 7);
    } else {
      const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      const dayNum = (tmp.getUTCDay() + 6) % 7; // hétfő=0
      tmp.setUTCDate(tmp.getUTCDate() - dayNum);
      key = tmp.toISOString().slice(0, 10);
    }
    const acc = buckets.get(key) || { d: key, revenue: 0, cnt: 0 };
    acc.revenue += row.revenue; acc.cnt += row.cnt;
    buckets.set(key, acc);
  }
  sendJson(res, 200, { group, points: [...buckets.values()].sort((a, b) => a.d.localeCompare(b.d)) });
});


route('GET', '/api/products', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const k = session.companyKey;
  const { from, to } = resolveRange(query);
  const q = (query.q || '').trim();
  const limit = Math.min(parseInt(query.limit || '50', 10) || 50, 500);
  const offset = Math.max(parseInt(query.offset || '0', 10) || 0, 0);
  const params = [from, to];
  let where = `nf.keltdat BETWEEN ? AND ? AND ${notStorno('nf')}`;
  if (q) { where += ' AND nt.megnevezes LIKE ?'; params.push(`%${q}%`); }
  const rows = all(k,
    `SELECT nt.megnevezes AS nev, SUM(nt.menny) AS mennyiseg, nt.me AS me,
            IFNULL(SUM(nt.sorbrutto),0) AS arbevetel, COUNT(DISTINCT nt.bsz) AS nyugtaszam
     FROM nytet nt JOIN nyfej nf ON nf.bsz = nt.bsz
     WHERE ${where}
     GROUP BY nt.megnevezes, nt.me
     ORDER BY arbevetel DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const totalRow = get(k,
    `SELECT COUNT(DISTINCT nt.megnevezes) AS cnt FROM nytet nt JOIN nyfej nf ON nf.bsz = nt.bsz WHERE ${where}`,
    params
  );
  sendJson(res, 200, { from, to, q, items: rows, total: totalRow.cnt, limit, offset });
});

route('GET', '/api/receipts', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const k = session.companyKey;
  const { from, to } = resolveRange(query);
  const q = (query.q || '').trim();
  const fizmod = (query.fizmod || '').trim();
  const min = query.min ? parseFloat(query.min) : null;
  const max = query.max ? parseFloat(query.max) : null;
  const limit = Math.min(parseInt(query.limit || '25', 10) || 25, 200);
  const offset = Math.max(parseInt(query.offset || '0', 10) || 0, 0);

  let where = `keltdat BETWEEN ? AND ? AND ${NOT_STORNO}`;
  const params = [from, to];
  if (q) { where += ' AND bsz LIKE ?'; params.push(`%${q}%`); }
  if (fizmod) { where += ' AND fizmod = ?'; params.push(fizmod); }
  if (min !== null) { where += ' AND (bruttokp+bruttoafr+bruttokartya) >= ?'; params.push(min); }
  if (max !== null) { where += ' AND (bruttokp+bruttoafr+bruttokartya) <= ?'; params.push(max); }

  const rows = all(k,
    `SELECT bsz, keltdat, fizmod, (bruttokp+bruttoafr+bruttokartya) AS osszeg
     FROM nyfej WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const totalRow = get(k, `SELECT COUNT(*) AS cnt FROM nyfej WHERE ${where}`, params);
  sendJson(res, 200, { from, to, q, fizmod, items: rows, total: totalRow.cnt, limit, offset });
});

route('GET', '/api/vat-breakdown', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const k = session.companyKey;
  const { from, to } = resolveRange(query);
  const rows = all(k,
    `SELECT nt.afakod AS afakod,
            IFNULL(SUM(nt.sorbrutto),0) AS brutto,
            IFNULL(SUM(nt.sorafa),0) AS afa,
            IFNULL(SUM(nt.sornetto),0) AS netto
     FROM nytet nt JOIN nyfej nf ON nf.bsz = nt.bsz
     WHERE nf.keltdat BETWEEN ? AND ? AND ${notStorno('nf')}
     GROUP BY nt.afakod ORDER BY brutto DESC`,
    [from, to]
  );
  sendJson(res, 200, { from, to, items: rows });
});

// Cikktörzs (a teljes termékkínálat, nem csak amit eladtak) — egyelőre
// csak olvasható. Ez táplálja a Készlet modul termékválasztóját is.
route('GET', '/api/products/master', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const rows = all(session.companyKey,
    `SELECT c.megnevezes AS nev, c.me, c.bruttoar, c.afakod, c.vonalkod, c.status,
            IFNULL(g.megnevezes, 'Nincs csoport') AS csoportNev
     FROM cikkt c LEFT JOIN cikkcsop g ON g.azon = c.csopazon
     WHERE c.status = 'A' ORDER BY c.megnevezes`
  );
  sendJson(res, 200, { items: rows });
});

// ---------------------------------------------------------------------------
// Készlet — bevételezés alapú nyilvántartás. A stock.db-ben tárolt
// bevételezések és a szinkronizált nytet-ből számolt eladások különbségéből
// adódik a jelenlegi készlet. Teljes, dátumhatár nélküli összesítés (a
// készlet fizikai állapot, nem egy kiválasztott jelentési időszakra
// vonatkozik). MINDEN aktív cikk szerepel a listában, akkor is, ha még
// egyszer sem volt hozzá bevételezés rögzítve (0-ként) — ez szándékos: a
// meglévő boltoknak a valós készletet egy nyitó bevételezéssel kell majd
// feltölteniük, addig természetes, hogy negatív értéket mutat.
// ---------------------------------------------------------------------------
function readThresholds(companyKey) {
  const rows = stockDb.prepare(`SELECT scope, nev, kuszob FROM keszlet_riasztas WHERE company_key = ?`).all(companyKey);
  const cikk = new Map(), csoport = new Map();
  for (const r of rows) (r.scope === 'cikk' ? cikk : csoport).set(r.nev, r.kuszob);
  return { cikk, csoport };
}

route('GET', '/api/stock', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const k = session.companyKey;
  const q = (query.q || '').trim().toLowerCase();
  const csoportSzuro = (query.csoport || '').trim();

  const products = all(k,
    `SELECT c.megnevezes AS nev, c.me,
            IFNULL(g.megnevezes, 'Nincs csoport') AS csoportNev
     FROM cikkt c LEFT JOIN cikkcsop g ON g.azon = c.csopazon
     WHERE c.status = 'A'`
  );
  const received = stockDb.prepare(
    `SELECT cikk_nev AS nev, SUM(mennyiseg) AS mennyiseg, MAX(datum) AS utolsoBevetelezes
     FROM bevetelezesek WHERE company_key = ? GROUP BY cikk_nev`
  ).all(k);
  const receivedMap = new Map(received.map((r) => [r.nev, r]));
  const sold = all(k,
    `SELECT nt.megnevezes AS nev, IFNULL(SUM(nt.menny),0) AS mennyiseg
     FROM nytet nt JOIN nyfej nf ON nf.bsz = nt.bsz
     WHERE ${notStorno('nf')}
     GROUP BY nt.megnevezes`
  );
  const soldMap = new Map(sold.map((r) => [r.nev, r.mennyiseg]));
  const thresholds = readThresholds(k);

  // olyan cikk is bekerülhet, ami már nincs az aktív cikkt-ben, de van rá
  // bevételezés vagy eladás (pl. kifutott termék) — ne tűnjön el nyomtalanul
  const byName = new Map(products.map((p) => [p.nev, p]));
  for (const r of received) if (!byName.has(r.nev)) byName.set(r.nev, { nev: r.nev, me: null, csoportNev: 'Nincs csoport' });
  for (const s of sold) if (!byName.has(s.nev)) byName.set(s.nev, { nev: s.nev, me: null, csoportNev: 'Nincs csoport' });

  let items = [...byName.values()].map((p) => {
    const r = receivedMap.get(p.nev);
    const bevetelezve = r ? r.mennyiseg : 0;
    const eladva = soldMap.get(p.nev) || 0;
    const keszlet = bevetelezve - eladva;
    const kuszob = thresholds.cikk.has(p.nev) ? thresholds.cikk.get(p.nev)
      : (thresholds.csoport.has(p.csoportNev) ? thresholds.csoport.get(p.csoportNev) : null);
    return {
      nev: p.nev, me: p.me, csoportNev: p.csoportNev,
      bevetelezve, eladva, keszlet,
      utolsoBevetelezes: r ? r.utolsoBevetelezes : null,
      kuszob, alacsony: kuszob != null && keszlet < kuszob,
    };
  });

  // csoportok listája (szűretlen alapon, hogy a csempék ne tűnjenek el szűréskor)
  const groupCounts = new Map();
  for (const it of items) groupCounts.set(it.csoportNev, (groupCounts.get(it.csoportNev) || 0) + 1);
  const groups = [...groupCounts.entries()].map(([nev, cnt]) => ({ nev, cnt, kuszob: thresholds.csoport.has(nev) ? thresholds.csoport.get(nev) : null })).sort((a, b) => a.nev.localeCompare(b.nev, 'hu'));

  if (csoportSzuro) items = items.filter((it) => it.csoportNev === csoportSzuro);
  if (q) items = items.filter((it) => it.nev.toLowerCase().includes(q));
  items.sort((a, b) => a.nev.localeCompare(b.nev, 'hu'));

  sendJson(res, 200, { items, groups });
});

route('GET', '/api/stock/receipts', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const limit = Math.min(parseInt(query.limit || '50', 10) || 50, 500);
  const rows = stockDb.prepare(
    `SELECT id, datum, cikk_nev AS cikkNev, me, mennyiseg, beszerzesi_ar AS beszerzesiAr, szallito, megjegyzes, created_at AS createdAt
     FROM bevetelezesek WHERE company_key = ? ORDER BY id DESC LIMIT ?`
  ).all(session.companyKey, limit);
  sendJson(res, 200, { items: rows });
});

route('POST', '/api/stock/receipt', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const body = await readJsonBody(req);
  const cikkNev = String(body.cikkNev || '').trim();
  const mennyiseg = parseFloat(body.mennyiseg);
  if (!cikkNev) return sendJson(res, 400, { error: 'A cikk neve kötelező.' });
  if (!Number.isFinite(mennyiseg) || mennyiseg <= 0) return sendJson(res, 400, { error: 'A mennyiségnek pozitív számnak kell lennie.' });
  const datum = /^\d{4}-\d{2}-\d{2}$/.test(body.datum || '') ? body.datum : todayIsoServer();
  const me = String(body.me || '').trim() || null;
  const beszerzesiAr = body.beszerzesiAr !== undefined && body.beszerzesiAr !== '' ? parseFloat(body.beszerzesiAr) : null;
  const szallito = String(body.szallito || '').trim() || null;
  const megjegyzes = String(body.megjegyzes || '').trim() || null;

  const result = stockDb.prepare(
    `INSERT INTO bevetelezesek (company_key, datum, cikk_nev, me, mennyiseg, beszerzesi_ar, szallito, megjegyzes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(session.companyKey, datum, cikkNev, me, mennyiseg, beszerzesiAr, szallito, megjegyzes, new Date().toISOString());

  logActivity({ type: 'stock_receipt_add', ok: true, companyKey: session.companyKey, nev: session.nev, detail: `${cikkNev}: ${mennyiseg} ${me || ''}`.trim() });
  sendJson(res, 200, { ok: true, id: Number(result.lastInsertRowid) });
});

route('DELETE', '/api/stock/receipt', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const id = parseInt(query.id, 10);
  if (!id) return sendJson(res, 400, { error: 'Hiányzó id.' });
  const existing = stockDb.prepare(`SELECT cikk_nev, mennyiseg FROM bevetelezesek WHERE id = ? AND company_key = ?`).get(id, session.companyKey);
  const result = stockDb.prepare(`DELETE FROM bevetelezesek WHERE id = ? AND company_key = ?`).run(id, session.companyKey);
  if (result.changes === 0) return sendJson(res, 404, { error: 'Nem található (vagy nem a te cégedhez tartozik).' });
  logActivity({ type: 'stock_receipt_delete', ok: true, companyKey: session.companyKey, nev: session.nev, detail: existing ? `${existing.cikk_nev}: ${existing.mennyiseg}` : `#${id}` });
  sendJson(res, 200, { ok: true });
});

// Riasztási küszöb beállítása/törlése cikkre vagy egész csoportra.
route('POST', '/api/stock/threshold', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const body = await readJsonBody(req);
  const scope = body.scope === 'csoport' ? 'csoport' : 'cikk';
  const nev = String(body.nev || '').trim();
  if (!nev) return sendJson(res, 400, { error: 'Hiányzó név.' });
  const kuszob = parseFloat(body.kuszob);
  if (!Number.isFinite(kuszob) || kuszob < 0) return sendJson(res, 400, { error: 'A küszöbnek nemnegatív számnak kell lennie.' });
  stockDb.prepare(
    `INSERT INTO keszlet_riasztas (company_key, scope, nev, kuszob) VALUES (?, ?, ?, ?)
     ON CONFLICT(company_key, scope, nev) DO UPDATE SET kuszob = excluded.kuszob`
  ).run(session.companyKey, scope, nev, kuszob);
  logActivity({ type: 'stock_threshold_set', ok: true, companyKey: session.companyKey, nev: session.nev, detail: `${scope === 'csoport' ? 'Csoport' : 'Cikk'}: ${nev} → ${kuszob}` });
  sendJson(res, 200, { ok: true });
});

route('DELETE', '/api/stock/threshold', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const scope = query.scope === 'csoport' ? 'csoport' : 'cikk';
  const nev = String(query.nev || '').trim();
  if (!nev) return sendJson(res, 400, { error: 'Hiányzó név.' });
  stockDb.prepare(`DELETE FROM keszlet_riasztas WHERE company_key = ? AND scope = ? AND nev = ?`).run(session.companyKey, scope, nev);
  logActivity({ type: 'stock_threshold_delete', ok: true, companyKey: session.companyKey, nev: session.nev, detail: `${scope === 'csoport' ? 'Csoport' : 'Cikk'}: ${nev}` });
  sendJson(res, 200, { ok: true });
});

// NTAK (turisztikai adatszolgáltatás) állapot: adatküldések eredménye +
// napi nyitás-zárás log. Azoknál a cégeknél, akiknek nincs NTAK-kötelezettsége
// (pl. a demó teszt cégek), ezek a táblák egyszerűen üresek — a végpont ilyenkor
// is 200-at ad, üres listákkal, a felület pedig "nincs adat" állapotot mutat.
route('GET', '/api/ntak/summary', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const k = session.companyKey;
  const { from, to } = resolveRange(query);

  const napzarasok = all(k,
    `SELECT targynap, nyitas, zaras, borravalo, naptipus, uuid
     FROM ntaknapzaras WHERE targynap BETWEEN ? AND ? ORDER BY targynap DESC`,
    [from, to]
  );
  const submissionsByStatus = all(k,
    `SELECT IFNULL(ellenorzott,'ISMERETLEN') AS ellenorzott, COUNT(*) AS cnt
     FROM ntakrms WHERE date(kulddate) BETWEEN ? AND ? GROUP BY ellenorzott ORDER BY cnt DESC`,
    [from, to]
  );
  const submissionsByType = all(k,
    `SELECT url, COUNT(*) AS cnt
     FROM ntakrms WHERE date(kulddate) BETWEEN ? AND ? GROUP BY url ORDER BY cnt DESC`,
    [from, to]
  );
  const recent = all(k,
    `SELECT url, sikeres, uuid, kulddate, elldate, ellenorzott
     FROM ntakrms WHERE date(kulddate) BETWEEN ? AND ? ORDER BY kulddate DESC LIMIT 100`,
    [from, to]
  );
  sendJson(res, 200, { from, to, napzarasok, submissionsByStatus, submissionsByType, recent });
});

route('GET', '/api/receipt', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const k = session.companyKey;
  const bsz = query.bsz;
  if (!bsz) return sendJson(res, 400, { error: 'bsz paraméter kötelező' });
  const header = get(k,
    `SELECT bsz, keltdat, fizmod, bruttokp, bruttoafr, bruttokartya, sznev, szadoszam, storno, stornozott
     FROM nyfej WHERE bsz = ?`, [bsz]
  );
  if (!header) return sendJson(res, 404, { error: 'Nyugta nem található' });
  const items = all(k,
    `SELECT sor, cikkszam, megnevezes, me, menny, bruttoar, afakod, sorbrutto
     FROM nytet WHERE bsz = ? ORDER BY sor`, [bsz]
  );
  sendJson(res, 200, { header, items });
});

route('GET', '/api/sync/status', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const meta = readSyncMeta();
  sendJson(res, 200, meta[session.companyKey] || { lastSync: null, source: null });
});

// Ide küldi az androidos app időzítve a friss adatbázis-fájlt — CÉGENKÉNT.
// Hitelesítés: x-api-key fejléc, NEM a böngészős session-nel.
// Melyik céghez tartozik? Az x-adoszam fejléc (vagy ?adoszam= paraméter) adja meg.
// Ha ez egy eddig ismeretlen adószám, a cég automatikusan regisztrálódik —
// így akár több száz eszköz is szinkronizálhat folyamatosan, előzetes
// admin-beavatkozás nélkül, amíg mindegyik ismeri a közös x-api-key-t.
// Kérés törzse: a teljes .db fájl nyers bájtjai (application/octet-stream).
route('POST', '/api/sync/upload', async (req, res, query) => {
  const ip = (req.socket && req.socket.remoteAddress) || null;
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== SECRETS.syncApiKey) {
    logActivity({ type: 'sync_upload', ok: false, companyKey: null, nev: null, detail: 'Érvénytelen vagy hiányzó x-api-key.', ip });
    return sendJson(res, 401, { error: 'Érvénytelen vagy hiányzó x-api-key.' });
  }

  const adoszamRaw = req.headers['x-adoszam'] || query.adoszam;
  const key = companyKeyFromAdoszam(adoszamRaw);
  if (key.length < 8) {
    logActivity({ type: 'sync_upload', ok: false, companyKey: null, nev: null, detail: 'Hiányzó vagy érvénytelen x-adoszam.', ip });
    return sendJson(res, 400, { error: 'Hiányzó vagy érvénytelen x-adoszam fejléc / adoszam paraméter — melyik céghez tartozik a feltöltés?' });
  }

  let buf;
  try { buf = await readBody(req, 100 * 1024 * 1024); }
  catch (_) {
    logActivity({ type: 'sync_upload', ok: false, companyKey: key, nev: companyIndex.get(key)?.nev || null, detail: 'A feltöltött fájl túl nagy.', ip });
    return sendJson(res, 413, { error: 'A feltöltött fájl túl nagy.' });
  }
  if (buf.length < 100 || buf.slice(0, 16).toString('utf8').indexOf('SQLite format 3') !== 0) {
    logActivity({ type: 'sync_upload', ok: false, companyKey: key, nev: companyIndex.get(key)?.nev || null, detail: 'A törzs nem érvényes SQLite fájl.', ip });
    return sendJson(res, 400, { error: 'A törzsnek egy érvényes SQLite (.db) fájlnak kell lennie.' });
  }

  const dbFile = dbFileForKey(key);
  const tmpPath = dbFile + '.uploading';
  try {
    fs.writeFileSync(tmpPath, buf);
    evictConnection(key); // zárjuk a gyorsítótárban lévő, régi fájlra mutató kapcsolatot, mielőtt felülírjuk
    fs.renameSync(tmpPath, dbFile);
  } catch (e) {
    logActivity({ type: 'sync_upload', ok: false, companyKey: key, nev: companyIndex.get(key)?.nev || null, detail: `Fájlírási hiba: ${e.message}`, ip });
    return sendJson(res, 500, { error: 'Nem sikerült elmenteni a feltöltött fájlt a szerveren.' });
  }

  let identity = null;
  try { identity = readCompanyIdentity(dbFile); } catch (e) { console.error(`[hiba] identitás-olvasás sikertelen (${key}):`, e.message); }
  const isNew = !companyIndex.has(key);
  if (identity) companyIndex.set(key, { ...identity, dbFile });
  if (isNew) ensureAccessCodes(); // új cégnek azonnal legyen belépési kódja

  if (!identity) {
    logActivity({ type: 'sync_upload', ok: false, companyKey: key, nev: null, detail: 'A fájl elmentve, de nem sikerült beolvasni belőle a cégadatokat (hiányzó szallitot sor?).', ip });
    return sendJson(res, 400, { error: 'A fájl elmentve, de nem sikerült beolvasni belőle a cégadatokat.' });
  }

  const meta = readSyncMeta();
  meta[key] = { lastSync: new Date().toISOString(), source: 'android-sync', bytes: buf.length, nev: identity.nev };
  writeSyncMeta(meta);

  logActivity({ type: 'sync_upload', ok: true, companyKey: key, nev: identity.nev, detail: `${Math.round(buf.length / 1024)} KB${isNew ? ' — új cég regisztrálva' : ''}`, ip });
  console.log(`[sync] ${key} (${identity.nev}) frissítve — ${buf.length} bájt${isNew ? ' — ÚJ CÉG regisztrálva' : ''}`);
  sendJson(res, 200, { ok: true, companyKey: key, newCompany: isNew, ...meta[key] });
});

// Demó/manuális "Frissítés most" gomb a felületen — bejelentkezett munkamenettel
// hívható, a saját cégre vonatkozóan. Amíg nincs valós eszközkapcsolat beállítva
// (lásd README), csak visszajelzi az aktuális állapotot ahelyett, hogy adatot hamisítana.
route('POST', '/api/sync/request', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const meta = readSyncMeta();
  sendJson(res, 200, {
    ok: true,
    triggered: false,
    message: 'Élő eszközkapcsolat még nincs beállítva ezen a szerveren — az androidos appnak kell HTTP POST-tal elküldenie az adatbázist a /api/sync/upload végpontra, a saját adószámával (lásd README.md). Addig ez a pillanatkép aktív.',
    meta: meta[session.companyKey] || { lastSync: null, source: null },
  });
});

// Adminisztratív áttekintés: milyen cégek vannak regisztrálva. Ugyanazzal az
// x-api-key-jel hitelesít, mint a szinkron feltöltés (nem böngésző-session).
// ---------------------------------------------------------------------------
// IDEIGLENES, TESZT CÉLÚ végpont: a bejelentkező oldal ebből olvassa ki,
// milyen érvényes adószámokkal/kódokkal lehet éppen belépni. NEM védett —
// bárki lekérdezheti, mert a bejelentkező oldal (session nélkül) hívja meg.
// ⚠️ FONTOS: ez a végpont a hozzáférési KÓDOKAT IS kiadja nyíltan — ez pont
// azt a védelmet üresíti ki, amit a kód bevezetése adott. Éles/nyilvános
// üzemeltetés előtt FELTÉTLENÜL távolítsd el EZT és a hozzá tartozó
// login-screen kártyát (public/index.html + app.js), különben bárki, aki
// megnyitja az oldalt, bejelentkezés nélkül megkapja az összes cég kódját.
// ---------------------------------------------------------------------------
route('GET', '/api/auth/companies-hint', async (req, res) => {
  const codes = ensureAccessCodes();
  const list = [...companyIndex.entries()]
    .map(([key, entry]) => ({ nev: entry.nev, adoszam: entry.adoszam, code: codes[key]?.code }))
    .sort((a, b) => a.nev.localeCompare(b.nev, 'hu'));
  sendJson(res, 200, { companies: list });
});

route('GET', '/api/sync/companies', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== SECRETS.syncApiKey) return sendJson(res, 401, { error: 'Érvénytelen vagy hiányzó x-api-key.' });
  const meta = readSyncMeta();
  const list = [...companyIndex.entries()].map(([key, entry]) => ({
    key, nev: entry.nev, adoszam: entry.adoszam, varos: entry.varos,
    ...(meta[key] || { lastSync: null, source: null }),
  }));
  sendJson(res, 200, { count: list.length, companies: list });
});

// ---------------------------------------------------------------------------
// ADMIN — külön bejelentkezés (nem cégenkénti adószámos belépés), amivel
// az összes cég szinkron-naplója, NTAK állapota belátható, és bármelyik
// cég dashboardja megnyitható. Az admin jelszó a data/.secrets.json-ban
// (vagy ADMIN_PASSWORD env változóban) van.
// ---------------------------------------------------------------------------

route('POST', '/api/admin/login', async (req, res) => {
  const ip = (req.socket && req.socket.remoteAddress) || null;
  const { password } = await readJsonBody(req);
  if (!password || password !== SECRETS.adminPassword) {
    logActivity({ type: 'admin_login', ok: false, companyKey: null, nev: null, detail: 'Hibás admin jelszó.', ip });
    return sendJson(res, 401, { error: 'Hibás admin jelszó.' });
  }
  const payload = { isAdmin: true, exp: Date.now() + SESSION_MAX_AGE_MS };
  const token = signSession(payload);
  const cookie = `enyadmin=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax`;
  logActivity({ type: 'admin_login', ok: true, companyKey: null, nev: null, detail: 'Sikeres admin bejelentkezés.', ip });
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie });
});

route('POST', '/api/admin/logout', async (req, res) => {
  const admin = requireAdmin(req);
  if (admin) logActivity({ type: 'admin_logout', ok: true, companyKey: null, nev: null, detail: 'Admin kijelentkezett.' });
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'enyadmin=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' });
});

function computeNtakOverview() {
  const rows = [];
  for (const [key, entry] of companyIndex.entries()) {
    let byStatus, lastProblem;
    try {
      byStatus = all(key, `SELECT IFNULL(ellenorzott,'ISMERETLEN') AS s, COUNT(*) AS c FROM ntakrms GROUP BY s`);
      lastProblem = get(key,
        `SELECT url, kulddate, ellenorzott FROM ntakrms WHERE ellenorzott IN ('TELJESEN_HIBAS','RESZBEN_SIKERES') ORDER BY kulddate DESC LIMIT 1`
      );
    } catch (_) { byStatus = []; lastProblem = null; }
    const total = byStatus.reduce((s, r) => s + r.c, 0);
    if (total === 0) continue; // nincs NTAK adata ennek a cégnek — kihagyjuk az áttekintésből
    const get1 = (s) => (byStatus.find((r) => r.s === s) || { c: 0 }).c;
    rows.push({
      key, nev: entry.nev, adoszam: entry.adoszam, total,
      ok: get1('TELJESEN_SIKERES'), warn: get1('RESZBEN_SIKERES'), error: get1('TELJESEN_HIBAS'), pending: get1('BEFOGADVA'),
      lastProblem: lastProblem || null,
    });
  }
  return rows.sort((a, b) => (b.error + b.warn) - (a.error + a.warn));
}

route('GET', '/api/admin/overview', async (req, res, query) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const meta = readSyncMeta();
  const codes = ensureAccessCodes();
  const companies = [...companyIndex.entries()]
    .map(([key, entry]) => {
      let fallbackEmail = '';
      if (!codes[key]?.email) {
        try { fallbackEmail = get(key, 'SELECT email FROM szallitot LIMIT 1')?.email || ''; } catch (_) {}
      }
      return {
        key, nev: entry.nev, adoszam: entry.adoszam, varos: entry.varos,
        code: codes[key]?.code, email: codes[key]?.email || fallbackEmail,
        ...(meta[key] || { lastSync: null, source: null, bytes: null }),
      };
    })
    .sort((a, b) => (b.lastSync || '').localeCompare(a.lastSync || ''));
  const ntak = computeNtakOverview();
  sendJson(res, 200, { companies, ntak, emailReady: !!(BREVO_API_KEY && BREVO_SENDER_EMAIL) });
});

// Tevékenység-napló — minden esemény cégenként és típusonként megkülönböztetve.
// Szűrhető companyKey és type szerint (mindkettő opcionális); emellett egy
// cégenkénti+típusonkénti összesítő mátrixot is visszaad a csoportosított
// megjelenítéshez.
route('GET', '/api/admin/activity', async (req, res, query) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const limit = Math.min(parseInt(query.limit || '1000', 10) || 1000, 5000);
  let entries = readActivityLog(limit);

  const types = [...new Set(entries.map((e) => e.type))].sort();
  const companyNames = new Map();
  for (const e of entries) if (e.companyKey && e.nev && !companyNames.has(e.companyKey)) companyNames.set(e.companyKey, e.nev);
  const companies = [...companyNames.entries()].map(([key, nev]) => ({ key, nev })).sort((a, b) => a.nev.localeCompare(b.nev, 'hu'));

  // cégenkénti + típusonkénti összesítő mátrix a csoportosított nézethez
  const matrix = new Map(); // companyKey -> { nev, counts: {type: n}, total, lastTs }
  for (const e of entries) {
    const mk = e.companyKey || '__admin__';
    if (!matrix.has(mk)) matrix.set(mk, { key: mk, nev: e.companyKey ? (e.nev || e.companyKey) : 'Admin (nem cég-specifikus)', counts: {}, total: 0, lastTs: e.ts });
    const row = matrix.get(mk);
    row.counts[e.type] = (row.counts[e.type] || 0) + 1;
    row.total += 1;
    if (e.ts > row.lastTs) row.lastTs = e.ts;
  }
  const summary = [...matrix.values()].sort((a, b) => b.total - a.total);

  if (query.company) entries = entries.filter((e) => (e.companyKey || '__admin__') === query.company);
  if (query.type) entries = entries.filter((e) => e.type === query.type);

  sendJson(res, 200, { entries, types, companies, summary });
});

// Admin újrageneráltatja egy cég hozzáférési kódját (pl. ha az kiszivárgott).
// A régi kód azonnal érvénytelenné válik.
route('POST', '/api/admin/regenerate-code', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { companyKey } = await readJsonBody(req);
  const entry = companyIndex.get(companyKey);
  if (!entry) return sendJson(res, 404, { error: 'Ismeretlen cég.' });
  const codes = readAccessCodes();
  codes[companyKey] = { ...(codes[companyKey] || {}), code: generateAccessCode() };
  writeAccessCodes(codes);
  logActivity({ type: 'admin_regen_code', ok: true, companyKey, nev: entry.nev, detail: 'Hozzáférési kód újragenerálva.' });
  sendJson(res, 200, { ok: true, companyKey, code: codes[companyKey].code });
});

// Admin kiküldi a cég hozzáférési kódját emailben, Brevón keresztül.
route('POST', '/api/admin/send-code', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { companyKey, email } = await readJsonBody(req);
  const entry = companyIndex.get(companyKey);
  if (!entry) return sendJson(res, 404, { error: 'Ismeretlen cég.' });
  const cleanEmail = String(email || '').trim();
  if (!cleanEmail || !cleanEmail.includes('@')) return sendJson(res, 400, { error: 'Érvénytelen email cím.' });

  const codes = ensureAccessCodes();
  const code = codes[companyKey]?.code;
  const nev = escapeHtmlServer(entry.nev);
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#1E3247;line-height:1.6;">
      <p>Kedves <strong>${nev}</strong>!</p>
      <p>Az L-NYUGTA nézegetőbe való belépéshez az alábbi adatokat használd:</p>
      <table style="margin:16px 0;border-collapse:collapse;">
        <tr><td style="padding:4px 12px 4px 0;color:#6C8299;">Adószám</td><td style="padding:4px 0;font-weight:600;">${escapeHtmlServer(entry.adoszam)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#6C8299;">Hozzáférési kód</td><td style="padding:4px 0;font-weight:700;font-size:20px;letter-spacing:3px;">${escapeHtmlServer(code)}</td></tr>
      </table>
      <p style="color:#6C8299;font-size:12.5px;">Ha nem te kérted ezt az emailt, kérjük hagyd figyelmen kívül.</p>
    </div>`;

  try {
    await sendBrevoEmail({ toEmail: cleanEmail, toName: entry.nev, subject: 'L-NYUGTA — hozzáférési kódod', html });
  } catch (e) {
    logActivity({ type: 'admin_send_code', ok: false, companyKey, nev: entry.nev, detail: `Sikertelen küldés (${cleanEmail}): ${e.message}` });
    return sendJson(res, 502, { error: `Nem sikerült elküldeni: ${e.message}` });
  }
  logActivity({ type: 'admin_send_code', ok: true, companyKey, nev: entry.nev, detail: `Kód kiküldve ide: ${cleanEmail}` });

  // elmentjük az email címet, hogy legközelebb ne kelljen újra beírni
  codes[companyKey] = { ...(codes[companyKey] || {}), email: cleanEmail };
  writeAccessCodes(codes);
  console.log(`[email] kód elküldve: ${entry.nev} (${companyKey}) -> ${cleanEmail}`);
  sendJson(res, 200, { ok: true });
});

// Admin "belép" egy adott cég nevében — utána a normál, cégenkénti
// dashboard API-kat használja a böngésző, mintha az illető cég jelentkezett
// volna be az adószámával. Így nem kell duplikálni egyik nézetet sem.
route('POST', '/api/admin/impersonate', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { companyKey } = await readJsonBody(req);
  const entry = companyIndex.get(companyKey);
  if (!entry) return sendJson(res, 404, { error: 'Ismeretlen cég.' });
  const payload = { companyKey, cegid: entry.cegid, nev: entry.nev, adoszam: entry.adoszam, exp: Date.now() + SESSION_MAX_AGE_MS };
  const token = signSession(payload);
  const cookie = `enysession=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax`;
  logActivity({ type: 'admin_impersonate', ok: true, companyKey, nev: entry.nev, detail: 'Admin megnyitotta a cég nézetét.' });
  sendJson(res, 200, { ok: true, company: { nev: entry.nev, adoszam: entry.adoszam, varos: entry.varos, cim: entry.cim } }, { 'Set-Cookie': cookie });
});

// ---------------------------------------------------------------------------
// Statikus fájlok kiszolgálása (public/)
// ---------------------------------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Nem található'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// HTTP szerver + útvonalválasztás
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const query = Object.fromEntries(u.searchParams.entries());

    if (u.pathname.startsWith('/api/')) {
      const found = routes.find((r) => r.method === req.method && r.pattern === u.pathname);
      if (!found) return sendJson(res, 404, { error: 'Ismeretlen végpont' });
      return await found.handler(req, res, query);
    }
    if (req.method === 'GET') return serveStatic(req, res, u.pathname);
    res.writeHead(405); res.end('Method Not Allowed');
  } catch (err) {
    if (err && err.code === 'COMPANY_NOT_FOUND') return sendJson(res, 404, { error: 'A cég adatbázisa nem található.' });
    console.error(err);
    sendJson(res, 500, { error: 'Szerverhiba', detail: String(err && err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`L-NYUGTA nézegető fut: http://localhost:${PORT}`);
});

// Rendezett leállás: minden nyitott céges adatbázis-kapcsolatot bezárunk.
function shutdown() {
  for (const key of [...dbCache.keys()]) evictConnection(key);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
