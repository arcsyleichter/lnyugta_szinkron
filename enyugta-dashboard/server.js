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
// A cég "kulcsa" mindenhol az adószám első 8 számjegye.
function companyKeyFromAdoszam(adoszam) {
  return normalizeAdoszam(adoszam).slice(0, 8);
}
// A telephely-kód szabad, rövid azonosító (pl. "01", "BUDA") — csak
// alfanumerikus, hogy biztonságosan része lehessen fájlnévnek/kulcsnak.
function normalizeTelephelyKod(s) {
  const norm = String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 12);
  return norm || '01';
}
// ÖSSZETETT KULCS: "cégkulcs:telephelykód" (pl. "18774455:01") — ez az,
// amit a rendszer mindenhol egyetlen átlátszó "key" stringként kezel
// (session.companyKey, stock.db/product-changes.db company_key oszlopa
// stb.) — így a meglévő kód nagy része VÁLTOZATLANUL működik, csak most
// már telephely-szinten különül el, nem csak cég-szinten.
function makeSiteKey(cegKulcs, telephelyKod) {
  return `${cegKulcs}:${normalizeTelephelyKod(telephelyKod)}`;
}
function splitSiteKey(siteKey) {
  const idx = siteKey.indexOf(':');
  if (idx === -1) return { cegKulcs: siteKey, telephelyKod: null };
  return { cegKulcs: siteKey.slice(0, idx), telephelyKod: siteKey.slice(idx + 1) };
}
function dbFileForKey(siteKey) {
  const { cegKulcs, telephelyKod } = splitSiteKey(siteKey);
  return path.join(COMPANIES_DIR, cegKulcs, `${telephelyKod}.db`);
}

// ---------------------------------------------------------------------------
// Telephelyek nyilvántartása — cégenként, adminisztratív módon kezelve
// (nem csak a ténylegesen szinkronizált .db fájlokból derül ki, hanem egy
// telephely már a szinkron ELŐTT is felvehető a karbantartóban).
// data/telephelyek.json: { "<cégkulcs>": [ { kod, nev, cim, letrehozva } ] }
// ---------------------------------------------------------------------------
const TELEPHELYEK_PATH = path.join(DATA_DIR, 'telephelyek.json');

function readTelephelyek() {
  try { return JSON.parse(fs.readFileSync(TELEPHELYEK_PATH, 'utf8')); }
  catch (_) { return {}; }
}
function writeTelephelyek(data) {
  fs.writeFileSync(TELEPHELYEK_PATH, JSON.stringify(data, null, 2));
}
function listTelephelyek(cegKulcs) {
  return readTelephelyek()[cegKulcs] || [];
}
function ensureTelephely(cegKulcs, kod, nev) {
  const data = readTelephelyek();
  if (!data[cegKulcs]) data[cegKulcs] = [];
  kod = normalizeTelephelyKod(kod);
  if (!data[cegKulcs].some((t) => t.kod === kod)) {
    // A "01" mindig az alapértelmezett/első telephely — akkor is "Fő
    // telephely" legyen a neve, ha a telephelyek.json valamiért elveszett
    // és újra kell generálni (pl. tárhely-visszaállítás után), ne csak az
    // első, ténylegesen migrált alkalommal.
    const fallbackNev = kod === '01' ? 'Fő telephely' : `Telephely ${kod}`;
    data[cegKulcs].push({ kod, nev: nev || fallbackNev, cim: '', letrehozva: new Date().toISOString() });
    writeTelephelyek(data);
    return true; // új volt
  }
  return false; // már létezett
}

// ---------------------------------------------------------------------------
// Cégindex — memóriában tartott lista arról, milyen TELEPHELYEK (.db fájlok)
// érhetők el, és mi az adataik (cégnév, adószám, város, cím). A tényleges
// forgalmi adatokat NEM tartalmazza — azokat lekérdezéskor olvassuk ki
// a megfelelő adatbázisból.
// ---------------------------------------------------------------------------

const companyIndex = new Map(); // siteKey ("cégkulcs:telephelykód") -> { cegid, nev, adoszam, varos, cim, dbFile, cegKulcs, telephelyKod }

function readCompanyIdentity(dbFile) {
  const tmp = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return tmp.prepare('SELECT cegid, nev, adoszam, varos, cim FROM szallitot LIMIT 1').get() || null;
  } finally {
    tmp.close();
  }
}

// Egyszeri migráció: a korábbi, lapos "data/companies/<cégkulcs>.db"
// elrendezést átalakítja "data/companies/<cégkulcs>/01.db"-re, és
// regisztrálja az "01" ("Fő telephely") telephelyet — hogy a régebbi,
// egytelephelyes cégek adatai ne vesszenek el ennél a szerkezetváltásnál.
function migrateFlatCompanyFiles() {
  const entries = fs.readdirSync(COMPANIES_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.db')) {
      const cegKulcs = entry.name.replace(/\.db$/, '');
      const oldPath = path.join(COMPANIES_DIR, entry.name);
      const newDir = path.join(COMPANIES_DIR, cegKulcs);
      const newPath = path.join(newDir, '01.db');
      fs.mkdirSync(newDir, { recursive: true });
      if (!fs.existsSync(newPath)) {
        fs.renameSync(oldPath, newPath);
        console.log(`[migráció] ${entry.name} -> ${cegKulcs}/01.db (Fő telephely)`);
      }
      ensureTelephely(cegKulcs, '01', 'Fő telephely');
    }
  }
}

