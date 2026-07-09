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
  const next = { sessionSecret, syncApiKey };
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

// Dátum-tartomány normalizálása: alapértelmezés az utolsó 30 nap
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
  const { adoszam } = await readJsonBody(req);
  const wanted = normalizeAdoszam(adoszam);
  if (wanted.length < 8) return sendJson(res, 400, { error: 'Adj meg legalább 8 számjegyet az adószámból.' });
  const key = wanted.slice(0, 8);
  const entry = companyIndex.get(key);
  if (!entry) return sendJson(res, 401, { error: 'Ismeretlen adószám. Ellenőrizd, és próbáld újra.' });
  const payload = { companyKey: key, cegid: entry.cegid, nev: entry.nev, adoszam: entry.adoszam, exp: Date.now() + SESSION_MAX_AGE_MS };
  const token = signSession(payload);
  const cookie = `enysession=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax`;
  sendJson(res, 200, { ok: true, company: { nev: entry.nev, adoszam: entry.adoszam, varos: entry.varos, cim: entry.cim } }, { 'Set-Cookie': cookie });
});

route('POST', '/api/auth/logout', async (req, res) => {
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
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== SECRETS.syncApiKey) return sendJson(res, 401, { error: 'Érvénytelen vagy hiányzó x-api-key.' });

  const adoszamRaw = req.headers['x-adoszam'] || query.adoszam;
  const key = companyKeyFromAdoszam(adoszamRaw);
  if (key.length < 8) return sendJson(res, 400, { error: 'Hiányzó vagy érvénytelen x-adoszam fejléc / adoszam paraméter — melyik céghez tartozik a feltöltés?' });

  let buf;
  try { buf = await readBody(req, 100 * 1024 * 1024); }
  catch (_) { return sendJson(res, 413, { error: 'A feltöltött fájl túl nagy.' }); }
  if (buf.length < 100 || buf.slice(0, 16).toString('utf8').indexOf('SQLite format 3') !== 0) {
    return sendJson(res, 400, { error: 'A törzsnek egy érvényes SQLite (.db) fájlnak kell lennie.' });
  }

  const dbFile = dbFileForKey(key);
  const tmpPath = dbFile + '.uploading';
  fs.writeFileSync(tmpPath, buf);
  evictConnection(key); // zárjuk a gyorsítótárban lévő, régi fájlra mutató kapcsolatot, mielőtt felülírjuk
  fs.renameSync(tmpPath, dbFile);

  let identity = null;
  try { identity = readCompanyIdentity(dbFile); } catch (e) { console.error(`[hiba] identitás-olvasás sikertelen (${key}):`, e.message); }
  const isNew = !companyIndex.has(key);
  if (identity) companyIndex.set(key, { ...identity, dbFile });

  const meta = readSyncMeta();
  meta[key] = { lastSync: new Date().toISOString(), source: 'android-sync', bytes: buf.length, nev: identity ? identity.nev : (meta[key] && meta[key].nev) };
  writeSyncMeta(meta);

  console.log(`[sync] ${key} (${identity ? identity.nev : '?'}) frissítve — ${buf.length} bájt${isNew ? ' — ÚJ CÉG regisztrálva' : ''}`);
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
// milyen érvényes adószámokkal lehet éppen belépni. NEM védett — bárki
// lekérdezheti, mert a bejelentkező oldal (session nélkül) hívja meg.
// Éles/nyilvános üzemeltetés előtt EZT ÉS a hozzá tartozó login-screen
// kártyát (public/index.html + app.js) érdemes eltávolítani, mert az összes
// regisztrált cég nevét/adószámát kiadja bárkinek, aki csak megnyitja az oldalt.
// ---------------------------------------------------------------------------
route('GET', '/api/auth/companies-hint', async (req, res) => {
  const list = [...companyIndex.values()]
    .map((entry) => ({ nev: entry.nev, adoszam: entry.adoszam }))
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