function scanCompanies() {
  migrateFlatCompanyFiles();
  companyIndex.clear();
  const cegDirs = fs.readdirSync(COMPANIES_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const cegDir of cegDirs) {
    const cegKulcs = cegDir.name;
    const cegPath = path.join(COMPANIES_DIR, cegKulcs);
    const files = fs.readdirSync(cegPath).filter((f) => f.endsWith('.db'));
    for (const f of files) {
      const telephelyKod = f.replace(/\.db$/, '');
      const dbFile = path.join(cegPath, f);
      const siteKey = makeSiteKey(cegKulcs, telephelyKod);
      try {
        const identity = readCompanyIdentity(dbFile);
        if (identity) {
          companyIndex.set(siteKey, { ...identity, dbFile, cegKulcs, telephelyKod });
          ensureTelephely(cegKulcs, telephelyKod, null); // ha admin még nem nevezte el, kapjon alap nevet
        } else {
          console.warn(`[warn] ${cegKulcs}/${f}: nincs szallitot sor, kihagyva.`);
        }
      } catch (e) {
        console.error(`[warn] nem sikerült beolvasni: ${cegKulcs}/${f} — ${e.message}`);
      }
    }
  }
  console.log(`[info] ${companyIndex.size} telephely betöltve a data/companies/ mappából.`);
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
// Cikktörzs kétirányú szinkron — a webes felület (egyenként, tömegesen vagy
// CSV/Excel importtal) tud terméktörzs-módosítást kezdeményezni, de ezt NEM
// írja bele közvetlenül a cég szinkronizált .db fájljába — azt úgyis
// felülírná a következő androidos szinkron feltöltés. Helyette egy külön
// "függő módosítás" sorba kerül (data/product-changes.db), amit az androidos
// alkalmazásnak kell lekérdeznie (GET /api/sync/pending-changes) és
// alkalmaznia — lásd README. A módosítás automatikusan "leszinkronizálva"
// állapotba kerül, amint a következő valódi szinkron feltöltésben megjelenik
// a kívánt érték (lásd reconcileProductChanges, hívva /api/sync/upload-ból).
// ---------------------------------------------------------------------------
const PRODUCT_CHANGES_DB_PATH = path.join(DATA_DIR, 'product-changes.db');
const productChangesDb = new DatabaseSync(PRODUCT_CHANGES_DB_PATH, { readOnly: false });
productChangesDb.exec(`
  CREATE TABLE IF NOT EXISTS product_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_key TEXT NOT NULL,
    change_type TEXT NOT NULL CHECK(change_type IN ('cikk_upsert','csoport_upsert')),
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered')),
    source TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_product_changes_company ON product_changes(company_key, status);
`);
// Könnyű migráció: a "meta" oszlop (csak weben megjelenített, kiegészítő
// adat — pl. tervezett termékcsoport neve — ami TILOS, hogy bekerüljön az
// androidnak küldött "payload" mezőbe, mert az androidos alkalmazás
// szigorúan, mezőnév=oszlopnév alapon generikusan illeszti a payload MINDEN
// kulcsát a cikkt táblára, és bármilyen ismeretlen mezőnév esetén elutasítja
// az egész szinkront) — ha egy régebbi telepítésben még nincs meg, pótoljuk.
{
  const cols = productChangesDb.prepare(`PRAGMA table_info(product_changes)`).all();
  if (!cols.some((c) => c.name === 'meta')) {
    productChangesDb.exec(`ALTER TABLE product_changes ADD COLUMN meta TEXT`);
  }
}

function addProductChange(companyKey, changeType, payload, source, meta) {
  // Ha ugyanerre a cikkre/csoportra már van egy még FÜGGŐBEN lévő korábbi
  // módosítás, azt előbb töröljük — különben soha nem tudna teljesülni
  // (hiszen a cikk ára/adatai a most beérkező, újabb szándék szerint fognak
  // majd módosulni, nem a réginek megfelelően), és örökre "függőben" ragadna.
  // A már LESZINKRONIZÁLT (történeti) bejegyzéseket ez nem érinti.
  const target = payload.megnevezes;
  productChangesDb.prepare(
    `DELETE FROM product_changes WHERE company_key = ? AND change_type = ? AND status = 'pending'
     AND json_extract(payload, '$.megnevezes') = ?`
  ).run(companyKey, changeType, target);
  productChangesDb.prepare(
    `INSERT INTO product_changes (company_key, change_type, payload, status, source, created_at, meta)
     VALUES (?, ?, ?, 'pending', ?, ?, ?)`
  ).run(companyKey, changeType, JSON.stringify(payload), source, new Date().toISOString(), meta ? JSON.stringify(meta) : null);
}

// Minden valódi androidos szinkron feltöltés után lefut: megnézi, hogy a
// frissen beérkezett cikktörzsben már megjelent-e a kért érték — ha igen,
// a függő módosítást "leszinkronizálva" állapotba teszi. Így nincs szükség
// külön visszaigazoló hívásra az androidos oldalról.
function reconcileProductChanges(companyKey) {
  let pending;
  try {
    pending = productChangesDb.prepare(
      `SELECT id, change_type, payload FROM product_changes WHERE company_key = ? AND status = 'pending'`
    ).all(companyKey);
  } catch (_) { return; }
  if (!pending.length) return;
  for (const row of pending) {
    let payload;
    try { payload = JSON.parse(row.payload); } catch (_) { continue; }
    let matches = false;
    try {
      if (row.change_type === 'cikk_upsert') {
        const current = get(companyKey, `SELECT bruttoar, afakod, afakodelv FROM cikkt WHERE megnevezes = ?`, [payload.megnevezes]);
        matches = !!current
          && Number(current.bruttoar) === Number(payload.bruttoar)
          && String(current.afakod) === String(payload.afakod)
          && (!payload.afakodelv || String(current.afakodelv) === String(payload.afakodelv));
      } else if (row.change_type === 'csoport_upsert') {
        matches = !!get(companyKey, `SELECT azon FROM cikkcsop WHERE megnevezes = ?`, [payload.megnevezes]);
      }
    } catch (_) { matches = false; }
    if (matches) {
      productChangesDb.prepare(`UPDATE product_changes SET status='delivered', delivered_at=? WHERE id=?`).run(new Date().toISOString(), row.id);
    }
  }
}

// --- Apró CSV segédfüggvények (Excel natívan megnyitja/menti) ---
function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows, headers) {
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n'; // UTF-8 BOM, hogy Excelben jók legyenek az ékezetek
}
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f !== ''));
}

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
  const cegKulcsok = new Set([...companyIndex.values()].map((e) => e.cegKulcs));
  for (const cegKulcs of cegKulcsok) {
    if (!codes[cegKulcs]) { codes[cegKulcs] = { code: generateAccessCode(), email: '' }; changed = true; }
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

// Cég-szintű ellenőrzés — elfogadja MIND a telephely-választás előtti
// (companyKey == cégkulcs), MIND a már teljes (companyKey == "cégkulcs:kód")
// munkameneteket. Ezt használja a telephely-lista lekérdezése, a
// telephely-választás és a telephely-karbantartó.
function requireCegAuth(req) {
  const cookies = parseCookies(req.headers.cookie);
  const session = verifySession(cookies.enysession);
  if (!session || !session.cegKulcs) return null;
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
// A Magyarországon jelenleg érvényes ÁFA kulcsok (Áfa tv. 82. §) — 27%
// általános, 18% és 5% kedvezményes. A "05%" (vezető nullás) formátum
// szándékos: pontosan ez a jelölés van már használatban a valódi,
// androidról szinkronizált adatokban (cikkt.afakod), ehhez igazodunk.
const VALID_AFA_CODES = ['27%', '18%', '05%'];
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
  const cegKulcs = wanted.slice(0, 8);

  const telephelyek = listTelephelyek(cegKulcs);
  if (!telephelyek.length) {
    logActivity({ type: 'company_login', ok: false, companyKey: cegKulcs, nev: null, detail: 'Ismeretlen adószám.', ip });
    return sendJson(res, 401, { error: 'Ismeretlen adószám. Ellenőrizd, és próbáld újra.' });
  }

  const codes = readAccessCodes();
  const expected = codes[cegKulcs]?.code;
  const anySite = [...companyIndex.values()].find((e) => e.cegKulcs === cegKulcs);
  const displayNev = anySite ? anySite.nev : 'Új cég (még nincs szinkronizált adat)';

  if (!expected || !code || String(code).trim() !== expected) {
    logActivity({ type: 'company_login', ok: false, companyKey: cegKulcs, nev: displayNev, detail: 'Hibás hozzáférési kód.', ip });
    return sendJson(res, 401, { error: 'Hibás hozzáférési kód. Kérd el a céged adminisztrátorától.' });
  }

  logActivity({ type: 'company_login', ok: true, companyKey: cegKulcs, nev: displayNev, detail: 'Sikeres bejelentkezés.', ip });

  if (telephelyek.length === 1) {
    // Csak egy telephely van — nincs szükség választásra, azonnal teljes munkamenetet kap.
    const t = telephelyek[0];
    const siteKey = makeSiteKey(cegKulcs, t.kod);
    const site = companyIndex.get(siteKey);
    const payload = {
      companyKey: siteKey, cegKulcs, telephelyKod: t.kod,
      nev: site ? site.nev : displayNev, adoszam: site ? site.adoszam : wanted,
      exp: Date.now() + SESSION_MAX_AGE_MS,
    };
    const token = signSession(payload);
    const cookie = `enysession=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax`;
    return sendJson(res, 200, {
      ok: true, telephelyValasztva: true,
      company: { nev: payload.nev, adoszam: payload.adoszam, varos: site?.varos, cim: site?.cim, telephelyNev: t.nev },
    }, { 'Set-Cookie': cookie });
  }

  // Több telephely — cég-szintű (telephely nélküli) munkamenet; a webes
  // felületnek a telephely-választó képernyőt kell megjelenítenie.
  const payload = { companyKey: cegKulcs, cegKulcs, telephelyKod: null, nev: displayNev, adoszam: wanted, exp: Date.now() + SESSION_MAX_AGE_MS };
  const token = signSession(payload);
  const cookie = `enysession=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax`;
  sendJson(res, 200, { ok: true, telephelyValasztva: false, company: { nev: displayNev, adoszam: wanted } }, { 'Set-Cookie': cookie });
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

// Telephelyek listája a bejelentkezett céghez — a telephely-választó
// képernyő és a telephely-karbantartó felület használja. Cég-szintű
// hitelesítés is elég hozzá (nem kell, hogy már ki legyen választva).
route('GET', '/api/telephelyek', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const meta = readSyncMeta();
  const telephelyek = listTelephelyek(session.cegKulcs).map((t) => {
    const siteKey = makeSiteKey(session.cegKulcs, t.kod);
    const site = companyIndex.get(siteKey);
    return {
      kod: t.kod, nev: t.nev, cim: t.cim || (site ? site.cim : ''),
      vanAdat: !!site,
      // csak akkor mutatunk szinkron-időpontot, ha a telephelynek TÉNYLEGESEN
      // van élő adata is — különben egy elárvult sync-meta bejegyzés (pl.
      // ideiglenes tárhely-törlés után) ellentmondásos képet adna
      // ("MÉG NINCS ADAT" jelzés, de mégis van szinkron-dátum)
      utolsoSzinkron: site ? (meta[siteKey]?.lastSync || null) : null,
    };
  });
  sendJson(res, 200, { cegNev: session.nev, adoszam: session.adoszam, telephelyValasztva: !!session.telephelyKod, telephelyek });
});

// Telephely kiválasztása (vagy váltás egy másikra, ha már volt kiválasztva) —
// új, teljes (telephely-szintű) munkamenetet ad.
route('POST', '/api/telephely/select', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { telephelyKod } = await readJsonBody(req);
  const kod = normalizeTelephelyKod(telephelyKod);
  const telephelyek = listTelephelyek(session.cegKulcs);
  const t = telephelyek.find((x) => x.kod === kod);
  if (!t) return sendJson(res, 404, { error: 'Ismeretlen telephely.' });

  const siteKey = makeSiteKey(session.cegKulcs, kod);
  const site = companyIndex.get(siteKey);
  const payload = {
    companyKey: siteKey, cegKulcs: session.cegKulcs, telephelyKod: kod,
    nev: site ? site.nev : session.nev, adoszam: site ? site.adoszam : session.adoszam,
    exp: Date.now() + SESSION_MAX_AGE_MS,
  };
  const token = signSession(payload);
  const cookie = `enysession=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax`;
  logActivity({ type: 'telephely_select', ok: true, companyKey: siteKey, nev: payload.nev, detail: `Telephely kiválasztva: ${t.nev} (${kod})` });
  sendJson(res, 200, {
    ok: true,
    company: { nev: payload.nev, adoszam: payload.adoszam, varos: site?.varos, cim: site?.cim, telephelyNev: t.nev },
    vanAdat: !!site,
  }, { 'Set-Cookie': cookie });
});

// Új telephely felvétele (telephely-karbantartó). Cég-szintű hitelesítés
// is elég — ki lehet bővíteni a telephely-választó képernyőről is,
// anélkül hogy előbb ki kéne választani egy meglévőt.
route('POST', '/api/telephely/create', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const body = await readJsonBody(req);
  const kod = normalizeTelephelyKod(body.kod);
  const nev = String(body.nev || '').trim();
  const cim = String(body.cim || '').trim();
  if (!nev) return sendJson(res, 400, { error: 'A telephely neve kötelező.' });

  const data = readTelephelyek();
  if (!data[session.cegKulcs]) data[session.cegKulcs] = [];
  if (data[session.cegKulcs].some((t) => t.kod === kod)) {
    return sendJson(res, 400, { error: `Már létezik telephely "${kod}" kóddal — válassz másikat.` });
  }
  data[session.cegKulcs].push({ kod, nev, cim, letrehozva: new Date().toISOString() });
  writeTelephelyek(data);
  logActivity({ type: 'telephely_create', ok: true, companyKey: session.cegKulcs, nev: session.nev, detail: `Új telephely: ${nev} (${kod})` });
  sendJson(res, 200, { ok: true, kod, nev, cim });
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

  // A GROUP BY keltdat csak azokat a napokat adja vissza, amiken tényleg volt
  // forgalom — forgalom nélküli napokra NULLA-val ki kell tölteni a sorozatot,
  // különben a grafikon elszórt pontokat kap folytonos vonal helyett, ha a
  // tartományban csak néhány napon volt adat.
  const dailyMap = new Map(daily.map((r) => [r.d, r]));
  const allDays = [];
  {
    const cursor = new Date(from + 'T00:00:00Z');
    const end = new Date(to + 'T00:00:00Z');
    while (cursor <= end) {
      const iso = cursor.toISOString().slice(0, 10);
      const row = dailyMap.get(iso);
      allDays.push({ d: iso, revenue: row ? row.revenue : 0, cnt: row ? row.cnt : 0 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  if (group === 'day') return sendJson(res, 200, { group, points: allDays });
  const buckets = new Map();
  for (const row of allDays) {
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
    `SELECT c.megnevezes AS nev, c.me, c.bruttoar, c.afakod, c.vonalkod, c.status, c.afakodelv AS afakodElviteli,
            IFNULL(g.megnevezes, 'Nincs csoport') AS csoportNev
     FROM cikkt c LEFT JOIN cikkcsop g ON g.azon = c.csopazon
     WHERE c.status = 'A' ORDER BY c.megnevezes`
  );
  let pendingRows = [];
  try {
    pendingRows = productChangesDb.prepare(
      `SELECT payload, meta FROM product_changes WHERE company_key = ? AND status = 'pending' AND change_type = 'cikk_upsert'`
    ).all(session.companyKey);
  } catch (_) {}
  const pendingMap = new Map();
  for (const p of pendingRows) {
    try {
      const pl = JSON.parse(p.payload);
      const meta = p.meta ? JSON.parse(p.meta) : {};
      pendingMap.set(pl.megnevezes, { ...pl, csoportNev: meta.csoportNev || null });
    } catch (_) {}
  }
  const items = rows.map((r) => ({ ...r, pendingChange: pendingMap.get(r.nev) || null }));
  // olyan cikk is legyen látható, ami még csak függőben van (androidon még nem létezik)
  const existingNames = new Set(rows.map((r) => r.nev));
  for (const [nev, pl] of pendingMap) {
    if (!existingNames.has(nev)) items.push({ nev, me: pl.me, bruttoar: pl.bruttoar, afakod: pl.afakod, vonalkod: pl.vonalkod, status: 'A', csoportNev: pl.csoportNev || 'Nincs csoport', afakodElviteli: pl.afakodelv, pendingChange: pl, isNewPending: true });
  }
  items.sort((a, b) => a.nev.localeCompare(b.nev, 'hu'));
  sendJson(res, 200, { items });
});

route('GET', '/api/products/groups', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const rows = all(session.companyKey, `SELECT megnevezes AS nev FROM cikkcsop WHERE status = 'A' ORDER BY megnevezes`);
  const names = new Set(rows.map((r) => r.nev));
  let pending = [];
  try {
    pending = productChangesDb.prepare(
      `SELECT payload FROM product_changes WHERE company_key = ? AND status = 'pending' AND change_type = 'csoport_upsert'`
    ).all(session.companyKey);
  } catch (_) {}
  const items = rows.map((r) => ({ nev: r.nev, isNewPending: false }));
  for (const p of pending) {
    try {
      const pl = JSON.parse(p.payload);
      if (pl.megnevezes && !names.has(pl.megnevezes)) { items.push({ nev: pl.megnevezes, isNewPending: true }); names.add(pl.megnevezes); }
    } catch (_) {}
  }
  items.sort((a, b) => a.nev.localeCompare(b.nev, 'hu'));
  sendJson(res, 200, { items });
});

// Egyedi cikk létrehozása/módosítása — függő módosításként kerül be, NEM
// közvetlenül a szinkronizált adatbázisba (lásd fenti magyarázat).
// A payload mezőnevei PONTOSAN a cikkt / cikkcsop táblák oszlopneveivel
// kell, hogy egyezzenek (kisbetűvel) — az androidos oldal ezek alapján ír
// közvetlenül a saját adatbázisába, nem tud kitalálni egyedi elnevezéseket,
// amiket a webes felület esetleg máshogy hívna.
// FONTOS: az androidos alkalmazás a payload MINDEN kulcsát egy az egyben,
// generikusan (mezőnév = oszlopnév) próbálja ráilleszteni a cikkt táblára,
// és HA BÁRMELYIK KULCS NEM LÉTEZŐ OSZLOP, elutasítja az egész szinkront
// ("Érvénytelen mezőnév érkezett a JSON-ben" hiba). Emiatt a payload
// KIZÁRÓLAG szó szerinti cikkt-oszlopneveket tartalmazhat — semmi mást,
// még beágyazott objektumot sem (ezt élesben, androidos hibaüzenetből
// derítettük ki). A tervezett csoport nevét ezért KÜLÖN, a "meta" mezőben
// tároljuk — az csak a weben jelenik meg, sosem kerül elküldésre.
function buildCikkPayload({ megnevezes, me, bruttoar, afakod, vonalkod, afakodelv }) {
  return { megnevezes, me, bruttoar, afakod, vonalkod: vonalkod || null, afakodelv: afakodelv || null };
}

route('POST', '/api/products/change', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const body = await readJsonBody(req);
  const megnevezes = String(body.megnevezes || '').trim();
  if (!megnevezes) return sendJson(res, 400, { error: 'A cikk neve kötelező.' });
  const bruttoar = parseFloat(body.bruttoar);
  if (!Number.isFinite(bruttoar) || bruttoar < 0) return sendJson(res, 400, { error: 'Érvénytelen bruttó ár.' });
  const afakod = String(body.afakod || '').trim();
  if (!afakod) return sendJson(res, 400, { error: 'Az ÁFA kód kötelező.' });
  if (!VALID_AFA_CODES.includes(afakod)) return sendJson(res, 400, { error: `Érvénytelen ÁFA kód. Megengedett értékek: ${VALID_AFA_CODES.join(', ')}.` });
  const me = String(body.me || '').trim() || 'Darab';
  const csoportNev = String(body.csoportNev || '').trim() || null;
  const vonalkod = String(body.vonalkod || '').trim() || null;
  const afakodelv = String(body.afakodElviteli || '').trim() || null;
  if (afakodelv && !VALID_AFA_CODES.includes(afakodelv)) return sendJson(res, 400, { error: `Érvénytelen elviteli ÁFA kód. Megengedett értékek: ${VALID_AFA_CODES.join(', ')}.` });
  addProductChange(session.companyKey, 'cikk_upsert', buildCikkPayload({ megnevezes, me, bruttoar, afakod, vonalkod, afakodelv }), 'web_form', csoportNev ? { csoportNev } : null);
  logActivity({ type: 'product_change_add', ok: true, companyKey: session.companyKey, nev: session.nev, detail: `${megnevezes} → ${bruttoar} Ft` });
  sendJson(res, 200, { ok: true });
});

// Új termékcsoport létrehozása — szintén függő módosításként.
route('POST', '/api/products/group', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const body = await readJsonBody(req);
  const megnevezes = String(body.megnevezes || '').trim();
  if (!megnevezes) return sendJson(res, 400, { error: 'A csoport neve kötelező.' });
  addProductChange(session.companyKey, 'csoport_upsert', { megnevezes }, 'web_form');
  logActivity({ type: 'product_group_add', ok: true, companyKey: session.companyKey, nev: session.nev, detail: megnevezes });
  sendJson(res, 200, { ok: true });
});

// Tömeges árváltoztatás — csoport szerint vagy megadott cikknevek szerint,
// százalékos vagy fix összegű módosítással. Cikkenként külön függő
// módosítást hoz létre.
route('POST', '/api/products/bulk-price', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const body = await readJsonBody(req);
  const mode = body.mode === 'fixed' ? 'fixed' : 'percent';
  const value = parseFloat(body.value);
  if (!Number.isFinite(value)) return sendJson(res, 400, { error: 'Érvénytelen érték.' });
  const csoportNev = body.csoportNev ? String(body.csoportNev).trim() : null;
  const names = Array.isArray(body.names) ? body.names.filter(Boolean) : null;
  if (!csoportNev && !names) return sendJson(res, 400, { error: 'Válassz csoportot vagy cikkeket.' });

  let products = all(session.companyKey,
    `SELECT c.megnevezes AS nev, c.me, c.bruttoar, c.afakod, c.vonalkod, c.afakodelv, IFNULL(g.megnevezes,'Nincs csoport') AS csoportNev
     FROM cikkt c LEFT JOIN cikkcsop g ON g.azon = c.csopazon WHERE c.status = 'A'`
  );
  if (csoportNev) products = products.filter((p) => p.csoportNev === csoportNev);
  if (names) products = products.filter((p) => names.includes(p.nev));
  if (!products.length) return sendJson(res, 400, { error: 'Nincs a feltételnek megfelelő cikk.' });

  for (const p of products) {
    let newPrice = mode === 'percent' ? p.bruttoar * (1 + value / 100) : p.bruttoar + value;
    newPrice = Math.max(0, Math.round(newPrice));
    addProductChange(session.companyKey, 'cikk_upsert',
      buildCikkPayload({ megnevezes: p.nev, me: p.me, bruttoar: newPrice, afakod: p.afakod, vonalkod: p.vonalkod, afakodelv: p.afakodelv }),
      'web_bulk_price', p.csoportNev ? { csoportNev: p.csoportNev } : null);
  }
  logActivity({ type: 'product_bulk_price', ok: true, companyKey: session.companyKey, nev: session.nev, detail: `${products.length} cikk ára módosítva (${mode === 'percent' ? value + '%' : value + ' Ft'})` });
  sendJson(res, 200, { ok: true, count: products.length });
});

// Függő + korábbi módosítások listája (a webes "Cikktörzs" nézet állapot-oszlopához).
route('GET', '/api/products/changes', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const rows = productChangesDb.prepare(
    `SELECT id, change_type AS changeType, payload, status, source, created_at AS createdAt, delivered_at AS deliveredAt
     FROM product_changes WHERE company_key = ? ORDER BY id DESC LIMIT 300`
  ).all(session.companyKey);
  const items = rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  sendJson(res, 200, { items });
});

// CSV export — a jelenlegi, élő cikktörzs letöltése Excelben szerkeszthető formában.
const CSV_HEADERS = ['Cikknév', 'Csoport', 'Egység', 'Bruttó ár', 'ÁFA kód', 'Vonalkód', 'Elviteli ÁFA kód'];

route('GET', '/api/products/export', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const rows = all(session.companyKey,
    `SELECT c.megnevezes AS nev, IFNULL(g.megnevezes,'') AS csoport, c.me, c.bruttoar, c.afakod, IFNULL(c.vonalkod,'') AS vonalkod, IFNULL(c.afakodelv,'') AS afakodelv
     FROM cikkt c LEFT JOIN cikkcsop g ON g.azon = c.csopazon WHERE c.status = 'A' ORDER BY c.megnevezes`
  );
  const csv = toCsv(
    rows.map((r) => ({ 'Cikknév': r.nev, 'Csoport': r.csoport, 'Egység': r.me, 'Bruttó ár': r.bruttoar, 'ÁFA kód': r.afakod, 'Vonalkód': r.vonalkod, 'Elviteli ÁFA kód': r.afakodelv })),
    CSV_HEADERS
  );
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="cikktorzs.csv"' });
  res.end(csv);
});

// Letölthető minta CSV (üres kiindulási sablon, pár példasorral).
route('GET', '/api/products/import-template', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const example = [
    { 'Cikknév': 'Espresso', 'Csoport': 'Kávézó kínálat', 'Egység': 'Darab', 'Bruttó ár': 650, 'ÁFA kód': '05%', 'Vonalkód': '', 'Elviteli ÁFA kód': '' },
    { 'Cikknév': 'Croissant', 'Csoport': 'Kávézó kínálat', 'Egység': 'Darab', 'Bruttó ár': 790, 'ÁFA kód': '27%', 'Vonalkód': '', 'Elviteli ÁFA kód': '27%' },
  ];
  const csv = toCsv(example, CSV_HEADERS);
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="cikktorzs-minta.csv"' });
  res.end(csv);
});

// CSV import — soronként egy függő cikk-módosítást hoz létre.
route('POST', '/api/products/import', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const buf = await readBody(req, 5 * 1024 * 1024);
  const text = buf.toString('utf8');
  const rows = parseCsv(text);
  if (!rows.length) return sendJson(res, 400, { error: 'Üres vagy érvénytelen CSV fájl.' });
  const header = rows[0].map((h) => h.trim());
  const idx = {
    nev: header.indexOf('Cikknév'), csoport: header.indexOf('Csoport'), me: header.indexOf('Egység'),
    ar: header.indexOf('Bruttó ár'), afa: header.indexOf('ÁFA kód'), vonalkod: header.indexOf('Vonalkód'),
    afakodelv: header.indexOf('Elviteli ÁFA kód'),
  };
  if (idx.nev === -1 || idx.ar === -1 || idx.afa === -1) {
    return sendJson(res, 400, { error: 'Hiányzó kötelező oszlop (Cikknév, Bruttó ár, ÁFA kód). Használd a letölthető mintát.' });
  }
  let count = 0;
  const errors = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const nev = (r[idx.nev] || '').trim();
    if (!nev) continue;
    const ar = parseFloat(r[idx.ar]);
    const afa = (r[idx.afa] || '').trim();
    if (!Number.isFinite(ar) || ar < 0 || !afa) { errors.push(`${i + 1}. sor: hiányos vagy érvénytelen adat`); continue; }
    if (!VALID_AFA_CODES.includes(afa)) { errors.push(`${i + 1}. sor (${nev}): érvénytelen ÁFA kód (${afa}) — megengedett: ${VALID_AFA_CODES.join(', ')}`); continue; }
    const afakodElvitelRaw = (idx.afakodelv > -1 && r[idx.afakodelv]) ? r[idx.afakodelv].trim() : null;
    if (afakodElvitelRaw && !VALID_AFA_CODES.includes(afakodElvitelRaw)) { errors.push(`${i + 1}. sor (${nev}): érvénytelen elviteli ÁFA kód (${afakodElvitelRaw})`); continue; }
    const csoportNevImport = (idx.csoport > -1 && r[idx.csoport]) ? r[idx.csoport].trim() : null;
    addProductChange(session.companyKey, 'cikk_upsert', buildCikkPayload({
      megnevezes: nev,
      me: (idx.me > -1 && r[idx.me]) ? r[idx.me].trim() : 'Darab',
      bruttoar: ar,
      afakod: afa,
      vonalkod: (idx.vonalkod > -1 && r[idx.vonalkod]) ? r[idx.vonalkod].trim() : null,
      afakodelv: afakodElvitelRaw,
    }), 'excel_import', csoportNevImport ? { csoportNev: csoportNevImport } : null);
    count++;
  }
  logActivity({ type: 'product_import', ok: true, companyKey: session.companyKey, nev: session.nev, detail: `${count} cikk importálva${errors.length ? `, ${errors.length} hibás sor` : ''}` });
  sendJson(res, 200, { ok: true, count, errors });
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
  const cegKulcs = companyKeyFromAdoszam(adoszamRaw);
  if (cegKulcs.length < 8) {
    logActivity({ type: 'sync_upload', ok: false, companyKey: null, nev: null, detail: 'Hiányzó vagy érvénytelen x-adoszam.', ip });
    return sendJson(res, 400, { error: 'Hiányzó vagy érvénytelen x-adoszam fejléc / adoszam paraméter — melyik céghez tartozik a feltöltés?' });
  }
  // Új: x-telephely fejléc — melyik telephelyről érkezik a feltöltés.
  // Ha egy még nem frissített androidos app nem küldi, "01"-re esik
  // vissza (visszafelé kompatibilitás az egytelephelyes cégekkel).
  const telephelyRaw = req.headers['x-telephely'] || query.telephely;
  const telephelyKod = normalizeTelephelyKod(telephelyRaw);
  const key = makeSiteKey(cegKulcs, telephelyKod);

  let buf;
  // A korábbi 100 MB-os korlát önkényes volt, semmi köze a git/GitHub-hoz
  // (az egy teljesen más, a repóba kerülő induló mintaadatokra vonatkozott).
  // Itt most gyakorlatilag korlátlanra emeltük (2 GB) — ennél nagyobb valódi
  // POS-adatbázis nem valószínű, de ha mégis kellene, ez a szám bátran
  // tovább emelhető. A nulla/valóban végtelen limitet szándékosan nem
  // állítottuk be, mert a teljes törzs egyszerre kerül memóriába feltöltés
  // közben — egy hibás/rosszindulatú kérés így sem tudja korlátlanul
  // felzabálni a szerver memóriáját.
  try { buf = await readBody(req, 2 * 1024 * 1024 * 1024); }
  catch (_) {
    logActivity({ type: 'sync_upload', ok: false, companyKey: key, nev: companyIndex.get(key)?.nev || null, detail: 'A feltöltött fájl túl nagy.', ip });
    return sendJson(res, 413, { error: 'A feltöltött fájl túl nagy.' });
  }
  if (buf.length < 100 || buf.slice(0, 16).toString('utf8').indexOf('SQLite format 3') !== 0) {
    logActivity({ type: 'sync_upload', ok: false, companyKey: key, nev: companyIndex.get(key)?.nev || null, detail: 'A törzs nem érvényes SQLite fájl.', ip });
    return sendJson(res, 400, { error: 'A törzsnek egy érvényes SQLite (.db) fájlnak kell lennie.' });
  }

  const dbFile = dbFileForKey(key);
  fs.mkdirSync(path.dirname(dbFile), { recursive: true }); // új cég/telephely esetén a mappa még nem létezik
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
  if (identity) companyIndex.set(key, { ...identity, dbFile, cegKulcs, telephelyKod });
  if (isNew) {
    ensureTelephely(cegKulcs, telephelyKod, null); // ha adminisztratívan még nem lett felvéve, most regisztráljuk
    ensureAccessCodes(); // új cégnek azonnal legyen belépési kódja
  }
  if (identity) reconcileProductChanges(key); // friss adat -> nézzük, teljesült-e valamelyik függő cikktörzs-módosítás

  if (!identity) {
    logActivity({ type: 'sync_upload', ok: false, companyKey: key, nev: null, detail: 'A fájl elmentve, de nem sikerült beolvasni belőle a cégadatokat (hiányzó szallitot sor?).', ip });
    return sendJson(res, 400, { error: 'A fájl elmentve, de nem sikerült beolvasni belőle a cégadatokat.' });
  }

  const meta = readSyncMeta();
  meta[key] = { lastSync: new Date().toISOString(), source: 'android-sync', bytes: buf.length, nev: identity.nev };
  writeSyncMeta(meta);

  logActivity({ type: 'sync_upload', ok: true, companyKey: key, nev: identity.nev, detail: `${Math.round(buf.length / 1024)} KB${isNew ? ' — új telephely regisztrálva' : ''}`, ip });
  console.log(`[sync] ${key} (${identity.nev}) frissítve — ${buf.length} bájt${isNew ? ' — ÚJ TELEPHELY regisztrálva' : ''}`);
  sendJson(res, 200, { ok: true, companyKey: key, newCompany: isNew, ...meta[key] });
});

// Demó/manuális "Frissítés most" gomb a felületen — bejelentkezett munkamenettel
// hívható, a saját cégre vonatkozóan. Amíg nincs valós eszközkapcsolat beállítva
// (lásd README), csak visszajelzi az aktuális állapotot ahelyett, hogy adatot hamisítana.
// Ezt kellene lekérdeznie az androidos appnak (ugyanazzal az x-api-key +
// x-adoszam hitelesítéssel, mint a feltöltésnél), MINDEN szinkron ELŐTT:
// az itt kapott cikk/csoport módosításokat helyben alkalmazva, MIELŐTT
// elküldi a saját friss adatbázisát. A szerver automatikusan felismeri,
// ha egy módosítás megtörtént (a következő feltöltésben már benne van a
// kért érték), nincs szükség külön visszaigazoló hívásra.
route('GET', '/api/sync/pending-changes', async (req, res, query) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== SECRETS.syncApiKey) return sendJson(res, 401, { error: 'Érvénytelen vagy hiányzó x-api-key.' });
  const adoszamRaw = req.headers['x-adoszam'] || query.adoszam;
  const cegKulcs = companyKeyFromAdoszam(adoszamRaw);
  if (cegKulcs.length < 8) return sendJson(res, 400, { error: 'Hiányzó vagy érvénytelen x-adoszam fejléc / adoszam paraméter.' });
  const telephelyRaw = req.headers['x-telephely'] || query.telephely;
  const key = makeSiteKey(cegKulcs, telephelyRaw);
  const rows = productChangesDb.prepare(
    `SELECT id, change_type AS type, payload FROM product_changes WHERE company_key = ? AND status = 'pending' ORDER BY id ASC`
  ).all(key);
  const items = rows.map((r) => ({ id: r.id, type: r.type, payload: JSON.parse(r.payload) }));
  sendJson(res, 200, { items });
});

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
  const seen = new Set();
  const list = [...companyIndex.entries()]
    .filter(([, entry]) => { if (seen.has(entry.cegKulcs)) return false; seen.add(entry.cegKulcs); return true; }) // cégenként egyszer, ne telephelyenként
    .map(([, entry]) => ({ nev: entry.nev, adoszam: entry.adoszam, code: codes[entry.cegKulcs]?.code }))
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
      const cegKulcs = entry.cegKulcs;
      let fallbackEmail = '';
      if (!codes[cegKulcs]?.email) {
        try { fallbackEmail = get(key, 'SELECT email FROM szallitot LIMIT 1')?.email || ''; } catch (_) {}
      }
      const telephelyInfo = listTelephelyek(cegKulcs).find((t) => t.kod === entry.telephelyKod);
      return {
        key, cegKulcs, telephelyKod: entry.telephelyKod, telephelyNev: telephelyInfo?.nev || entry.telephelyKod,
        nev: entry.nev, adoszam: entry.adoszam, varos: entry.varos,
        code: codes[cegKulcs]?.code, email: codes[cegKulcs]?.email || fallbackEmail,
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
  const cegKulcs = splitSiteKey(companyKey).cegKulcs; // elfogadja akár a puszta cégkulcsot, akár egy telephely-kulcsot is
  const anySite = [...companyIndex.values()].find((e) => e.cegKulcs === cegKulcs);
  if (!anySite && !listTelephelyek(cegKulcs).length) return sendJson(res, 404, { error: 'Ismeretlen cég.' });
  const codes = readAccessCodes();
  codes[cegKulcs] = { ...(codes[cegKulcs] || {}), code: generateAccessCode() };
  writeAccessCodes(codes);
  logActivity({ type: 'admin_regen_code', ok: true, companyKey: cegKulcs, nev: anySite?.nev, detail: 'Hozzáférési kód újragenerálva.' });
  sendJson(res, 200, { ok: true, companyKey: cegKulcs, code: codes[cegKulcs].code });
});

// Admin kiküldi a cég hozzáférési kódját emailben, Brevón keresztül.
route('POST', '/api/admin/send-code', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { companyKey, email } = await readJsonBody(req);
  const cegKulcs = splitSiteKey(companyKey).cegKulcs;
  const anySite = [...companyIndex.values()].find((e) => e.cegKulcs === cegKulcs);
  if (!anySite && !listTelephelyek(cegKulcs).length) return sendJson(res, 404, { error: 'Ismeretlen cég.' });
  const nevPlain = anySite?.nev || 'Ismeretlen cég';
  const adoszamPlain = anySite?.adoszam || cegKulcs;
  const cleanEmail = String(email || '').trim();
  if (!cleanEmail || !cleanEmail.includes('@')) return sendJson(res, 400, { error: 'Érvénytelen email cím.' });

  const codes = ensureAccessCodes();
  const code = codes[cegKulcs]?.code;
  const nev = escapeHtmlServer(nevPlain);
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#1E3247;line-height:1.6;">
      <p>Kedves <strong>${nev}</strong>!</p>
      <p>Az L-NYUGTA nézegetőbe való belépéshez az alábbi adatokat használd:</p>
      <table style="margin:16px 0;border-collapse:collapse;">
        <tr><td style="padding:4px 12px 4px 0;color:#6C8299;">Adószám</td><td style="padding:4px 0;font-weight:600;">${escapeHtmlServer(adoszamPlain)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#6C8299;">Hozzáférési kód</td><td style="padding:4px 0;font-weight:700;font-size:20px;letter-spacing:3px;">${escapeHtmlServer(code)}</td></tr>
      </table>
      <p style="color:#6C8299;font-size:12.5px;">Ha nem te kérted ezt az emailt, kérjük hagyd figyelmen kívül.</p>
    </div>`;

  try {
    await sendBrevoEmail({ toEmail: cleanEmail, toName: nevPlain, subject: 'L-NYUGTA — hozzáférési kódod', html });
  } catch (e) {
    logActivity({ type: 'admin_send_code', ok: false, companyKey: cegKulcs, nev: nevPlain, detail: `Sikertelen küldés (${cleanEmail}): ${e.message}` });
    return sendJson(res, 502, { error: `Nem sikerült elküldeni: ${e.message}` });
  }
  logActivity({ type: 'admin_send_code', ok: true, companyKey: cegKulcs, nev: nevPlain, detail: `Kód kiküldve ide: ${cleanEmail}` });

  codes[cegKulcs] = { ...(codes[cegKulcs] || {}), email: cleanEmail };
  writeAccessCodes(codes);
  console.log(`[email] kód elküldve: ${nevPlain} (${cegKulcs}) -> ${cleanEmail}`);
  sendJson(res, 200, { ok: true });
});

// Admin "belép" egy adott cég nevében — utána a normál, cégenkénti
// dashboard API-kat használja a böngésző, mintha az illető cég jelentkezett
// volna be az adószámával. Így nem kell duplikálni egyik nézetet sem.
route('POST', '/api/admin/impersonate', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { companyKey } = await readJsonBody(req);
  const entry = companyIndex.get(companyKey); // companyKey itt egy teljes telephely-kulcs ("cégkulcs:kód")
  if (!entry) return sendJson(res, 404, { error: 'Ismeretlen telephely.' });
  const payload = {
    companyKey, cegKulcs: entry.cegKulcs, telephelyKod: entry.telephelyKod,
    cegid: entry.cegid, nev: entry.nev, adoszam: entry.adoszam, exp: Date.now() + SESSION_MAX_AGE_MS,
  };
  const token = signSession(payload);
  const cookie = `enysession=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax`;
  const telephelyInfo = listTelephelyek(entry.cegKulcs).find((t) => t.kod === entry.telephelyKod);
  logActivity({ type: 'admin_impersonate', ok: true, companyKey, nev: entry.nev, detail: 'Admin megnyitotta a telephely nézetét.' });
  sendJson(res, 200, { ok: true, company: { nev: entry.nev, adoszam: entry.adoszam, varos: entry.varos, cim: entry.cim, telephelyNev: telephelyInfo?.nev || entry.telephelyKod } }, { 'Set-Cookie': cookie });
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
