// L-NYUGTA – A pénztárgéped okos társa — önálló Node.js szerver
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
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------------------
// Konfiguráció
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '3000', 10);
// Alapértelmezetten KIZÁRÓLAG a helyi gépről (localhost) fogad kapcsolatot —
// ez egy védelmi réteg a tűzfal-szabályok MELLETT (nem helyette): az
// Apache ugyanazon a gépen fut, és localhost-on keresztül proxyzza a
// kéréseket ide, így a Node folyamatnak SOSEM kellene közvetlenül,
// kívülről elérhetőnek lennie. Ha valamiért mégis szükség lenne rá (pl.
// egy másik gépről futó reverse proxy), a HOST env-változóval felülírható.
const HOST = process.env.HOST || '127.0.0.1';
// A LNYUGTA_DATA_DIR env-változóval felülírható — ez teszi lehetővé, hogy
// az automatizált tesztek egy elkülönített, ideiglenes adatkönyvtárral
// fussanak, anélkül hogy a teljes alkalmazást le kellene másolni.
const DATA_DIR = process.env.LNYUGTA_DATA_DIR
  ? path.resolve(process.env.LNYUGTA_DATA_DIR)
  : path.join(__dirname, 'data');
const COMPANIES_DIR = path.join(DATA_DIR, 'companies');
const SYNC_META_PATH = path.join(DATA_DIR, 'sync-meta.json');
const SECRETS_PATH = path.join(DATA_DIR, '.secrets.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 óra
const MAX_OPEN_DB_CONNECTIONS = 40; // ennyi cég adatbázisát tartjuk egyszerre nyitva (LRU)

// Sütik `Secure` jelzővel (csak HTTPS-en küldi el a böngésző). Alapból BE van
// kapcsolva — csak akkor kapcsold ki (DISABLE_SECURE_COOKIES=1), ha helyi
// fejlesztés közben sima HTTP-n (nem HTTPS-en) teszteled a bejelentkezést.
const COOKIE_SECURE = process.env.DISABLE_SECURE_COOKIES !== '1';

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

// A cégenkénti NAV-hitelesítő adatok (jelszó, aláíró- és cserekulcs) NEM
// tárolhatók nyílt szövegként az adatbázisban — ezeket a szerver saját,
// automatikusan generált session-titkából származtatott kulccsal, AES-256-
// GCM-mel titkosítva mentjük. (A session-titok maga is csak a szerveren
// tárolt, .secrets.json fájlban van — ugyanaz a védelmi szint, mint amit
// eddig is alkalmaztunk a munkamenet-tokenekre.)
const NAV_CRED_ENC_KEY = crypto.createHash('sha256').update(`nav-cred-enc:${SECRETS.sessionSecret}`).digest();
function encryptNavSecret(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', NAV_CRED_ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}
function decryptNavSecret(stored) {
  if (!stored) return null;
  const buf = Buffer.from(stored, 'base64');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', NAV_CRED_ENC_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

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

// A hivatalos, NAV-szerű címformátumhoz — a magyar címzésben szokásos,
// leggyakoribb közterület-jellegek. Nem teljes, kimerítő hivatalos
// kódtár (ilyen nincs is egységesen), ezért mindig van egy "egyéb, kézi
// bevitel" lehetőség is, hogy semmilyen valós cím ne legyen kizárva.
const KOZTERULET_JELLEGEK = [
  'utca', 'út', 'tér', 'körút', 'sétány', 'köz', 'sor', 'dűlő', 'part',
  'rakpart', 'liget', 'fasor', 'udvar', 'park', 'lejtő', 'ösvény',
];
function formatNavAddress(a) {
  if (!a) return '';
  const kozterulet = [a.kozteruletNev, a.kozteruletJelleg].filter(Boolean).join(' ');
  const line1 = [
    [a.iranyitoszam, a.telepules].filter(Boolean).join(' '),
    [kozterulet, a.hazszam ? `${a.hazszam}.` : ''].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ');
  return [line1, a.emelet || ''].filter(Boolean).join(' ');
}

// A demo-számlák KIÁLLÍTÓJA — a rendszert üzemeltető cég valós,
// nyilvános cégadatai (cégjegyzékből ellenőrizve), a kötelező számla-
// adattartalomhoz (Áfa tv. 169. §) szükséges eladói adatok.
const ELADO_NEV = 'Leichter Irodatechnika Kft.';
const ELADO_ADOSZAM = '12491980-2-13';
const ELADO_CIM = '2200 Monor, Virág utca 39.';
const ELADO_CEGJEGYZEKSZAM = '13-09-085292';

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
    szamla_fajl TEXT,
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

  -- Termékfotók — SZÁNDÉKOSAN csak a weben tárolt, kiegészítő adat, NEM
  -- szinkronizálódik az androidos alkalmazással. A cikkt tábla valódi
  -- sémájában nincs kép-mező, és az androidos szinkron elutasítaná az
  -- egész frissítést egy ismeretlen mezőnévre — ezért ez a funkció itt,
  -- teljesen elkülönítve, csak a webes felület megjelenítését szolgálja.
  CREATE TABLE IF NOT EXISTS termek_kepek (
    company_key TEXT NOT NULL,
    cikk_nev TEXT NOT NULL,
    fajlnev TEXT NOT NULL,
    feltoltve TEXT NOT NULL,
    PRIMARY KEY (company_key, cikk_nev)
  );
`);
{
  const cols = stockDb.prepare(`PRAGMA table_info(bevetelezesek)`).all();
  if (!cols.some((c) => c.name === 'szamla_fajl')) {
    stockDb.exec(`ALTER TABLE bevetelezesek ADD COLUMN szamla_fajl TEXT`);
  }
}
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// A fájl TARTALMA (mágikus bájtok) alapján dönti el, milyen típusú —
// SOSEM a kliens által küldött fájlnévben/MIME-ben bízunk, mert azt
// bárki tetszőlegesre írhatja. Csak a ténylegesen szükséges, ártalmatlan
// formátumokat engedjük át; minden más (pl. futtatható fájlok, szkriptek,
// HTML) elutasításra kerül. Visszatérési érték: a helyes kiterjesztés,
// vagy null, ha egyik ismert típusnak sem felel meg.
function detectSafeFileType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return '.jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return '.png';
  if (buf.slice(0, 4).toString('ascii') === '%PDF') return '.pdf';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return '.webp';
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.slice(8, 12).toString('ascii');
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return '.heic';
  }
  return null;
}

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

// ---------------------------------------------------------------------------
// Felhasználói fiókok — viszonteladó, cégtulajdonos, üzletvezető.
// Az admin NEM itt van (az a meglévő ADMIN_PASSWORD env-változós, önálló
// mechanizmus marad, változatlanul).
// ---------------------------------------------------------------------------
const USERS_DB_PATH = path.join(DATA_DIR, 'users.db');
const usersDb = new DatabaseSync(USERS_DB_PATH, { readOnly: false });
usersDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    role TEXT NOT NULL CHECK(role IN ('reseller','owner','manager')),
    reseller_id INTEGER,
    ceg_kulcs TEXT,
    telephely_kod TEXT,
    nev TEXT NOT NULL,
    telefon TEXT,
    gdpr_elfogadva TEXT,
    aszf_elfogadva TEXT,
    invited_by TEXT,
    invite_token TEXT,
    invite_expires TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','disabled')),
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_invite_token ON users(invite_token);
  CREATE INDEX IF NOT EXISTS idx_users_ceg ON users(ceg_kulcs);
  CREATE INDEX IF NOT EXISTS idx_users_reseller ON users(reseller_id);

  -- Valódi, szerver-oldali munkamenet-visszavonás. A session cookie-k
  -- önmagukban érvényes, aláírt tokenek (nincs szerver-oldali "store"),
  -- ezért kijelentkezéskor NEM elég a böngészőben törölni a sütit — ha
  -- valaki korábban lemásolta a token értékét (megosztott gépen, stb.),
  -- az önmagában a lejáratáig továbbra is érvényes maradna. Ez a tábla
  -- ezt zárja ki: minden tokenhez egyedi azonosítót (jti) adunk, és
  -- kijelentkezéskor ide kerül — az érvényesség-ellenőrzés mindig
  -- megnézi, nincs-e itt.
  CREATE TABLE IF NOT EXISTS revoked_sessions (
    jti TEXT PRIMARY KEY,
    revoked_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_revoked_sessions_exp ON revoked_sessions(expires_at);
`);

// Migráció — a telefonszám és a GDPR/ÁSZF-elfogadás mezők régebbi, már
// futó telepítéseknél még hiányozhatnak a users táblából.
{
  const cols = usersDb.prepare(`PRAGMA table_info(users)`).all();
  for (const [name, def] of [['telefon', 'TEXT'], ['gdpr_elfogadva', 'TEXT'], ['aszf_elfogadva', 'TEXT']]) {
    if (!cols.some((c) => c.name === name)) {
      usersDb.exec(`ALTER TABLE users ADD COLUMN ${name} ${def}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Licenc-kezelés — az androidos L-NYUGTA GO app licencét ezután a mi
// szerverünk tartja nyilván és szolgálja ki (nem az lszamla rendszer).
// Az lszamla modell mintájára (progtip_tul) a licenc FUNKCIÓNKÉNT (opción-
// ként) engedélyezett, mindegyik saját árral — nem csak egyetlen céges
// szintű lejárati dátum. Két tábla:
//   - license_features: a funkció-KATALÓGUS (mit lehet egyáltalán árulni),
//     admin szerkeszti (hozzáad/átnevez/áraz/kivezet) — data/license.db
//   - company_licenses: melyik CÉG melyik funkcióhoz fér hozzá, milyen
//     áron, meddig érvényesen (lejarat lehet NULL = nincs lejárat/örökös)
// ---------------------------------------------------------------------------
const LICENSE_DB_PATH = path.join(DATA_DIR, 'license.db');
const licenseDb = new DatabaseSync(LICENSE_DB_PATH, { readOnly: false });
licenseDb.exec(`
  CREATE TABLE IF NOT EXISTS license_features (
    key TEXT PRIMARY KEY,
    nev TEXT NOT NULL,
    leiras TEXT,
    alap_ar INTEGER NOT NULL DEFAULT 0,
    aktiv INTEGER NOT NULL DEFAULT 1,
    sorrend INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS company_licenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ceg_kulcs TEXT NOT NULL,
    telephely_kod TEXT NOT NULL DEFAULT '',
    feature_key TEXT NOT NULL,
    ar INTEGER NOT NULL DEFAULT 0,
    lejarat TEXT,
    aktiv INTEGER NOT NULL DEFAULT 1,
    jovahagyta TEXT,
    kartya_token TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(ceg_kulcs, telephely_kod, feature_key)
  );
  CREATE INDEX IF NOT EXISTS idx_company_licenses_ceg ON company_licenses(ceg_kulcs);

  -- Cégenkénti eszközkorlát (hány androidos eszköz futtathatja egyszerre a
  -- licencet) — ha egy cégre nincs sor, nincs korlát (a jelenlegi, korlát
  -- nélküli állapot marad, amíg admin explicit be nem állítja).
  CREATE TABLE IF NOT EXISTS company_device_limits (
    ceg_kulcs TEXT PRIMARY KEY,
    eszkoz_limit INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Melyik cégnél melyik eszköz már regisztrált — ez foglalja el a fenti
  -- korlát egy-egy "helyét". Az eszköz_azonosító magától az androidos
  -- appból jön (amit ő már úgyis ismer/küld), nincs hozzá semmi extra
  -- admin-adminisztráció, magától töltődik fel lekérdezéskor.
  CREATE TABLE IF NOT EXISTS company_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ceg_kulcs TEXT NOT NULL,
    eszkoz_azonosito TEXT NOT NULL,
    telephely_kod TEXT,
    nev TEXT,
    progtip TEXT,
    verzio TEXT,
    elso_latott TEXT NOT NULL,
    utolso_latott TEXT NOT NULL,
    UNIQUE(ceg_kulcs, eszkoz_azonosito)
  );
  CREATE INDEX IF NOT EXISTS idx_company_devices_ceg ON company_devices(ceg_kulcs);

  -- Programtípus-katalógus — melyik androidos app-változat (ENYUGTA_GO,
  -- ENYUGTA_WS, stb.) szinkronizált már valaha. Automatikusan bővül, ha
  -- egy szinkron olyan típust küld, amit még nem ismerünk — nem kell
  -- előre felvinni, csak akkor kerül be, ha ténylegesen látjuk.
  CREATE TABLE IF NOT EXISTS program_tipusok (
    kulcs TEXT PRIMARY KEY,
    nev TEXT,
    elso_latott TEXT NOT NULL
  );

  -- Bankkártyás fizetések (myPOS Checkout API) — minden fizetési
  -- KÍSÉRLETET rögzítünk, nem csak a sikereseket, hogy legyen teljes
  -- nyoma annak is, ha valaki elindított, de nem fejezett be egy
  -- fizetést. A "cel" mondja meg, mire vonatkozik (alap előfizetés,
  -- egy konkrét csomag, vagy egy önálló funkció).
  CREATE TABLE IF NOT EXISTS license_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT UNIQUE NOT NULL,
    ceg_kulcs TEXT NOT NULL,
    telephely_kod TEXT,
    feature_key TEXT,
    cel TEXT NOT NULL,
    osszeg NUMERIC NOT NULL,
    penznem TEXT NOT NULL DEFAULT 'HUF',
    allapot TEXT NOT NULL DEFAULT 'FUGGOBEN',
    mypos_trnref TEXT,
    kartya_token TEXT,
    ismetlodo INTEGER NOT NULL DEFAULT 0,
    szamla_sorszam TEXT,
    szamla_pdf_fajlnev TEXT,
    nav_transaction_id TEXT,
    nav_allapot TEXT,
    nav_uzenet TEXT,
    nav_retry_count INTEGER NOT NULL DEFAULT 0,
    nav_raw_response_fajlnev TEXT,
    letrehozva TEXT NOT NULL,
    lezarva TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_license_payments_ceg ON license_payments(ceg_kulcs);

  -- A kötelező számla-adattartalomhoz (Áfa tv. 169. §) a bizonylatoknak
  -- FOLYAMATOS, KIHAGYÁS NÉLKÜLI sorszámozásúnak kell lenniük — ez az
  -- egyetlen soros számláló biztosítja ezt (évente újrainduló, "ÉV/sorszám"
  -- formátumban), függetlenül attól, hogy egy fizetés hány tételből áll.
  CREATE TABLE IF NOT EXISTS invoice_counter (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    ev INTEGER NOT NULL,
    utolso_sorszam INTEGER NOT NULL
  );

  -- Regisztrációk — a régi LSZAMLA rendszerből átvett, cégenkénti eszköz-
  -- nyilvántartás (programtípus, verzió, reg./lejárat dátum, kapcsolattartó).
  -- Mivel a forrásadatban nincs explicit "telephely" fogalom, a "reg_sites"
  -- a cím alapján csoportosít — ez egy legjobb-tudás szerinti közelítés,
  -- amit az admin utólag át tud nevezni.
  CREATE TABLE IF NOT EXISTS reg_companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    adoszam TEXT NOT NULL UNIQUE,
    nev TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reg_sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    nev TEXT,
    varos TEXT,
    cim TEXT
  );
  CREATE TABLE IF NOT EXISTS reg_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    uuid TEXT,
    progtip TEXT,
    verzio TEXT,
    regdat TEXT,
    ervdat TEXT,
    email TEXT,
    telefon TEXT,
    kapcsnev TEXT,
    regmodel TEXT,
    regmanufacturer TEXT,
    statusz TEXT,
    szszelotag TEXT,
    legacy_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_reg_sites_company ON reg_sites(company_id);
  CREATE INDEX IF NOT EXISTS idx_reg_devices_site ON reg_devices(site_id);

  -- Általános, webről állítható szerver-beállítások (kulcs -> érték) — ide
  -- kerülnek azok a kapcsolók, amik eddig csak env-változóval, a szerver
  -- konfigurációjában voltak elérhetők, de admin számára a webről kell
  -- tudni kapcsolni őket, szerver-újraindítás/SSH nélkül.
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- ALAP REGISZTRÁLTSÁG — külön, önálló fogalom a funkciónkénti
  -- kapcsolóktól. Ez azt válaszolja meg: fizeti-e a cég egyáltalán az
  -- alap havidíjat? Ha nincs sor egy cégre, ALAPÉRTELMEZETTEN AKTÍV
  -- (egyetlen meglévő cég se essen ki emiatt visszamenőleg) — az admin
  -- explicit kapcsolja ki, ha egy cég nem fizet. Szándékosan NINCS
  -- benne külön "hamarosan lejár" mező vagy késleltetett kikapcsolás —
  -- egyetlen aktív/inaktív kapcsoló, ahogy a fejlesztő kérte (KISS).
  CREATE TABLE IF NOT EXISTS company_subscription (
    ceg_kulcs TEXT PRIMARY KEY,
    aktiv INTEGER NOT NULL DEFAULT 1,
    megjegyzes TEXT,
    proba_vege TEXT,
    proba_kezi INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  -- Cégenként MAGA A CÉG (nem az admin) állítható, üzemeltetési jellegű
  -- beállítások — ide kerül, hogy a Cikktörzs-szerkesztő megkövetelje-e az
  -- NTAK-hoz szükséges kategória-mezőket. Alapból KI van kapcsolva (nem
  -- minden cég NTAK-köteles vendéglátóhely), a cégtulajdonos a Profil
  -- menüpontban egyetlen kapcsolóval be/ki tudja kapcsolni.
  CREATE TABLE IF NOT EXISTS company_settings (
    ceg_kulcs TEXT PRIMARY KEY,
    ntak_aktiv INTEGER NOT NULL DEFAULT 0,
    szamlazasi_iranyitoszam TEXT,
    szamlazasi_telepules TEXT,
    szamlazasi_kozterulet_nev TEXT,
    szamlazasi_kozterulet_jelleg TEXT,
    szamlazasi_hazszam TEXT,
    szamlazasi_emelet TEXT,
    updated_at TEXT NOT NULL
  );

  -- Az ÜGYFELEK saját NAV Online Számla technikai felhasználójának adatai —
  -- ez teszi lehetővé, hogy a cég a SAJÁT (nem a mi) adószámához tartozó
  -- bejövő/kimenő számláit lekérdezhesse. Az érzékeny mezők (jelszó,
  -- aláíró- és cserekulcs) TITKOSÍTVA kerülnek tárolásra (lásd
  -- encryptNavSecret/decryptNavSecret).
  CREATE TABLE IF NOT EXISTS company_nav_credentials (
    ceg_kulcs TEXT PRIMARY KEY,
    nav_taxnumber TEXT NOT NULL,
    nav_tech_user TEXT NOT NULL,
    nav_tech_password_enc TEXT NOT NULL,
    nav_signing_key_enc TEXT NOT NULL,
    nav_exchange_key_enc TEXT NOT NULL,
    nav_sandbox INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );

  -- A tételes (termék/szolgáltatás-szintű) elemzéshez a TELJES számla-
  -- tartalmat le kell kérni (ez számlánként külön NAV-hívás), ezért a
  -- kinyert tételsorokat helyben, gyorsítótárazva tároljuk — egy adott
  -- számlát (cégenként, irányonként) csak EGYSZER kell ténylegesen
  -- lekérdezni a NAV-tól.
  CREATE TABLE IF NOT EXISTS company_nav_invoice_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ceg_kulcs TEXT NOT NULL,
    invoice_direction TEXT NOT NULL,
    invoice_number TEXT NOT NULL,
    invoice_issue_date TEXT,
    partner_name TEXT,
    line_description TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 1,
    unit_of_measure TEXT,
    net_amount REAL NOT NULL DEFAULT 0,
    vat_amount REAL NOT NULL DEFAULT 0,
    gross_amount REAL NOT NULL DEFAULT 0,
    synced_at TEXT NOT NULL,
    UNIQUE(ceg_kulcs, invoice_direction, invoice_number, line_description, quantity, net_amount)
  );
  CREATE INDEX IF NOT EXISTS idx_nav_lines_ceg ON company_nav_invoice_lines(ceg_kulcs, invoice_direction);

  -- Melyik számlákat dolgoztuk már fel (akkor is, ha nulla tételsort
  -- találtunk bennük) — enélkül egy "üres" számlát újra és újra
  -- megpróbálnánk lekérdezni minden szinkronizáláskor.
  CREATE TABLE IF NOT EXISTS company_nav_synced_invoices (
    ceg_kulcs TEXT NOT NULL,
    invoice_direction TEXT NOT NULL,
    invoice_number TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    raw_response_fajlnev TEXT,
    lines_found INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ceg_kulcs, invoice_direction, invoice_number)
  );

  -- CSOMAGOK — egyes funkciók egy néven, egy áron, egyszerre adhatók ki
  -- ("csomagba kerülnek"), míg mások önállóan, külön fizetősek maradnak.
  -- Egy csomag csak egy KÉNYELMI GYŰJTŐNÉV — a tényleges hozzáférés
  -- továbbra is a meglévő company_licenses táblában, funkciónként dől el;
  -- a "csomag kiosztása" csak egyszerre állítja be a benne lévő összes
  -- funkciót ugyanazzal a lejárattal. Ez szándékosan egyszerű (KISS): nincs
  -- külön csomag-szintű előfizetés-nyilvántartás vagy állapotgép.
  CREATE TABLE IF NOT EXISTS license_packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nev TEXT NOT NULL,
    leiras TEXT,
    ar INTEGER NOT NULL DEFAULT 0,
    aktiv INTEGER NOT NULL DEFAULT 1,
    sorrend INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS license_package_features (
    package_id INTEGER NOT NULL,
    feature_key TEXT NOT NULL,
    PRIMARY KEY (package_id, feature_key)
  );
`);
// Migráció — a company_licenses tábla korábban CSAK cégszinten (ceg_kulcs)
// tartotta a kiosztásokat; mostantól telephelyenként is elkülöníthető
// (telephely_kod). Mivel az EGYEDISÉGI megkötés (UNIQUE) is változik
// (ceg_kulcs+feature_key → ceg_kulcs+telephely_kod+feature_key), ez nem
// egyszerű oszlop-hozzáadással oldható meg — a táblát újra kell építeni,
// a MEGLÉVŐ sorokat pedig telephely_kod = NULL értékkel átmásolva, ami azt
// jelenti: "ez a kiosztás a cég MINDEN telephelyére vonatkozik" — tehát a
// már kiosztott funkciók a migráció után is ugyanúgy működnek tovább,
// amíg admin vagy a cég explicit telephely-specifikusra nem állítja.
{
  const cols = licenseDb.prepare(`PRAGMA table_info(company_licenses)`).all();
  if (!cols.some((c) => c.name === 'telephely_kod')) {
    licenseDb.exec(`
      CREATE TABLE company_licenses_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ceg_kulcs TEXT NOT NULL,
        telephely_kod TEXT NOT NULL DEFAULT '',
        feature_key TEXT NOT NULL,
        ar INTEGER NOT NULL DEFAULT 0,
        lejarat TEXT,
        aktiv INTEGER NOT NULL DEFAULT 1,
        jovahagyta TEXT,
        kartya_token TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(ceg_kulcs, telephely_kod, feature_key)
      );
      INSERT INTO company_licenses_new (id, ceg_kulcs, telephely_kod, feature_key, ar, lejarat, aktiv, jovahagyta, updated_at)
        SELECT id, ceg_kulcs, '', feature_key, ar, lejarat, aktiv, jovahagyta, updated_at FROM company_licenses;
      DROP TABLE company_licenses;
      ALTER TABLE company_licenses_new RENAME TO company_licenses;
      CREATE INDEX IF NOT EXISTS idx_company_licenses_ceg ON company_licenses(ceg_kulcs);
    `);
  } else if (!cols.some((c) => c.name === 'kartya_token')) {
    // Egyszerű oszlop-hozzáadás elég, ha a telephely_kod már megvan (a fenti
    // teljes tábla-újraépítés csak akkor kell, ha az UNIQUE megkötés is változik).
    licenseDb.exec(`ALTER TABLE company_licenses ADD COLUMN kartya_token TEXT`);
  }
}
// Migráció — a license_payments táblához új, a telephely-specifikus
// funkció-előfizetésekhez szükséges oszlopok (korábbi telepítéseknél
// hiányozhatnak).
{
  const cols = licenseDb.prepare(`PRAGMA table_info(license_payments)`).all();
  for (const [name, def] of [['telephely_kod', 'TEXT'], ['feature_key', 'TEXT'], ['kartya_token', 'TEXT'], ['ismetlodo', 'INTEGER NOT NULL DEFAULT 0'], ['szamla_sorszam', 'TEXT'], ['szamla_pdf_fajlnev', 'TEXT'], ['nav_transaction_id', 'TEXT'], ['nav_allapot', 'TEXT'], ['nav_uzenet', 'TEXT'], ['nav_retry_count', 'INTEGER NOT NULL DEFAULT 0'], ['nav_raw_response_fajlnev', 'TEXT']]) {
    if (!cols.some((c) => c.name === name)) {
      licenseDb.exec(`ALTER TABLE license_payments ADD COLUMN ${name} ${def}`);
    }
  }
}
// Migráció — a NAV számla-tartalom szinkronizálás diagnosztikai mezői
// (korábbi telepítéseknél hiányozhatnak, ha a tábla már létezett).
{
  const cols = licenseDb.prepare(`PRAGMA table_info(company_nav_synced_invoices)`).all();
  if (cols.length) {
    if (!cols.some((c) => c.name === 'raw_response_fajlnev')) licenseDb.exec(`ALTER TABLE company_nav_synced_invoices ADD COLUMN raw_response_fajlnev TEXT`);
    if (!cols.some((c) => c.name === 'lines_found')) licenseDb.exec(`ALTER TABLE company_nav_synced_invoices ADD COLUMN lines_found INTEGER NOT NULL DEFAULT 0`);
  }
}
// Migráció — a NAV-formátumú, strukturált számlázási cím mezői a
// company_settings táblához (korábbi telepítéseknél hiányozhatnak).
{
  const cols = licenseDb.prepare(`PRAGMA table_info(company_settings)`).all();
  for (const name of ['szamlazasi_iranyitoszam', 'szamlazasi_telepules', 'szamlazasi_kozterulet_nev', 'szamlazasi_kozterulet_jelleg', 'szamlazasi_hazszam', 'szamlazasi_emelet']) {
    if (!cols.some((c) => c.name === name)) {
      licenseDb.exec(`ALTER TABLE company_settings ADD COLUMN ${name} TEXT`);
    }
  }
}
{
  const cols = licenseDb.prepare(`PRAGMA table_info(company_subscription)`).all();
  if (!cols.some((c) => c.name === 'proba_vege')) {
    licenseDb.exec(`ALTER TABLE company_subscription ADD COLUMN proba_vege TEXT`);
  }
  if (!cols.some((c) => c.name === 'proba_kezi')) {
    licenseDb.exec(`ALTER TABLE company_subscription ADD COLUMN proba_kezi INTEGER NOT NULL DEFAULT 0`);
  }
}
{
  const cols = licenseDb.prepare(`PRAGMA table_info(company_devices)`).all();
  for (const [name, def] of [['telephely_kod', 'TEXT'], ['nev', 'TEXT'], ['progtip', 'TEXT'], ['verzio', 'TEXT']]) {
    if (!cols.some((c) => c.name === name)) {
      licenseDb.exec(`ALTER TABLE company_devices ADD COLUMN ${name} ${def}`);
    }
  }
}
// A régi LSZAMLA rendszerből átvett regisztrációs adatok EGYSZERI importja
// — csak akkor fut le, ha a reg_companies tábla még üres (első indításkor,
// vagy ha valaki szándékosan törölte az összeset). Ha az admin utólag
// szerkeszt/töröl egy bejegyzést, ez az import SOHA nem írja felül —
// nem fut le újra, amint egyszer megtörtént.
{
  const already = licenseDb.prepare('SELECT COUNT(*) AS c FROM reg_companies').get().c;
  const seedPath = path.join(__dirname, 'data-seed', 'registrations.json');
  if (already === 0 && fs.existsSync(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    const now = new Date().toISOString();
    const insertCompany = licenseDb.prepare('INSERT INTO reg_companies (adoszam, nev, created_at) VALUES (?, ?, ?)');
    const insertSite = licenseDb.prepare('INSERT INTO reg_sites (company_id, nev, varos, cim) VALUES (?, ?, ?, ?)');
    const insertDevice = licenseDb.prepare(`
      INSERT INTO reg_devices (site_id, uuid, progtip, verzio, regdat, ervdat, email, telefon, kapcsnev, regmodel, regmanufacturer, statusz, szszelotag, legacy_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let companyCount = 0, deviceCount = 0;
    licenseDb.exec('BEGIN');
    try {
      for (const c of seed) {
        const companyResult = insertCompany.run(c.adoszam, c.nev, now);
        const companyId = Number(companyResult.lastInsertRowid);
        companyCount++;
        c.sites.forEach((s, idx) => {
          const siteNev = c.sites.length > 1 ? (s.varos || s.cim || `Telephely ${idx + 1}`) : 'Fő telephely';
          const siteResult = insertSite.run(companyId, siteNev, s.varos || null, s.cim || null);
          const siteId = Number(siteResult.lastInsertRowid);
          for (const d of s.devices) {
            insertDevice.run(
              siteId, d.uuid || null, d.progtip || null, d.verzio || null, d.regdat || null, d.ervdat || null,
              d.email || null, d.telefon || null, d.kapcsnev || null, d.regmodel || null, d.regmanufacturer || null,
              d.statusz || null, d.szszelotag || null, d.legacyId || null, now
            );
            deviceCount++;
          }
        });
      }
      licenseDb.exec('COMMIT');
    } catch (e) {
      licenseDb.exec('ROLLBACK');
      throw e;
    }
    console.log(`[info] Regisztrációk importálva a régi LSZAMLA rendszerből: ${companyCount} cég, ${deviceCount} eszköz.`);
  }
}
// A ténylegesen Androidban hardkódolt, VALÓS funkció-azonosítók listája —
// ez az egyetlen forrás, amit két helyen is használunk: (1) vadonatúj,
// üres telepítésnél automatikus kezdő feltöltéshez, (2) egy már futó,
// meglévő katalógusnál a hiányzó elemek biztonságos, admin által
// kezdeményezett pótlásához (lásd /api/admin/license/features/seed-real).
const REAL_LICENSE_FEATURE_DEFAULTS = [
  ['SZAMLSZEM', 'Számla személyre szabása', '', 0, 0],
  ['NTAK', 'NTAK', '', 0, 1],
  ['EXTNYOMT', 'Konyhai nyomtató', '', 0, 2],
  ['VIRTUO', 'Virtuo fizetés', '', 0, 3],
  ['VISSZAJAROKEZELES', 'Visszajáró kezelése', '', 0, 4],
  ['REPOHAR', 'Repohár', '', 0, 5],
  ['KEPESTERM', 'Képes termék', '', 0, 6],
  ['MERLEGELES', 'Mérlegelés', '', 0, 7],
  ['VONALKOD', 'Vonalkód generálás', '', 0, 8],
  ['PINTEGRACIO', 'PIN integráció', '', 0, 9],
  ['WEBTERMEK', 'Webes termékkezelés', 'Db szinkronizáció.', 0, 10],
  ['WEBTERMARCSI', 'Webes termék fel/letöltés', 'A honlapodra fel/letöltést engedélyezi.', 0, 11],
];
// Első indításkor feltöltjük egy induló katalógussal — ezt az admin
// utólag szabadon szerkesztheti (átnevezheti, árazhatja, kivezetheti,
// újat vehet fel). A kulcsok a ténylegesen Androidban hardkódolt,
// valós azonosítók (nem AI-tipp).
{
  const count = licenseDb.prepare('SELECT COUNT(*) AS c FROM license_features').get().c;
  if (count === 0) {
    const now = new Date().toISOString();
    for (const [key, nev, leiras, alapAr, sorrend] of REAL_LICENSE_FEATURE_DEFAULTS) {
      licenseDb.prepare(
        `INSERT INTO license_features (key, nev, leiras, alap_ar, aktiv, sorrend, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)`
      ).run(key, nev, leiras, alapAr, sorrend, now);
    }
  }

}

// Egyszerű, ékezet- és írásjel-mentes "slug" egy funkció-kulcshoz, a
// megadott névből — csak akkor kell, ha az admin nem ad meg sajátot.
function slugifyFeatureKey(nev) {
  const noAccent = String(nev || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return noAccent.slice(0, 40) || `funkcio_${Date.now()}`;
}

// Egy company_licenses sor "állapotát" (badge) számolja ki.
// EGYSZERŰSÍTVE (az androidos fejlesztő KISS-visszajelzése alapján): csak
// KÉT érdemi állapot van — lejárt vagy érvényes. A korábbi, külön
// "hamarosan lejár (7 napon belül)" köztes állapotot szándékosan
// eltávolítottuk — a lejárat dátuma már önmagában megmutatja ezt, egy
// külön kiszámolt jelző csak felesleges redundancia.
function licenseRowStatus(row) {
  if (!row) return { allapot: 'none', allapotSzoveg: 'nincs regisztráció' };
  if (!row.aktiv) return { allapot: 'expired', allapotSzoveg: 'letiltva' };
  if (row.lejarat) {
    const days = Math.floor((new Date(row.lejarat + 'T00:00:00Z') - new Date(todayIsoServer() + 'T00:00:00Z')) / 86400000);
    if (days < 0) return { allapot: 'expired', allapotSzoveg: 'lejárt' };
  }
  return { allapot: 'ok', allapotSzoveg: 'érvényes' };
}

// Alap regisztráltság lekérdezése — ha nincs sor, alapból AKTÍV (lásd a
// fenti tábla-megjegyzést). Egyszerű, egyetlen igaz/hamis kapcsoló.
function isBaseSubscriptionActive(cegKulcs) {
  const row = licenseDb.prepare('SELECT aktiv FROM company_subscription WHERE ceg_kulcs = ?').get(cegKulcs);
  return !row || !!row.aktiv;
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

// ---------------------------------------------------------------------------
// Jelszó-kezelés (felhasználói szintek: viszonteladó, cégtulajdonos,
// üzletvezető) — scrypt-alapú, sózott hash, csak beépített node:crypto-val,
// nincs hozzá külön npm-függőség.
// ---------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const hashBuffer = Buffer.from(hash, 'hex');
  const testHash = crypto.scryptSync(password, salt, 64);
  return hashBuffer.length === testHash.length && crypto.timingSafeEqual(hashBuffer, testHash);
}
function generateInviteToken() {
  return crypto.randomBytes(32).toString('base64url');
}
const INVITE_VALID_MS = 48 * 60 * 60 * 1000; // 48 óra
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

// ---------------------------------------------------------------------------
// Minimális, FÜGGŐSÉG NÉLKÜLI PDF-generátor — a projekt szándékosan zéró
// külső npm-csomaggal fut, ezért nem használhatunk PDF-könyvtárat. Ez egy
// kézzel összerakott, egyoldalas, szöveges PDF (beépített Helvetica betűvel),
// pont elég egy egyszerű, TÁJÉKOZTATÓ jellegű "számla" (nem hivatalos
// számviteli bizonylat) előállításához.
// FONTOS, ŐSZINTE MEGJEGYZÉS: a PDF beépített Helvetica fontja a standard
// WinAnsi kódolást használja, ami NEM tartalmazza a magyar ő/ű hosszú
// magánhangzókat — ezek "o"/"u"-ra egyszerűsödnek a PDF-ben (lásd
// sanitizePdfText). Minden más ékezet (á é í ó ö ú ü) helyesen jelenik meg.
function sanitizePdfText(s) {
  return String(s ?? '')
    .replace(/ő/g, 'o').replace(/Ő/g, 'O')
    .replace(/ű/g, 'u').replace(/Ű/g, 'U')
    .replace(/[^\x00-\xFF]/g, '?') // minden más, WinAnsi-n kívüli karakter
    .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
// Folyamatos, kihagyás nélküli számla-sorszám — évente újrainduló,
// "ÉV/000001" formátumban. EGYETLEN sorszámot ad minden ténylegesen
// kiküldött demo-számlához (nem tételenként, akkor sem, ha egy fizetés
// több funkciót is tartalmaz).
function nextInvoiceNumber() {
  const ev = new Date().getFullYear();
  const row = licenseDb.prepare(`SELECT ev, utolso_sorszam FROM invoice_counter WHERE id = 1`).get();
  const sorszam = (!row || row.ev !== ev) ? 1 : row.utolso_sorszam + 1;
  licenseDb.prepare(`
    INSERT INTO invoice_counter (id, ev, utolso_sorszam) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET ev = excluded.ev, utolso_sorszam = excluded.utolso_sorszam
  `).run(ev, sorszam);
  return `${ev}/${String(sorszam).padStart(6, '0')}`;
}

// A kötelező számla-adattartalomhoz (Áfa tv. 169. §) az ÁFA-t tételenként
// is fel kell tüntetni. A rendszerben megadott árakat BRUTTÓ (ÁFA-val
// növelt) árnak tekintjük — ez a szokásos gyakorlat végfelhasználóknak
// szánt áraknál —, ebből számoljuk vissza a nettó és az ÁFA összegét.
const ELEKTRONIKUS_SZOLGALTATAS_AFA_KULCS = 0.27; // általános, 27%-os ÁFA-kulcs
function splitBruttoToNettoAfa(brutto, afaKulcs = ELEKTRONIKUS_SZOLGALTATAS_AFA_KULCS) {
  const netto = Math.round(brutto / (1 + afaKulcs));
  const afa = brutto - netto;
  return { netto, afa, brutto, afaSzazalek: Math.round(afaKulcs * 100) };
}

function buildSimplePdf(elements) {
  // elements: kevert lista — { type:'text', text, size, y, x, bold, color:[r,g,b] }
  //                        vagy { type:'rect', x, y, w, h, fill:[r,g,b] }
  //                        vagy { type:'line', x1, y1, x2, y2, color:[r,g,b], width }
  // y mindenhol a lap TETEJÉTŐL lefelé mérve (természetesebb elrendezéshez),
  // a függvény belül számolja át PDF-koordinátára (lentről felfelé).
  const PAGE_H = 842, PAGE_W = 595;
  const toPdfY = (y) => PAGE_H - y;
  const parts = [];
  for (const el of elements) {
    if (el.type === 'rect') {
      const [r, g, b] = el.fill || [0, 0, 0];
      parts.push(`${r} ${g} ${b} rg ${el.x} ${toPdfY(el.y + el.h)} ${el.w} ${el.h} re f`);
    } else if (el.type === 'line') {
      const [r, g, b] = el.color || [0, 0, 0];
      parts.push(`${el.width || 1} w ${r} ${g} ${b} RG ${el.x1} ${toPdfY(el.y1)} m ${el.x2} ${toPdfY(el.y2)} l S`);
    } else {
      const font = el.bold ? '/F2' : '/F1';
      const size = el.size || 11;
      const [r, g, b] = el.color || [0, 0, 0];
      parts.push(`${r} ${g} ${b} rg BT ${font} ${size} Tf ${el.x || 50} ${toPdfY(el.y)} Td (${sanitizePdfText(el.text)}) Tj ET`);
    }
  }
  const content = parts.join('\n');
  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push(`<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents 6 0 R >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const streamBytes = Buffer.from(content, 'latin1');
  objects.push(`<< /Length ${streamBytes.length} >>\nstream\n${content}\nendstream`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

// Egyszerű, tájékoztató jellegű "demo számla" PDF egy sikeres funkció-
// előfizetési díjról. NEM hivatalos, számvitelileg elfogadott bizonylat —
// a kérésnek megfelelően csak egy áttekinthető, letölthető/emailezhető
// összefoglaló, most már rendezettebb, "hivatalos számlaszerű" elrendezéssel.
function buildDemoInvoicePdf({ cegNev, adoszam, cimSzoveg, tetelek, penznem, datum, orderId, szamlaSorszam, ismetlodo }) {
  // Minden tételnél kiszámoljuk a nettó/ÁFA/bruttó bontást — az itt
  // megadott árakat bruttónak (ÁFA-val növeltnek) tekintjük.
  const tetelekBontva = tetelek.map((t) => ({ ...t, ...splitBruttoToNettoAfa(t.osszeg) }));
  const bruttoOsszesen = tetelekBontva.reduce((s, t) => s + t.brutto, 0);
  const nettoOsszesen = tetelekBontva.reduce((s, t) => s + t.netto, 0);
  const afaOsszesen = tetelekBontva.reduce((s, t) => s + t.afa, 0);

  const JADE = [0.35, 0.58, 0.79]; const INK = [0.16, 0.2, 0.28]; const DIM = [0.45, 0.48, 0.53];
  const els = [];
  // Fejléc-sáv
  els.push({ type: 'rect', x: 0, y: 0, w: 595, h: 90, fill: JADE });
  els.push({ type: 'text', x: 50, y: 40, text: 'L-NYUGTA', size: 22, bold: true, color: [1, 1, 1] });
  els.push({ type: 'text', x: 50, y: 62, text: 'Dijbekero / demo szamla', size: 11, color: [1, 1, 1] });
  els.push({ type: 'text', x: 380, y: 32, text: 'Szamla sorszama:', size: 9, color: [1, 1, 1] });
  els.push({ type: 'text', x: 380, y: 46, text: szamlaSorszam, size: 12, bold: true, color: [1, 1, 1] });
  els.push({ type: 'text', x: 380, y: 62, text: `Kibocsatas kelte: ${datum}`, size: 9, color: [1, 1, 1] });
  els.push({ type: 'text', x: 380, y: 76, text: `Teljesites kelte: ${datum}`, size: 9, color: [1, 1, 1] });

  // Kiállító / Vevő, két oszlopban — a kötelező eladói/vevői adatok.
  const infoTop = 130;
  els.push({ type: 'text', x: 50, y: infoTop, text: 'ELADO', size: 9, bold: true, color: DIM });
  els.push({ type: 'text', x: 50, y: infoTop + 16, text: ELADO_NEV, size: 11, bold: true, color: INK });
  els.push({ type: 'text', x: 50, y: infoTop + 31, text: ELADO_CIM, size: 9, color: DIM });
  els.push({ type: 'text', x: 50, y: infoTop + 45, text: `Adoszam: ${ELADO_ADOSZAM}`, size: 9, color: DIM });
  els.push({ type: 'text', x: 50, y: infoTop + 59, text: `Cegjegyzekszam: ${ELADO_CEGJEGYZEKSZAM}`, size: 9, color: DIM });

  els.push({ type: 'text', x: 320, y: infoTop, text: 'VEVO', size: 9, bold: true, color: DIM });
  els.push({ type: 'text', x: 320, y: infoTop + 16, text: cegNev, size: 11, bold: true, color: INK });
  els.push({ type: 'text', x: 320, y: infoTop + 31, text: cimSzoveg || '(nincs megadva szamlazasi cim)', size: 9, color: DIM });
  els.push({ type: 'text', x: 320, y: infoTop + 45, text: `Adoszam: ${adoszam || '-'}`, size: 9, color: DIM });

  els.push({ type: 'line', x1: 50, y1: infoTop + 76, x2: 545, y2: infoTop + 76, color: [0.85, 0.85, 0.85], width: 1 });

  // Tételes rész — megnevezés, mennyiség, nettó egységár, ÁFA%, ÁFA összeg, bruttó.
  const tableTop = infoTop + 100;
  els.push({ type: 'rect', x: 50, y: tableTop - 16, w: 495, h: 22, fill: [0.95, 0.96, 0.97] });
  els.push({ type: 'text', x: 55, y: tableTop, text: 'Megnevezes', size: 8.5, bold: true, color: INK });
  els.push({ type: 'text', x: 245, y: tableTop, text: 'Menny.', size: 8.5, bold: true, color: INK });
  els.push({ type: 'text', x: 280, y: tableTop, text: 'Nettó egys.ar', size: 8.5, bold: true, color: INK });
  els.push({ type: 'text', x: 345, y: tableTop, text: 'AFA%', size: 8.5, bold: true, color: INK });
  els.push({ type: 'text', x: 375, y: tableTop, text: 'AFA osszeg', size: 8.5, bold: true, color: INK });
  els.push({ type: 'text', x: 450, y: tableTop, text: 'Brutto', size: 8.5, bold: true, color: INK });
  let rowY = tableTop + 24;
  for (const t of tetelekBontva) {
    const nevRovidítve = t.nev.length > 32 ? `${t.nev.slice(0, 29)}...` : t.nev;
    els.push({ type: 'text', x: 55, y: rowY, text: nevRovidítve, size: 8.5, color: INK });
    els.push({ type: 'text', x: 245, y: rowY, text: '1 ho', size: 8.5, color: INK });
    els.push({ type: 'text', x: 280, y: rowY, text: `${t.netto.toLocaleString('hu-HU')}`, size: 8.5, color: INK });
    els.push({ type: 'text', x: 345, y: rowY, text: `${t.afaSzazalek}%`, size: 8.5, color: INK });
    els.push({ type: 'text', x: 375, y: rowY, text: `${t.afa.toLocaleString('hu-HU')}`, size: 8.5, color: INK });
    els.push({ type: 'text', x: 450, y: rowY, text: `${t.brutto.toLocaleString('hu-HU')} ${penznem}`, size: 8.5, color: INK });
    els.push({ type: 'line', x1: 50, y1: rowY + 9, x2: 545, y2: rowY + 9, color: [0.92, 0.92, 0.92], width: 0.5 });
    rowY += 22;
  }
  rowY += 8;
  els.push({ type: 'line', x1: 50, y1: rowY, x2: 545, y2: rowY, color: INK, width: 1.2 });
  rowY += 18;
  els.push({ type: 'text', x: 280, y: rowY, text: `Netto osszesen: ${nettoOsszesen.toLocaleString('hu-HU')} ${penznem}`, size: 9, color: DIM });
  rowY += 15;
  els.push({ type: 'text', x: 280, y: rowY, text: `AFA osszesen (${ELEKTRONIKUS_SZOLGALTATAS_AFA_KULCS * 100}%): ${afaOsszesen.toLocaleString('hu-HU')} ${penznem}`, size: 9, color: DIM });
  rowY += 20;
  els.push({ type: 'text', x: 280, y: rowY, text: 'Fizetendo (brutto)', size: 12, bold: true, color: INK });
  els.push({ type: 'text', x: 450, y: rowY, text: `${bruttoOsszesen.toLocaleString('hu-HU')} ${penznem}`, size: 13, bold: true, color: JADE });

  rowY += 34;
  els.push({ type: 'rect', x: 50, y: rowY, w: 495, h: 46, fill: [0.98, 0.95, 0.88] });
  els.push({
    type: 'text', x: 60, y: rowY + 18, size: 9.5, color: [0.54, 0.35, 0.08],
    text: ismetlodo
      ? 'Ismetlodo, havi elofizetesi dij - a kovetkezo terheles kb. 1 honap mulva esedekes.'
      : 'Kezdeti elofizetesi dij - a szolgaltatas mostantol havonta automatikusan megujul.',
  });
  els.push({ type: 'text', x: 60, y: rowY + 34, text: `Fizetesi mod: demo fizetes (nincs valodi bankkartya-terheles). Belso azonosito: ${orderId}`, size: 8.5, color: [0.54, 0.35, 0.08] });

  els.push({ type: 'text', x: 50, y: 800, text: '(A funkcio-elofizetes demo/tajekoztato jellegu; a tenyleges, valodi bankkartya-terheles bevezeteseig ez a bizonylat is annak minosul.)', size: 7.5, color: DIM });
  return buildSimplePdf(els);
}

const INVOICES_DIR = path.join(DATA_DIR, 'invoices');
if (!fs.existsSync(INVOICES_DIR)) fs.mkdirSync(INVOICES_DIR, { recursive: true });
const NAV_RESPONSES_DIR = path.join(DATA_DIR, 'nav-responses');
if (!fs.existsSync(NAV_RESPONSES_DIR)) fs.mkdirSync(NAV_RESPONSES_DIR, { recursive: true });

// A NAV-tól kapott NYERS XML-válaszok lemezre mentése — átláthatóság és
// hibaelhárítás céljából mindent megőrzünk, ami a NAV-tól visszajön
// (sikeres és sikertelen próbálkozásoknál egyaránt), nem csak a rövid,
// szűrt hibaüzenetet.
function saveNavRawResponse(szamlaSorszamVagyId, muvelet, xmlText) {
  const safeName = String(szamlaSorszamVagyId).replace(/[^a-zA-Z0-9.\-]/g, '_');
  const fajlnev = `${safeName}_${muvelet}_${Date.now()}.xml`;
  fs.writeFileSync(path.join(NAV_RESPONSES_DIR, fajlnev), xmlText, 'utf8');
  return fajlnev;
}

// A számla ELŐÁLLÍTÁSA és LEMEZRE MENTÉSE mindig megtörténik, amint egy
// fizetés sikeres — FÜGGETLENÜL attól, hogy van-e beállított email cím a
// cégnél. Ez egy üzleti nyilvántartási követelmény (a bizonylatnak léteznie
// kell), nem szabad, hogy egy hiányzó email-cím miatt egyáltalán ne
// készüljön el a számla. Az emailben történő KIKÜLDÉS ettől független,
// külön, hibatűrő lépés (lásd sendDemoInvoiceEmail lejjebb).
async function generateAndStoreInvoice({ cegKulcs, tetelek, penznem, orderId, ismetlodo }) {
  const anySite = [...companyIndex.values()].find((e) => e.cegKulcs === cegKulcs);
  const cegNev = anySite?.nev || cegKulcs;
  const adoszam = anySite?.adoszam || '';
  const datum = todayIsoServer();
  const billingRow = licenseDb.prepare(`SELECT * FROM company_settings WHERE ceg_kulcs = ?`).get(cegKulcs);
  const cimReszletek = billingRow ? {
    iranyitoszam: billingRow.szamlazasi_iranyitoszam, telepules: billingRow.szamlazasi_telepules,
    kozteruletNev: billingRow.szamlazasi_kozterulet_nev, kozteruletJelleg: billingRow.szamlazasi_kozterulet_jelleg,
    hazszam: billingRow.szamlazasi_hazszam, emelet: billingRow.szamlazasi_emelet,
  } : {};
  const cimSzoveg = billingRow ? formatNavAddress(cimReszletek) : '';
  const szamlaSorszam = nextInvoiceNumber();
  const pdf = buildDemoInvoicePdf({ cegNev, adoszam, cimSzoveg, tetelek, penznem, datum, orderId, szamlaSorszam, ismetlodo });
  const fajlnev = `${szamlaSorszam.replace('/', '-')}.pdf`;
  fs.writeFileSync(path.join(INVOICES_DIR, fajlnev), pdf);
  try {
    licenseDb.prepare(`UPDATE license_payments SET szamla_sorszam = ?, szamla_pdf_fajlnev = ? WHERE order_id = ? OR order_id LIKE ?`)
      .run(szamlaSorszam, fajlnev, orderId, `${orderId}-%`);
  } catch (_) {}
  logActivity({ type: 'invoice_created', ok: true, companyKey: cegKulcs, nev: null, detail: `Számla előállítva: ${szamlaSorszam} (${orderId})` });

  // A NAV Online Számla adatszolgáltatás — SOHA nem akaszthatja meg a
  // számla PDF-jének elkészültét/eltárolását, ezért teljesen külön,
  // hibatűrő lépésként fut, csak akkor, ha a NAV-kapcsolat be van állítva.
  if (navConfigured() && adoszam) {
    await attemptNavSubmission({ cegKulcs, szamlaSorszam, datum, cegNev, adoszam, cimReszletek, tetelek, penznem, incrementRetry: false });
  }

  return { szamlaSorszam, fajlnev, pdf, cegNev, adoszam };
}

// Egyetlen, közös, ÚJRAHASZNOSÍTHATÓ NAV-beküldési logika — ugyanezt hívja
// a fizetés utáni automatikus beküldés, a manuális "Újraküldés" gomb ÉS
// az automatikus háttér-újrapróbálkozási ciklus is. Minden esetben menti
// a nyers NAV-választ (siker és hiba esetén egyaránt), hogy bármikor
// visszanézhető legyen.
async function attemptNavSubmission({ cegKulcs, szamlaSorszam, datum, cegNev, adoszam, cimReszletek, tetelek, penznem, incrementRetry }) {
  const retrySql = incrementRetry ? 'nav_retry_count = nav_retry_count + 1,' : '';

  if (!navAddressComplete(cimReszletek)) {
    licenseDb.prepare(`UPDATE license_payments SET nav_allapot = 'HIÁNYZÓ_CÍM', nav_uzenet = ?, ${retrySql} nav_transaction_id = nav_transaction_id WHERE szamla_sorszam = ?`)
      .run('A cég számlázási címe hiányos (irányítószám/település/közterület neve/házszám) — a NAV garantáltan elutasítaná, ezért a beküldés meg sem történt. Töltsd ki a cég Profil oldalán a "Számlázási cím" mezőket.', szamlaSorszam);
    logActivity({ type: 'nav_invoice_submit', ok: false, companyKey: cegKulcs, nev: null, detail: `NAV-beküldés kihagyva (${szamlaSorszam}): hiányos számlázási cím` });
    return { ok: false };
  }

  // A vevő adószámának előzetes érvényesség-ellenőrzése (a NAV saját
  // ajánlása, 23. pont) — ha egyértelműen érvénytelen, nem próbálkozunk
  // garantáltan elutasított beküldéssel. Ha maga az ELLENŐRZÉS hibázik
  // (pl. a NAV pillanatnyilag nem elérhető), ez NEM blokkolja a normál
  // beküldési kísérletet — csak akkor térünk el, ha KIFEJEZETTEN
  // "érvénytelen"-nek minősítette a NAV az adószámot.
  let adoszamErvenytelen = false;
  try {
    const taxpayerCheck = await navQueryTaxpayer(adoszam);
    if (!taxpayerCheck.valid) adoszamErvenytelen = true;
  } catch (_) { /* a normál beküldési próbálkozásra esünk vissza */ }

  if (adoszamErvenytelen) {
    licenseDb.prepare(`UPDATE license_payments SET nav_allapot = 'ÉRVÉNYTELEN_VEVŐ_ADÓSZÁM', nav_uzenet = ?, ${retrySql} nav_transaction_id = nav_transaction_id WHERE szamla_sorszam = ?`)
      .run(`A vevő adószáma (${adoszam}) nem szerepel érvényesként a NAV nyilvántartásában — a beküldés meg sem történt.`, szamlaSorszam);
    logActivity({ type: 'nav_invoice_submit', ok: false, companyKey: cegKulcs, nev: null, detail: `NAV-beküldés kihagyva (${szamlaSorszam}): érvénytelen vevő adószám (${adoszam})` });
    return { ok: false };
  }

  try {
    const { transactionId, raw } = await navSubmitDemoInvoice({ szamlaSorszam, datum, cegNev, adoszam, cimReszletek, tetelek, penznem });
    const fajlnev = saveNavRawResponse(szamlaSorszam, 'submit', raw);
    licenseDb.prepare(`UPDATE license_payments SET nav_transaction_id = ?, nav_allapot = 'BEKULDVE', nav_raw_response_fajlnev = ?, ${retrySql} nav_uzenet = NULL WHERE szamla_sorszam = ?`)
      .run(transactionId, fajlnev, szamlaSorszam);
    logActivity({ type: 'nav_invoice_submit', ok: true, companyKey: cegKulcs, nev: null, detail: `NAV-nak beküldve: ${szamlaSorszam} (tranzakció: ${transactionId})` });
    return { ok: true, transactionId };
  } catch (e) {
    const fajlnev = e.navRawResponse ? saveNavRawResponse(szamlaSorszam, 'submit-error', e.navRawResponse) : null;
    licenseDb.prepare(`UPDATE license_payments SET nav_allapot = 'HIBA', nav_uzenet = ?, nav_raw_response_fajlnev = COALESCE(?, nav_raw_response_fajlnev), ${retrySql} nav_transaction_id = nav_transaction_id WHERE szamla_sorszam = ?`)
      .run(e.message, fajlnev, szamlaSorszam);
    logActivity({ type: 'nav_invoice_submit', ok: false, companyKey: cegKulcs, nev: null, detail: `NAV beküldési hiba (${szamlaSorszam}): ${e.message}` });
    return { ok: false, error: e.message };
  }
}

async function sendDemoInvoiceEmail({ cegKulcs, tetelek, penznem, orderId, ismetlodo }) {
  const { szamlaSorszam, pdf, cegNev } = await generateAndStoreInvoice({ cegKulcs, tetelek, penznem, orderId, ismetlodo });

  const codes = readAccessCodes();
  let email = codes[cegKulcs]?.email || '';
  // Ha az access-codes.json-ban nincs email, próbáljuk a cég saját,
  // szinkronizált adatbázisában tárolt címet (ugyanaz a tartalék-logika,
  // amit az admin cégek-lista is használ).
  if (!email) {
    for (const [siteKey, entry] of companyIndex.entries()) {
      if (entry.cegKulcs !== cegKulcs) continue;
      try {
        const row = get(siteKey, 'SELECT email FROM szallitot LIMIT 1');
        if (row?.email) { email = row.email; break; }
      } catch (_) {}
    }
  }
  if (!email) throw new Error(`A számla (${szamlaSorszam}) elkészült és eltárolva, de nincs beállított email cím ehhez a céghez — nem lehetett kiküldeni.`);

  const osszesen = tetelek.reduce((s, t) => s + t.osszeg, 0);
  const tetelSorokHtml = tetelek.map((t) => `<li>${escapeHtmlForEmail(t.nev)} — ${t.osszeg.toLocaleString('hu-HU')} ${penznem}</li>`).join('');
  await sendBrevoEmail({
    toEmail: email, toName: cegNev,
    subject: `L-NYUGTA — számla ${szamlaSorszam}`,
    html: `<p>Kedves ${escapeHtmlForEmail(cegNev)}!</p>
      <p>Sikeres fizetés történt:</p>
      <ul>${tetelSorokHtml}</ul>
      <p><b>Összesen: ${osszesen.toLocaleString('hu-HU')} ${penznem}</b></p>
      <p>A tájékoztató jellegű demo számlát csatoltan küldjük.</p>
      <p style="color:#888;font-size:12px;">Ez egy automatikus üzenet, nem hivatalos számviteli bizonylatról.</p>`,
    attachments: [{ name: `szamla-${szamlaSorszam.replace('/', '-')}.pdf`, content: pdf }],
  });
  logActivity({ type: 'payment_invoice_email', ok: true, companyKey: cegKulcs, nev: null, detail: `Demo számla kiküldve: ${email} (${orderId})` });
}
function escapeHtmlForEmail(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendBrevoEmail({ toEmail, toName, subject, html, attachments }) {
  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
    throw new Error('Nincs beállítva a Brevo email küldés (BREVO_API_KEY / BREVO_SENDER_EMAIL hiányzik).');
  }
  const body = {
    sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
    to: [{ email: toEmail, name: toName || undefined }],
    subject,
    htmlContent: html,
  };
  if (attachments && attachments.length) {
    body.attachment = attachments.map((a) => ({ name: a.name, content: a.content.toString('base64') }));
  }
  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let detail = await resp.text();
    try { detail = JSON.parse(detail).message || detail; } catch (_) {}
    throw new Error(`Brevo hiba (${resp.status}): ${detail}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// Felhasználói meghívók — viszonteladó, cégtulajdonos, üzletvezető.
// A meghívott egy kattintható linket kap emailben, amire saját maga állítja
// be a jelszavát — SENKI MÁS (még a meghívó sem) nem ismeri/kezeli a
// jelszót, ez szándékos biztonsági döntés.
// ---------------------------------------------------------------------------
const ROLE_LABELS = { reseller: 'viszonteladói', owner: 'cégtulajdonosi', manager: 'üzletvezetői' };

function createInvite({ email, nev, role, cegKulcs, telephelyKod, resellerId, invitedBy }) {
  email = String(email || '').trim().toLowerCase();
  nev = String(nev || '').trim();
  if (!email || !email.includes('@')) throw new Error('Érvénytelen email cím.');
  const existing = usersDb.prepare('SELECT id, status FROM users WHERE email = ?').get(email);
  if (existing && existing.status === 'active') throw new Error('Ezzel az email címmel már van aktív fiók.');
  const token = generateInviteToken();
  const expires = new Date(Date.now() + INVITE_VALID_MS).toISOString();
  if (existing) {
    usersDb.prepare(
      `UPDATE users SET role=?, ceg_kulcs=?, telephely_kod=?, reseller_id=?, nev=?, invited_by=?, invite_token=?, invite_expires=?, status='pending' WHERE id=?`
    ).run(role, cegKulcs || null, telephelyKod || null, resellerId || null, nev, invitedBy, token, expires, existing.id);
  } else {
    usersDb.prepare(
      `INSERT INTO users (email, role, ceg_kulcs, telephely_kod, reseller_id, nev, invited_by, invite_token, invite_expires, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(email, role, cegKulcs || null, telephelyKod || null, resellerId || null, nev, invitedBy, token, expires, new Date().toISOString());
  }
  return token;
}

function buildInviteLink(req, token) {
  const baseUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  return `${baseUrl}/?meghivo=${token}`;
}

async function sendInviteEmail(link, { email, nev, role, adoszam, cegNev }) {
  const roleLabel = ROLE_LABELS[role] || '';
  const nevSafe = nev ? escapeHtmlServer(nev) : '';
  const greeting = nevSafe ? `Kedves ${nevSafe}!` : 'Kedves Leendő Felhasználónk!';
  const cegSor = adoszam
    ? `<p style="margin:14px 0;padding:10px 14px;background:#EAF3FB;border-radius:8px;">
         <b>Cég adószáma:</b> ${escapeHtmlServer(adoszam)}${cegNev ? ` — ${escapeHtmlServer(cegNev)}` : ''}
       </p>`
    : '';
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#1E3247;line-height:1.6;">
      <p>${greeting}</p>
      <p>Meghívást kaptál az L-NYUGTA rendszerbe, ${roleLabel} jogosultsággal.</p>
      ${cegSor}
      <p>A fiókod aktiválásához kattints az alábbi linkre — ott tudod megadni a
         neved, telefonszámod és az új jelszavad (48 óráig érvényes):</p>
      <p style="margin:20px 0;"><a href="${link}" style="background:#5A93C9;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Meghívó elfogadása</a></p>
      <p style="color:#6C8299;font-size:12.5px;">Ha nem te kérted ezt a meghívót, kérjük hagyd figyelmen kívül.</p>
    </div>`;
  await sendBrevoEmail({ toEmail: email, toName: nev || email, subject: 'L-NYUGTA — meghívó', html });
}

// ---------------------------------------------------------------------------
// Apró segédfüggvények — session token (HMAC-aláírt, cookie-ban tárolt)
// ---------------------------------------------------------------------------

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

function signSession(payload) {
  // Minden tokenhez egyedi azonosító (jti) — ez teszi lehetővé, hogy
  // kijelentkezéskor VALÓBAN, szerver-oldalon is érvényteleníthető
  // legyen, ne csak a böngésző felejtse el.
  const withJti = { ...payload, jti: payload.jti || crypto.randomBytes(12).toString('hex') };
  const body = b64url(JSON.stringify(withJti));
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
    if (payload.jti && isSessionRevoked(payload.jti)) return null;
    return payload;
  } catch (_) { return null; }
}
function isSessionRevoked(jti) {
  return !!usersDb.prepare('SELECT 1 FROM revoked_sessions WHERE jti = ?').get(jti);
}
function revokeSession(token) {
  if (!token || !token.includes('.')) return;
  try {
    const [body] = token.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.jti || !payload.exp) return;
    // Alkalomszerű takarítás — a már úgyis lejárt bejegyzéseket
    // eltávolítjuk, hogy a tábla ne nőjön a végtelenségig.
    usersDb.prepare('DELETE FROM revoked_sessions WHERE expires_at < ?').run(Date.now());
    usersDb.prepare('INSERT OR IGNORE INTO revoked_sessions (jti, revoked_at, expires_at) VALUES (?, ?, ?)')
      .run(payload.jti, new Date().toISOString(), payload.exp);
  } catch (_) { /* rosszul formázott token — nincs mit visszavonni */ }
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

// ---------------------------------------------------------------------------
// IT biztonsági segédfüggvények: valódi kliens-IP (reverse proxy mögött),
// időzítés-biztos összehasonlítás, bejelentkezési rate-limit, biztonsági
// HTTP-fejlécek.
// ---------------------------------------------------------------------------

// Az Apache reverse proxy mögött a req.socket.remoteAddress MINDIG a proxy
// saját (loopback) címét adná vissza — ez a valódi kliens IP-jét olvassa ki
// az X-Forwarded-For fejlécből (a lánc első, azaz legelső/eredeti címe).
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Időzítés-biztos string-összehasonlítás (titkok/API-kulcsok/jelszavak
// összevetésére) — eltérő hosszúságnál is kb. ugyanannyi ideig fut, hogy a
// válaszidőből ne legyen kikövetkeztethető a helyes érték hossza/tartalma.
function timingSafeStringEqual(a, b) {
  const aBuf = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bBuf = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (aBuf.length !== bBuf.length) {
    // Végzünk egy "álló" összehasonlítást is, hogy a hossz-eltérés se legyen
    // gyorsabb/lassabb válaszidőből kitalálható, majd egyértelműen hamis.
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function verifySyncApiKey(apiKey) {
  if (!apiKey) return false;
  return timingSafeStringEqual(apiKey, SECRETS.syncApiKey);
}

// Bejelentkezési rate-limit: max 8 próbálkozás / 10 perc ablakonként,
// utána 10 perces zárolás — IP + azonosító (email vagy 'admin') kulcs szerint.
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 8;
const RATE_LIMIT_LOCKOUT_MS = 10 * 60 * 1000;
const loginAttempts = new Map(); // "ip::identifier" -> { count, windowStart, lockedUntil }

function loginRateLimitKey(ip, identifier) {
  return `${ip}::${String(identifier || '').toLowerCase()}`;
}

// Visszaadja, hogy szabad-e most próbálkozni; ha nem, meddig kell várni.
function checkLoginRateLimit(ip, identifier) {
  const key = loginRateLimitKey(ip, identifier);
  const entry = loginAttempts.get(key);
  const now = Date.now();
  if (entry && entry.lockedUntil && now < entry.lockedUntil) {
    return { allowed: false, retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  return { allowed: true };
}

// Sikertelen/sikeres bejelentkezési kísérlet rögzítése. Siker esetén törli a
// számlálót; sikertelen esetén növeli, és a küszöb elérésekor zárol.
function recordLoginAttempt(ip, identifier, success) {
  const key = loginRateLimitKey(ip, identifier);
  const now = Date.now();
  if (success) { loginAttempts.delete(key); return; }
  let entry = loginAttempts.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now, lockedUntil: 0 };
  }
  entry.count += 1;
  if (entry.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    entry.lockedUntil = now + RATE_LIMIT_LOCKOUT_MS;
  }
  loginAttempts.set(key, entry);
}

// Óránkénti takarítás, hogy a memóriában ne gyűljenek a régen lejárt bejegyzések.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts.entries()) {
    const windowExpired = now - entry.windowStart > RATE_LIMIT_WINDOW_MS;
    const lockExpired = !entry.lockedUntil || now > entry.lockedUntil;
    if (windowExpired && lockExpired) loginAttempts.delete(key);
  }
}, 60 * 60 * 1000).unref();

function sendRateLimited(res, retryAfterSeconds) {
  sendJson(res, 429, { error: 'Túl sok sikertelen bejelentkezési kísérlet. Próbáld újra később.', retryAfterSeconds }, { 'Retry-After': String(retryAfterSeconds) });
}

// ---------------------------------------------------------------------------
// ÁLTALÁNOS, újrahasznosítható sebesség-korlátozó — bármilyen érzékeny
// végponthoz (email küldés, feltöltés, stb.), nem csak bejelentkezéshez.
// Minden hívás egyszerre ELLENŐRIZ és RÖGZÍT is (a bejelentkezéssel
// ellentétben itt nincs "sikeres próbálkozás törli a számlálót" logika —
// egy jelszó-visszaállítási KÉRÉS attól még számít a korlátba, hogy
// egyébként létező email címre irányult-e).
// ---------------------------------------------------------------------------
const genericRateLimits = new Map(); // "bucket::key" -> { count, windowStart }
function checkGenericRateLimit(bucket, key, maxAttempts, windowMs) {
  const mapKey = `${bucket}::${key}`;
  const now = Date.now();
  let entry = genericRateLimits.get(mapKey);
  if (!entry || now - entry.windowStart > windowMs) {
    entry = { count: 0, windowStart: now };
  }
  entry.count += 1;
  genericRateLimits.set(mapKey, entry);
  if (entry.count > maxAttempts) {
    return { allowed: false, retryAfterSeconds: Math.ceil((entry.windowStart + windowMs - now) / 1000) };
  }
  return { allowed: true };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of genericRateLimits.entries()) {
    if (now - entry.windowStart > 24 * 60 * 60 * 1000) genericRateLimits.delete(key);
  }
}, 60 * 60 * 1000).unref();
function sendGenericRateLimited(res, retryAfterSeconds, message) {
  sendJson(res, 429, { error: message || 'Túl sok próbálkozás. Kérjük, próbáld újra később.', retryAfterSeconds }, { 'Retry-After': String(retryAfterSeconds) });
}

// Globális biztonsági HTTP-fejlécek — minden válaszra rákerülnek, mert a
// kérés-kezelő legelején hívjuk meg (res.setHeader jelen esetben megelőzi és
// összeolvad a későbbi res.writeHead / sendJson hívásokban átadott fejlécekkel).
function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; object-src 'none'; " +
    "base-uri 'self'; frame-ancestors 'none'; form-action 'self' https://mypos.com"
  );
  if (COOKIE_SECURE) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
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

// Szöveges mezők hossz-korlátozása — enélkül bárki (akár csak véletlenül,
// akár szándékosan) tetszőlegesen hosszú szöveget írhatna be minden egyes
// mezőbe, ami adatbázis-duzzadáshoz, illetve az androidos szinkron
// oldalán váratlan hibákhoz vezethet. A kliens-oldali `maxlength` önmagában
// NEM elég, mert egy közvetlen API-hívással megkerülhető — ez itt a
// tényleges, szerver-oldali korlát.
function clampStr(value, maxLen) {
  const s = String(value ?? '').trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

// A myPOS (és általában bármilyen klasszikus HTML-form) POST kéréseket
// "application/x-www-form-urlencoded" formában küldi, nem JSON-t — erre
// külön, egyszerű olvasót kell használni.
async function readFormBody(req) {
  const buf = await readBody(req, 1024 * 1024);
  const params = new URLSearchParams(buf.toString('utf8'));
  const out = {};
  for (const [k, v] of params) out[k] = v;
  return out;
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

// Viszonteladói munkamenet — szintén KÜLÖN cookie-ban (enyreseller).
function requireReseller(req) {
  const cookies = parseCookies(req.headers.cookie);
  const session = verifySession(cookies.enyreseller);
  if (!session || !session.isReseller || !session.resellerId) return null;
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

// ============================================================================
// NAGYKER MODUL — belépési híd (2026-07-24 hozzáadva)
// ============================================================================
// Rövid élettartamú, aláírt token a lnyugta.hu/nagyker modulba való
// átlépéshez, a meglévő enysession (cég-bejelentkezés) alapján. A token
// formátuma szándékosan megegyezik a signSession/verifySession mintával
// (base64url JSON + '.' + HMAC-SHA256), de KÜLÖN, saját titkot használ
// (NAGYKER_BRIDGE_SECRET), hogy a két rendszer közötti csatolás minimális
// legyen — ha ez a titok kompromittálódna, az nem érinti a fő rendszer
// saját session-titkát.
const NAGYKER_BRIDGE_SECRET = process.env.NAGYKER_BRIDGE_SECRET || null;
if (!NAGYKER_BRIDGE_SECRET) {
  console.warn('[nagyker-hid] FIGYELEM: NAGYKER_BRIDGE_SECRET nincs beallitva - a "Nagyker" belepes es a nagyker-szamlazas nem fog mukodni, amig be nem allitod (ugyanazzal az ertekkel a Nagyker szolgaltatason is).');
}

function signNagykerBridgeToken(payload) {
  const withJti = { ...payload, jti: crypto.randomBytes(12).toString('hex') };
  const body = b64url(JSON.stringify(withJti));
  const sig = crypto.createHmac('sha256', NAGYKER_BRIDGE_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// GET /nagyker-belepes — a "Nagyker" menupontra/linkre mutat a feluleten.
// Ellenorzi a meglevo ceg-bejelentkezest (enysession), es ha rendben van,
// egy 2 percig ervenyes, egyszer-hasznalhato tokennel atiranyitja a
// bongeszot a lnyugta.hu/nagyker/token-bejelentkezes route-ra.
route('GET', '/api/nagyker-belepes', async (req, res) => {
  const session = requireAuth(req);
  if (!session || !session.adoszam) {
    res.writeHead(302, { Location: '/' });
    return res.end();
  }
  if (!NAGYKER_BRIDGE_SECRET) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('A Nagyker modul jelenleg nincs bekotve (hianyzo NAGYKER_BRIDGE_SECRET a szerveren).');
  }
  const token = signNagykerBridgeToken({ adoszam: session.adoszam, exp: Date.now() + 2 * 60 * 1000 });
  const baseUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  res.writeHead(302, { Location: `${baseUrl}/nagyker/token-bejelentkezes?t=${encodeURIComponent(token)}` });
  res.end();
});

/* ---------------------------------------------------------------------------
   Kliensoldali (böngésző) hibák fogadása — /api/client-error

   Szándékosan NEM igényel bejelentkezést: a legfontosabb hibák (pl. a
   szkript elszállása a login képernyőn) pont belépés előtt történnek.
   Emiatt viszont szigorúan védjük:
     - max. 8 KB-os body (readBody limit),
     - per-IP rate limit: legfeljebb 10 riport / 10 perc, felette csendben
       eldobjuk (nem 429 — a támadónak ne adjunk visszajelzést),
     - minden mezőt fix hosszra vágunk, csak string-eket fogadunk el,
     - a riport csak a tevékenység-naplóba kerül (admin felületen látszik),
       soha nem értelmezzük/futtatjuk a tartalmát.
--------------------------------------------------------------------------- */
const clientErrorReports = new Map(); // ip -> { count, windowStart }
const CLIENT_ERROR_WINDOW_MS = 10 * 60 * 1000;
const CLIENT_ERROR_MAX_PER_WINDOW = 10;
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of clientErrorReports.entries()) {
    if (now - e.windowStart > CLIENT_ERROR_WINDOW_MS) clientErrorReports.delete(ip);
  }
}, 60 * 60 * 1000).unref();

route('POST', '/api/client-error', async (req, res) => {
  // A kliensnek mindig ok:true-t válaszolunk (kivéve érvénytelen JSON) —
  // a hibariportolás soha nem okozhat további hibát a felhasználónál.
  const ip = getClientIp(req);
  const now = Date.now();
  let entry = clientErrorReports.get(ip);
  if (!entry || now - entry.windowStart > CLIENT_ERROR_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
  }
  entry.count += 1;
  clientErrorReports.set(ip, entry);
  if (entry.count > CLIENT_ERROR_MAX_PER_WINDOW) return sendJson(res, 200, { ok: true });

  let body;
  try { body = JSON.parse(await readBody(req, 8 * 1024)); } catch (_) { return sendJson(res, 400, { error: 'Érvénytelen kérés.' }); }
  const cut = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const msg = cut(body.message, 500);
  if (!msg) return sendJson(res, 200, { ok: true });
  const session = requireAuth(req); // ha épp be van lépve, kössük a céghez
  logActivity({
    type: 'client_error',
    ok: false,
    companyKey: session ? session.companyKey : null,
    nev: session ? session.nev : null,
    detail: `${msg} @ ${cut(body.source, 200)}:${cut(String(body.line || ''), 10)} | url: ${cut(body.url, 200)} | ua: ${cut(req.headers['user-agent'] || '', 200)}${body.stack ? ' | stack: ' + cut(body.stack, 1000) : ''}`,
    ip,
  });
  sendJson(res, 200, { ok: true });
});


// A korábbi, adószám+kód alapú bejelentkezés megszűnt — mostantól minden
// nem-admin felhasználó (cégtulajdonos, üzletvezető) kizárólag egyéni,
// email+jelszó alapú fiókkal léphet be (ld. POST /api/auth/user-login).

route('POST', '/api/auth/logout', async (req, res) => {
  const session = requireAuth(req);
  if (session) logActivity({ type: 'company_logout', ok: true, companyKey: session.companyKey, nev: session.nev, detail: 'Kijelentkezés.' });
  const cookies = parseCookies(req.headers.cookie);
  revokeSession(cookies.enysession);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': `enysession=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${COOKIE_SECURE ? '; Secure' : ''}` });
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
  if (session.role === 'manager') return sendJson(res, 403, { error: 'Üzletvezetőként nem érhetők el más telephelyek.' });
  const meta = readSyncMeta();
  const telephelyek = listTelephelyek(session.cegKulcs).map((t) => {
    const siteKey = makeSiteKey(session.cegKulcs, t.kod);
    const site = companyIndex.get(siteKey);
    return {
      kod: t.kod, nev: t.nev, cim: t.cimSzoveg || (site ? site.cim : ''), cimReszletek: t.cim || null,
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
  if (session.role === 'manager') return sendJson(res, 403, { error: 'Üzletvezetőként nem válthatsz másik telephelyre.' });
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
  const cookie = `enysession=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax${COOKIE_SECURE ? '; Secure' : ''}`;
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
function parseNavAddressBody(body) {
  const iranyitoszam = clampStr(body.iranyitoszam, 10);
  if (iranyitoszam && !/^\d{4}$/.test(iranyitoszam)) throw new Error('Az irányítószám 4 számjegyből áll.');
  return {
    iranyitoszam: iranyitoszam || '',
    telepules: clampStr(body.telepules, 80) || '',
    kozteruletNev: clampStr(body.kozteruletNev, 80) || '',
    kozteruletJelleg: clampStr(body.kozteruletJelleg, 30) || '',
    hazszam: clampStr(body.hazszam, 20) || '',
    emelet: clampStr(body.emelet, 60) || '',
  };
}

route('POST', '/api/telephely/create', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  if (session.role === 'manager') return sendJson(res, 403, { error: 'Üzletvezetőként nem hozhatsz létre új telephelyet.' });
  const body = await readJsonBody(req);
  const kod = normalizeTelephelyKod(body.kod);
  const nev = clampStr(body.nev, 100);
  if (!nev) return sendJson(res, 400, { error: 'A telephely neve kötelező.' });
  let cim;
  try { cim = parseNavAddressBody(body); } catch (e) { return sendJson(res, 400, { error: e.message }); }

  const data = readTelephelyek();
  if (!data[session.cegKulcs]) data[session.cegKulcs] = [];
  if (data[session.cegKulcs].some((t) => t.kod === kod)) {
    return sendJson(res, 400, { error: `Már létezik telephely "${kod}" kóddal — válassz másikat.` });
  }
  data[session.cegKulcs].push({ kod, nev, cim, cimSzoveg: formatNavAddress(cim), letrehozva: new Date().toISOString() });
  writeTelephelyek(data);
  logActivity({ type: 'telephely_create', ok: true, companyKey: session.cegKulcs, nev: session.nev, detail: `Új telephely: ${nev} (${kod})` });
  sendJson(res, 200, { ok: true, kod, nev, cim });
});

// Meglévő telephely nevének/címének szerkesztése (a kód, amivel az
// androidos eszköz azonosítja magát, NEM módosítható itt — az a
// szinkron-azonosítás kulcsa, átnevezés helyett új telephelyt kell
// felvenni, ha tényleg más kód kellene).
route('POST', '/api/telephely/update', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const body = await readJsonBody(req);
  const kod = normalizeTelephelyKod(body.kod);
  if (session.role === 'manager' && kod !== session.telephelyKod) {
    return sendJson(res, 403, { error: 'Üzletvezetőként csak a saját telephelyed adatait szerkesztheted.' });
  }
  const nev = clampStr(body.nev, 100);
  if (!nev) return sendJson(res, 400, { error: 'A telephely neve kötelező.' });
  let cim;
  try { cim = parseNavAddressBody(body); } catch (e) { return sendJson(res, 400, { error: e.message }); }

  const data = readTelephelyek();
  const list = data[session.cegKulcs] || [];
  const t = list.find((x) => x.kod === kod);
  if (!t) return sendJson(res, 404, { error: 'Ismeretlen telephely.' });
  t.nev = nev; t.cim = cim; t.cimSzoveg = formatNavAddress(cim);
  writeTelephelyek(data);
  logActivity({ type: 'telephely_update', ok: true, companyKey: makeSiteKey(session.cegKulcs, kod), nev: session.nev, detail: `Telephely frissítve: ${nev} (${kod})` });
  sendJson(res, 200, { ok: true, kod, nev, cim });
});

// Cég-profil: cégadatok (szinkronizált, csak olvasható), kapcsolattartási
// email és a telephelyek listája egy helyen — a jövőbeli felhasználó- és
// előfizetés-kezelés is ide fog kerülni.
route('GET', '/api/profile', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const site = companyIndex.get(session.companyKey);
  const codes = readAccessCodes();
  const meta = readSyncMeta();
  const telephelyek = listTelephelyek(session.cegKulcs).map((t) => {
    const siteKey = makeSiteKey(session.cegKulcs, t.kod);
    const s = companyIndex.get(siteKey);
    return {
      kod: t.kod, nev: t.nev, cim: t.cimSzoveg || (s ? s.cim : ''), cimReszletek: t.cim || null,
      vanAdat: !!s, aktiv: t.kod === session.telephelyKod,
      utolsoSzinkron: s ? (meta[siteKey]?.lastSync || null) : null,
    };
  });
  sendJson(res, 200, {
    cegNev: site ? site.nev : session.nev,
    adoszam: site ? site.adoszam : session.adoszam,
    varos: site?.varos || '', cim: site?.cim || '',
    email: codes[session.cegKulcs]?.email || '',
    role: session.role || 'owner',
    telephelyek,
  });
});

route('POST', '/api/profile/email', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { email } = await readJsonBody(req);
  const clean = String(email || '').trim();
  if (clean && !clean.includes('@')) return sendJson(res, 400, { error: 'Érvénytelen email cím.' });
  const codes = readAccessCodes();
  codes[session.cegKulcs] = { ...(codes[session.cegKulcs] || {}), email: clean };
  writeAccessCodes(codes);
  logActivity({ type: 'profile_email_update', ok: true, companyKey: session.companyKey, nev: session.nev, detail: clean || '(törölve)' });
  sendJson(res, 200, { ok: true, email: clean });
});

// ---------------------------------------------------------------------------
// Meghívó elfogadása — NYILVÁNOS végpontok (token-alapú, nem igényel
// bejelentkezést, hiszen a fiók pontosan itt jön létre).
// ---------------------------------------------------------------------------
route('GET', '/api/invite/info', async (req, res, query) => {
  const token = String(query.token || '');
  if (!token) return sendJson(res, 400, { error: 'Hiányzó meghívó-token.' });
  const u = usersDb.prepare(`SELECT email, nev, role, ceg_kulcs, invite_expires, status FROM users WHERE invite_token = ?`).get(token);
  if (!u) return sendJson(res, 404, { error: 'Érvénytelen vagy már felhasznált meghívó.' });
  if (u.status !== 'pending') return sendJson(res, 400, { error: 'Ez a meghívó már fel lett használva.' });
  if (new Date(u.invite_expires) < new Date()) return sendJson(res, 400, { error: 'Ez a meghívó lejárt — kérj egy újat.' });
  let cegNev = null, adoszam = null;
  if (u.ceg_kulcs) {
    const anySite = [...companyIndex.values()].find((e) => e.cegKulcs === u.ceg_kulcs);
    cegNev = anySite?.nev || null;
    adoszam = anySite?.adoszam || u.ceg_kulcs;
  }
  sendJson(res, 200, { email: u.email, nev: u.nev, role: u.role, roleLabel: ROLE_LABELS[u.role] || u.role, cegNev, adoszam });
});

route('POST', '/api/invite/accept', async (req, res) => {
  const { token, nev, telefon, password, gdprAccepted, aszfAccepted } = await readJsonBody(req);
  if (!token) return sendJson(res, 400, { error: 'Hiányzó meghívó-token.' });
  const cleanNev = clampStr(nev, 100);
  const cleanTelefon = clampStr(telefon, 30);
  if (!cleanNev) return sendJson(res, 400, { error: 'A név megadása kötelező.' });
  if (!cleanTelefon) return sendJson(res, 400, { error: 'A telefonszám megadása kötelező.' });
  if (!password || String(password).length < 8) return sendJson(res, 400, { error: 'A jelszónak legalább 8 karakter hosszúnak kell lennie.' });
  if (!gdprAccepted) return sendJson(res, 400, { error: 'Az adatkezelési tájékoztató elfogadása kötelező.' });
  if (!aszfAccepted) return sendJson(res, 400, { error: 'Az Általános Szerződési Feltételek elfogadása kötelező.' });
  const u = usersDb.prepare(`SELECT id, email, nev, role, invite_expires, status FROM users WHERE invite_token = ?`).get(token);
  if (!u) return sendJson(res, 404, { error: 'Érvénytelen vagy már felhasznált meghívó.' });
  if (u.status !== 'pending') return sendJson(res, 400, { error: 'Ez a meghívó már fel lett használva.' });
  if (new Date(u.invite_expires) < new Date()) return sendJson(res, 400, { error: 'Ez a meghívó lejárt — kérj egy újat.' });
  const now = new Date().toISOString();
  usersDb.prepare(`
    UPDATE users SET nev = ?, telefon = ?, password_hash = ?, status = 'active',
      gdpr_elfogadva = ?, aszf_elfogadva = ?, invite_token = NULL, invite_expires = NULL
    WHERE id = ?
  `).run(cleanNev, cleanTelefon, hashPassword(String(password)), now, now, u.id);
  logActivity({ type: 'user_invite_accepted', ok: true, companyKey: null, nev: cleanNev, detail: `${u.email} (${u.role}) aktiválta a fiókját.` });
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------------------
// Elfelejtett jelszó — cégtulajdonos, üzletvezető és viszonteladó fiókokra
// egyaránt (az admin jelszava egy külön, megosztott jelszó, nincs hozzá
// email-fiók, arra ez nem vonatkozik). UGYANAZT a token-mechanizmust
// használja, mint a meghívó-elfogadás (invite_token/invite_expires), hogy
// ne kelljen külön táblát/logikát fenntartani.
// ---------------------------------------------------------------------------
async function sendPasswordResetEmail(link, { email, nev }) {
  const nevSafe = escapeHtmlServer(nev);
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#1E3247;line-height:1.6;">
      <p>Kedves ${nevSafe}!</p>
      <p>Jelszó-visszaállítást kértél az L-NYUGTA rendszerben.</p>
      <p>Az új jelszavad beállításához kattints az alábbi linkre (2 óráig érvényes):</p>
      <p style="margin:20px 0;"><a href="${link}" style="background:#5A93C9;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Új jelszó beállítása</a></p>
      <p style="color:#6C8299;font-size:12.5px;">Ha nem te kérted, nyugodtan hagyd figyelmen kívül ezt az e-mailt — a jelszavad nem változik, amíg nem kattintasz a linkre.</p>
    </div>`;
  await sendBrevoEmail({ toEmail: email, toName: nev, subject: 'L-NYUGTA — jelszó visszaállítása', html });
}

// A válasz SZÁNDÉKOSAN mindig ugyanaz, függetlenül attól, hogy létezik-e a
// megadott email cím — enélkül a végpont felhasználható lenne annak
// kitalálására, mely email címekhez tartozik fiók.
route('POST', '/api/auth/forgot-password', async (req, res) => {
  const { email } = await readJsonBody(req);
  const clean = String(email || '').trim().toLowerCase();
  const GENERIC_MSG = 'Ha ehhez az email címhez tartozik aktív fiók, hamarosan kapsz egy levelet a jelszó-visszaállításhoz.';

  // Sebesség-korlátozás — KRITIKUS, mert ez a végpont ténylegesen emailt
  // küld: enélkül bárki tömegesen tudná spamelni akár a saját
  // felhasználóinkat, akár a Brevo email-küldési keretünket kimeríteni.
  // Kettős védelem: (1) egy adott IP-ről összesen, akármilyen email
  // címekkel próbálkozva is; (2) egy adott email címre célzottan.
  const ip = getClientIp(req);
  const ipLimit = checkGenericRateLimit('forgot-pw-ip', ip, 10, 15 * 60 * 1000);
  if (!ipLimit.allowed) return sendGenericRateLimited(res, ipLimit.retryAfterSeconds);
  if (clean) {
    const emailLimit = checkGenericRateLimit('forgot-pw-email', clean, 3, 15 * 60 * 1000);
    if (!emailLimit.allowed) return sendJson(res, 200, { ok: true, message: GENERIC_MSG }); // ne áruljuk el a korlátozást magának a célzott címnek
  }

  if (!clean) return sendJson(res, 200, { ok: true, message: GENERIC_MSG });

  const u = usersDb.prepare(`SELECT id, email, nev, role, status FROM users WHERE email = ? AND role IN ('owner','manager','reseller')`).get(clean);
  if (u && u.status === 'active') {
    const token = crypto.randomBytes(24).toString('hex');
    const expires = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2 óra
    usersDb.prepare(`UPDATE users SET invite_token = ?, invite_expires = ? WHERE id = ?`).run(token, expires, u.id);
    const link = `${(req.headers['x-forwarded-proto'] || 'http')}://${req.headers.host}/?jelszo-visszaallitas=${token}`;
    try {
      await sendPasswordResetEmail(link, { email: u.email, nev: u.nev });
      logActivity({ type: 'password_reset_requested', ok: true, companyKey: null, nev: u.nev, detail: `Jelszó-visszaállító email elküldve: ${u.email}` });
    } catch (e) {
      // Ha nincs beállítva Brevo (vagy hibázik a küldés), a linket SOHA nem
      // adjuk vissza közvetlenül a kérelmezőnek (ez lehetővé tenné, hogy
      // valaki más fiókját vegye át) — csak a szerver naplójába/tevékenység-
      // naplóba kerül, hogy az admin manuálisan tudja továbbítani, ha kell.
      console.warn(`[jelszó-visszaállítás] Email küldés sikertelen (${u.email}) — a link: ${link}`);
      logActivity({ type: 'password_reset_requested', ok: false, companyKey: null, nev: u.nev, detail: `Email küldés sikertelen ${u.email} részére — a link a szerver naplójában.` });
    }
  }
  sendJson(res, 200, { ok: true, message: GENERIC_MSG });
});

route('GET', '/api/auth/reset-password/check', async (req, res, query) => {
  const token = String(query.token || '');
  const u = usersDb.prepare(`SELECT nev, invite_expires, status FROM users WHERE invite_token = ?`).get(token);
  if (!u || u.status === 'disabled') return sendJson(res, 404, { error: 'Érvénytelen vagy már felhasznált link.' });
  if (new Date(u.invite_expires) < new Date()) return sendJson(res, 400, { error: 'Ez a link lejárt — kérj egy újat.' });
  sendJson(res, 200, { ok: true, nev: u.nev });
});

route('POST', '/api/auth/reset-password', async (req, res) => {
  const { token, password } = await readJsonBody(req);
  if (!token) return sendJson(res, 400, { error: 'Hiányzó token.' });
  if (!password || String(password).length < 8) return sendJson(res, 400, { error: 'A jelszónak legalább 8 karakter hosszúnak kell lennie.' });
  const u = usersDb.prepare(`SELECT id, email, nev, invite_expires, status FROM users WHERE invite_token = ?`).get(token);
  if (!u || u.status === 'disabled') return sendJson(res, 404, { error: 'Érvénytelen vagy már felhasznált link.' });
  if (new Date(u.invite_expires) < new Date()) return sendJson(res, 400, { error: 'Ez a link lejárt — kérj egy újat.' });
  usersDb.prepare(`UPDATE users SET password_hash = ?, invite_token = NULL, invite_expires = NULL WHERE id = ?`)
    .run(hashPassword(String(password)), u.id);
  logActivity({ type: 'password_reset_completed', ok: true, companyKey: null, nev: u.nev, detail: `${u.email} jelszava sikeresen megváltozott.` });
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------------------
// Egyéni fiókos bejelentkezés — cégtulajdonos és üzletvezető.
// A munkamenet UGYANOLYAN alakú, mint az adószám+kód bejelentkezésnél —
// ez szándékos: minden meglévő végpont (requireAuth/requireCegAuth) így
// változtatás nélkül működik tovább, akár adószám+kóddal, akár egyéni
// fiókkal jelentkezett be valaki.
// ---------------------------------------------------------------------------
route('POST', '/api/auth/user-login', async (req, res) => {
  const ip = getClientIp(req);
  const { email, password } = await readJsonBody(req);
  const clean = String(email || '').trim().toLowerCase();
  const rl = checkLoginRateLimit(ip, clean);
  if (!rl.allowed) return sendRateLimited(res, rl.retryAfterSeconds);
  const u = usersDb.prepare(`SELECT * FROM users WHERE email = ? AND role IN ('owner','manager')`).get(clean);
  if (!u || u.status !== 'active' || !verifyPassword(String(password || ''), u.password_hash)) {
    recordLoginAttempt(ip, clean, false);
    logActivity({ type: 'company_login', ok: false, companyKey: u ? u.ceg_kulcs : null, nev: null, detail: `Hibás egyéni belépés: ${clean}`, ip });
    return sendJson(res, 401, { error: 'Hibás email cím vagy jelszó.' });
  }
  recordLoginAttempt(ip, clean, true);
  triggerBackgroundNavSync(u.ceg_kulcs);

  if (u.role === 'manager') {
    // Üzletvezető — mindig egy KONKRÉT, rögzített telephelyre szól a hozzáférése.
    const siteKey = makeSiteKey(u.ceg_kulcs, u.telephely_kod);
    const site = companyIndex.get(siteKey);
    const telephelyInfo = listTelephelyek(u.ceg_kulcs).find((t) => t.kod === u.telephely_kod);
    const payload = {
      companyKey: siteKey, cegKulcs: u.ceg_kulcs, telephelyKod: u.telephely_kod, role: 'manager',
      nev: site ? site.nev : u.nev, adoszam: site ? site.adoszam : u.ceg_kulcs, exp: Date.now() + SESSION_MAX_AGE_MS,
    };
    const token = signSession(payload);
    const cookie = `enysession=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax${COOKIE_SECURE ? '; Secure' : ''}`;
    logActivity({ type: 'company_login', ok: true, companyKey: siteKey, nev: u.nev, detail: `Üzletvezetői belépés: ${clean}`, ip });
    return sendJson(res, 200, {
      ok: true, telephelyValasztva: true, vanAdat: !!site,
      company: { nev: payload.nev, adoszam: payload.adoszam, varos: site?.varos, cim: site?.cim, telephelyNev: telephelyInfo?.nev || u.telephely_kod },
    }, { 'Set-Cookie': cookie });
  }

  // owner — a cég egészéhez fér hozzá, pontosan úgy, mint az adószám+kód bejelentkezésnél.
  const telephelyek = listTelephelyek(u.ceg_kulcs);
  const anySite = [...companyIndex.values()].find((e) => e.cegKulcs === u.ceg_kulcs);
  const displayNev = anySite ? anySite.nev : u.nev;
  logActivity({ type: 'company_login', ok: true, companyKey: u.ceg_kulcs, nev: displayNev, detail: `Egyéni (cégtulajdonosi) belépés: ${clean}`, ip });

  if (telephelyek.length === 1) {
    const t = telephelyek[0];
    const siteKey = makeSiteKey(u.ceg_kulcs, t.kod);
    const site = companyIndex.get(siteKey);
    const payload = {
      companyKey: siteKey, cegKulcs: u.ceg_kulcs, telephelyKod: t.kod,
      nev: site ? site.nev : displayNev, adoszam: site ? site.adoszam : u.ceg_kulcs, exp: Date.now() + SESSION_MAX_AGE_MS,
    };
    const token = signSession(payload);
    const cookie = `enysession=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax${COOKIE_SECURE ? '; Secure' : ''}`;
    return sendJson(res, 200, {
      ok: true, telephelyValasztva: true, vanAdat: !!site,
      company: { nev: payload.nev, adoszam: payload.adoszam, varos: site?.varos, cim: site?.cim, telephelyNev: t.nev },
    }, { 'Set-Cookie': cookie });
  }

  const payload = { companyKey: u.ceg_kulcs, cegKulcs: u.ceg_kulcs, telephelyKod: null, nev: displayNev, adoszam: u.ceg_kulcs, exp: Date.now() + SESSION_MAX_AGE_MS };
  const token = signSession(payload);
  const cookie = `enysession=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax${COOKIE_SECURE ? '; Secure' : ''}`;
  sendJson(res, 200, { ok: true, telephelyValasztva: false, company: { nev: displayNev, adoszam: u.ceg_kulcs } }, { 'Set-Cookie': cookie });
});

// ---------------------------------------------------------------------------
// Viszonteladói bejelentkezés — külön munkamenet-cookie (enyreseller),
// nem keveredik a cégek/admin munkamenetével.
// ---------------------------------------------------------------------------
route('POST', '/api/auth/reseller-login', async (req, res) => {
  const ip = getClientIp(req);
  const { email, password } = await readJsonBody(req);
  const clean = String(email || '').trim().toLowerCase();
  const rl = checkLoginRateLimit(ip, clean);
  if (!rl.allowed) return sendRateLimited(res, rl.retryAfterSeconds);
  const u = usersDb.prepare(`SELECT * FROM users WHERE email = ? AND role = 'reseller'`).get(clean);
  if (!u || u.status !== 'active' || !verifyPassword(String(password || ''), u.password_hash)) {
    recordLoginAttempt(ip, clean, false);
    logActivity({ type: 'reseller_login', ok: false, companyKey: null, nev: null, detail: `Hibás viszonteladói belépés: ${clean}`, ip });
    return sendJson(res, 401, { error: 'Hibás email cím vagy jelszó.' });
  }
  recordLoginAttempt(ip, clean, true);
  const payload = { isReseller: true, resellerId: u.id, nev: u.nev, email: u.email, exp: Date.now() + SESSION_MAX_AGE_MS };
  const token = signSession(payload);
  const cookie = `enyreseller=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax${COOKIE_SECURE ? '; Secure' : ''}`;
  logActivity({ type: 'reseller_login', ok: true, companyKey: null, nev: u.nev, detail: clean, ip });
  sendJson(res, 200, { ok: true, nev: u.nev, email: u.email }, { 'Set-Cookie': cookie });
});

route('POST', '/api/auth/reseller-logout', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  revokeSession(cookies.enyreseller);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': `enyreseller=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${COOKIE_SECURE ? '; Secure' : ''}` });
});

// A viszonteladó KIZÁRÓLAG a saját ügyfeleit látja — más viszonteladók
// cégeihez semmilyen rálátása nincs, ahogy kérted ("nincs átjárás").
route('GET', '/api/reseller/overview', async (req, res) => {
  const reseller = requireReseller(req);
  if (!reseller) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const codes = readAccessCodes();
  const myCegKulcsok = new Set(
    Object.entries(codes).filter(([, v]) => v.resellerId === reseller.resellerId).map(([k]) => k)
  );
  const meta = readSyncMeta();
  const companies = [...companyIndex.entries()]
    .filter(([, entry]) => myCegKulcsok.has(entry.cegKulcs))
    .map(([key, entry]) => {
      const telephelyInfo = listTelephelyek(entry.cegKulcs).find((t) => t.kod === entry.telephelyKod);
      return {
        key, cegKulcs: entry.cegKulcs, telephelyKod: entry.telephelyKod, telephelyNev: telephelyInfo?.nev || entry.telephelyKod,
        nev: entry.nev, adoszam: entry.adoszam, varos: entry.varos,
        ...(meta[key] || { lastSync: null, source: null, bytes: null }),
      };
    })
    .sort((a, b) => (b.lastSync || '').localeCompare(a.lastSync || ''));
  sendJson(res, 200, { reseller: { nev: reseller.nev, email: reseller.email }, companies });
});

// Viszonteladó új ügyfelet ("cégtulajdonos" szintű felhasználót) hív meg —
// ez egyúttal elő is regisztrálja az új céget (adószám alapján), ha még
// nem létezne, hogy legyen hova az első androidos szinkronnak megérkeznie.
route('POST', '/api/reseller/invite-owner', async (req, res) => {
  const reseller = requireReseller(req);
  if (!reseller) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const rl = checkGenericRateLimit('invite-send', reseller.email, 20, 60 * 60 * 1000);
  if (!rl.allowed) return sendGenericRateLimited(res, rl.retryAfterSeconds, 'Túl sok meghívó egy óra alatt. Próbáld újra később.');
  const body = await readJsonBody(req);
  const cegKulcs = companyKeyFromAdoszam(body.adoszam);
  if (cegKulcs.length < 8) return sendJson(res, 400, { error: 'Érvénytelen adószám.' });
  const email = String(body.email || '').trim();
  if (!email) return sendJson(res, 400, { error: 'Az email cím megadása kötelező.' });

  const codes = readAccessCodes();
  if (!codes[cegKulcs]) codes[cegKulcs] = { code: generateAccessCode(), email: '' };
  codes[cegKulcs].resellerId = reseller.resellerId;
  writeAccessCodes(codes);
  ensureTelephely(cegKulcs, '01', 'Fő telephely');

  let token;
  try {
    token = createInvite({ email, nev: '', role: 'owner', cegKulcs, resellerId: reseller.resellerId, invitedBy: reseller.email });
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const link = buildInviteLink(req, token);
  const anySite = [...companyIndex.values()].find((e) => e.cegKulcs === cegKulcs);
  let emailWarning = null;
  try { await sendInviteEmail(link, { email, nev: '', role: 'owner', adoszam: body.adoszam, cegNev: anySite?.nev }); }
  catch (e) { emailWarning = e.message; } // a fiók/meghívó ettől még létrejött, csak az email nem ment ki
  logActivity({ type: 'user_invite_sent', ok: true, companyKey: cegKulcs, nev: reseller.nev, detail: `Cégtulajdonos meghívva: ${email}, adószám: ${cegKulcs}` });
  sendJson(res, 200, { ok: true, inviteLink: link, emailWarning });
});

// Cégtulajdonos (a Profil oldalról) üzletvezetőt hív meg egy konkrét
// telephelyére.
route('POST', '/api/profile/invite-manager', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  if (session.role === 'manager') return sendJson(res, 403, { error: 'Üzletvezetőként nem hívhatsz meg új felhasználót.' });
  const rl = checkGenericRateLimit('invite-send', session.nev || session.companyKey, 20, 60 * 60 * 1000);
  if (!rl.allowed) return sendGenericRateLimited(res, rl.retryAfterSeconds, 'Túl sok meghívó egy óra alatt. Próbáld újra később.');
  const body = await readJsonBody(req);
  const kod = normalizeTelephelyKod(body.telephelyKod);
  const email = String(body.email || '').trim();
  if (!email) return sendJson(res, 400, { error: 'Az email cím megadása kötelező.' });
  if (!listTelephelyek(session.cegKulcs).some((t) => t.kod === kod)) return sendJson(res, 404, { error: 'Ismeretlen telephely.' });

  let token;
  try {
    token = createInvite({ email, nev: '', role: 'manager', cegKulcs: session.cegKulcs, telephelyKod: kod, invitedBy: session.nev });
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const link = buildInviteLink(req, token);
  const anySite = [...companyIndex.values()].find((e) => e.cegKulcs === session.cegKulcs);
  let emailWarning = null;
  try { await sendInviteEmail(link, { email, nev: '', role: 'manager', adoszam: session.adoszam, cegNev: anySite?.nev }); }
  catch (e) { emailWarning = e.message; }
  logActivity({ type: 'user_invite_sent', ok: true, companyKey: makeSiteKey(session.cegKulcs, kod), nev: session.nev, detail: `Üzletvezető meghívva: ${email}` });
  sendJson(res, 200, { ok: true, inviteLink: link, emailWarning });
});

// ---------------------------------------------------------------------------
// Eszköz-karbantartó — céges (nem admin) felhasználóknak. Cégtulajdonos
// a TELJES céget látja (minden telephely eszközét), üzletvezető CSAK a
// saját telephelyéét — ugyanaz a szabály, mint minden más üzletvezetői
// korlátozásnál ebben a rendszerben.
route('GET', '/api/profile/devices', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const rows = session.role === 'manager'
    ? licenseDb.prepare('SELECT * FROM company_devices WHERE ceg_kulcs = ? AND telephely_kod = ? ORDER BY elso_latott').all(session.cegKulcs, session.telephelyKod)
    : licenseDb.prepare('SELECT * FROM company_devices WHERE ceg_kulcs = ? ORDER BY elso_latott').all(session.cegKulcs);
  sendJson(res, 200, {
    devices: rows.map((d) => ({
      id: d.id, eszkozAzonosito: d.eszkoz_azonosito, telephelyKod: d.telephely_kod, nev: d.nev,
      progtip: d.progtip, verzio: d.verzio, elsoLatott: d.elso_latott, utolsoLatott: d.utolso_latott,
    })),
  });
});

route('POST', '/api/profile/devices/rename', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { id, nev } = await readJsonBody(req);
  const device = licenseDb.prepare('SELECT id, ceg_kulcs, telephely_kod FROM company_devices WHERE id = ?').get(id);
  if (!device || device.ceg_kulcs !== session.cegKulcs) return sendJson(res, 404, { error: 'Ismeretlen eszköz.' });
  if (session.role === 'manager' && device.telephely_kod !== session.telephelyKod) {
    return sendJson(res, 403, { error: 'Ez az eszköz nem a te telephelyedhez tartozik.' });
  }
  licenseDb.prepare('UPDATE company_devices SET nev = ? WHERE id = ?').run(String(nev || '').trim() || null, id);
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/profile/devices/remove', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { id } = await readJsonBody(req);
  const device = licenseDb.prepare('SELECT id, ceg_kulcs, telephely_kod FROM company_devices WHERE id = ?').get(id);
  if (!device || device.ceg_kulcs !== session.cegKulcs) return sendJson(res, 404, { error: 'Ismeretlen eszköz.' });
  if (session.role === 'manager' && device.telephely_kod !== session.telephelyKod) {
    return sendJson(res, 403, { error: 'Ez az eszköz nem a te telephelyedhez tartozik.' });
  }
  licenseDb.prepare('DELETE FROM company_devices WHERE id = ?').run(id);
  sendJson(res, 200, { ok: true });
});

// Előfizetés-állapot a cég saját felhasználóinak — alap regisztráltság,
// elérhető csomagok (árral), és a saját fizetési előzmény.
route('GET', '/api/profile/subscription', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const sub = licenseDb.prepare('SELECT aktiv, megjegyzes FROM company_subscription WHERE ceg_kulcs = ?').get(session.cegKulcs);
  const packages = licenseDb.prepare('SELECT id, nev, leiras, ar FROM license_packages WHERE aktiv = 1 AND ar > 0 ORDER BY sorrend, nev').all();
  const payments = licenseDb.prepare('SELECT order_id, cel, osszeg, penznem, allapot, letrehozva FROM license_payments WHERE ceg_kulcs = ? ORDER BY letrehozva DESC LIMIT 20').all(session.cegKulcs);
  sendJson(res, 200, {
    alapElofizetesAktiv: !sub || !!sub.aktiv,
    megjegyzes: sub ? sub.megjegyzes : null,
    alapElofizetesAra: parseInt(process.env.ALAP_ELOFIZETES_AR_HUF || '0', 10) || null,
    myposElerheto: myposConfigured(),
    csomagok: packages,
    fizetesek: payments.map((p) => ({ orderId: p.order_id, cel: p.cel, osszeg: p.osszeg, penznem: p.penznem, allapot: p.allapot, letrehozva: p.letrehozva })),
  });
});

// A cég maga állítja be, NTAK-köteles vendéglátóhely-e — ha igen, a
// Cikktörzs-szerkesztő innentől megköveteli az NTAK-kategória mezőket
// minden cikknél (a rendszer nem tudja ezt automatikusan kitalálni).
route('GET', '/api/profile/ntak-setting', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  sendJson(res, 200, { ntakAktiv: isCompanyNtakActive(session.cegKulcs) });
});

route('POST', '/api/profile/ntak-setting', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  if (session.role === 'manager') return sendJson(res, 403, { error: 'Csak a cégtulajdonos módosíthatja ezt a beállítást.' });
  const { ntakAktiv } = await readJsonBody(req);
  licenseDb.prepare(`
    INSERT INTO company_settings (ceg_kulcs, ntak_aktiv, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(ceg_kulcs) DO UPDATE SET ntak_aktiv = excluded.ntak_aktiv, updated_at = excluded.updated_at
  `).run(session.cegKulcs, ntakAktiv ? 1 : 0, new Date().toISOString());
  logActivity({ type: 'ntak_setting_change', ok: true, companyKey: session.companyKey, nev: session.nev, detail: ntakAktiv ? 'NTAK-mezők bekapcsolva a Cikktörzsben.' : 'NTAK-mezők kikapcsolva a Cikktörzsben.' });
  sendJson(res, 200, { ok: true, ntakAktiv: !!ntakAktiv });
});

// Cég saját, strukturált (NAV-formátumú) számlázási címe — ezt használja a
// demo-számla PDF is. Csak a cégtulajdonos módosíthatja, mindenki (owner +
// manager) lekérdezheti.
route('GET', '/api/profile/billing-address', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const row = licenseDb.prepare(`SELECT * FROM company_settings WHERE ceg_kulcs = ?`).get(session.cegKulcs);
  sendJson(res, 200, {
    iranyitoszam: row?.szamlazasi_iranyitoszam || '',
    telepules: row?.szamlazasi_telepules || '',
    kozteruletNev: row?.szamlazasi_kozterulet_nev || '',
    kozteruletJelleg: row?.szamlazasi_kozterulet_jelleg || '',
    hazszam: row?.szamlazasi_hazszam || '',
    emelet: row?.szamlazasi_emelet || '',
    kozteruletJellegek: KOZTERULET_JELLEGEK,
  });
});
route('POST', '/api/profile/billing-address', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  if (session.role === 'manager') return sendJson(res, 403, { error: 'Csak a cégtulajdonos módosíthatja a számlázási címet.' });
  const body = await readJsonBody(req);
  const iranyitoszam = clampStr(body.iranyitoszam, 10);
  if (iranyitoszam && !/^\d{4}$/.test(iranyitoszam)) return sendJson(res, 400, { error: 'Az irányítószám 4 számjegyből áll.' });
  const telepules = clampStr(body.telepules, 80);
  const kozteruletNev = clampStr(body.kozteruletNev, 80);
  const kozteruletJelleg = clampStr(body.kozteruletJelleg, 30);
  const hazszam = clampStr(body.hazszam, 20);
  const emelet = clampStr(body.emelet, 60);
  licenseDb.prepare(`
    INSERT INTO company_settings (ceg_kulcs, szamlazasi_iranyitoszam, szamlazasi_telepules, szamlazasi_kozterulet_nev, szamlazasi_kozterulet_jelleg, szamlazasi_hazszam, szamlazasi_emelet, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ceg_kulcs) DO UPDATE SET
      szamlazasi_iranyitoszam = excluded.szamlazasi_iranyitoszam, szamlazasi_telepules = excluded.szamlazasi_telepules,
      szamlazasi_kozterulet_nev = excluded.szamlazasi_kozterulet_nev, szamlazasi_kozterulet_jelleg = excluded.szamlazasi_kozterulet_jelleg,
      szamlazasi_hazszam = excluded.szamlazasi_hazszam, szamlazasi_emelet = excluded.szamlazasi_emelet, updated_at = excluded.updated_at
  `).run(session.cegKulcs, iranyitoszam || null, telepules || null, kozteruletNev || null, kozteruletJelleg || null, hazszam || null, emelet || null, new Date().toISOString());
  logActivity({ type: 'billing_address_change', ok: true, companyKey: session.companyKey, nev: session.nev, detail: 'Számlázási cím frissítve.' });
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------------------
// ÜGYFÉL-OLDALI NAV ONLINE SZÁMLA KAPCSOLAT — minden cég a SAJÁT NAV
// technikai felhasználójának adataival tudja lekérdezni a SAJÁT bejövő/
// kimenő számláit (ez teljesen független az üzemeltető, Leichter
// Irodatechnika saját NAV-kapcsolatától, amit az admin Pénzügyek nézete
// használ). Az érzékeny mezőket SOHA nem küldjük vissza a böngészőnek.
// ---------------------------------------------------------------------------
route('GET', '/api/profile/nav-credentials', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const row = licenseDb.prepare(`SELECT ceg_kulcs, nav_taxnumber, nav_tech_user, nav_sandbox FROM company_nav_credentials WHERE ceg_kulcs = ?`).get(session.cegKulcs);
  sendJson(res, 200, {
    configured: !!row,
    taxNumber: row?.nav_taxnumber || '',
    techUser: row?.nav_tech_user || '',
    sandbox: row ? !!row.nav_sandbox : true,
  });
});

route('POST', '/api/profile/nav-credentials', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  if (session.role === 'manager') return sendJson(res, 403, { error: 'Csak a cégtulajdonos állíthatja be a NAV-kapcsolatot.' });
  const body = await readJsonBody(req);
  const taxNumber = clampStr(body.taxNumber, 20).replace(/[^0-9]/g, '');
  const techUser = clampStr(body.techUser, 60);
  const techPassword = clampStr(body.techPassword, 100);
  const signingKey = clampStr(body.signingKey, 100);
  const exchangeKey = clampStr(body.exchangeKey, 100);
  const sandbox = body.sandbox !== false;
  if (!taxNumber || taxNumber.length < 8) return sendJson(res, 400, { error: 'Érvénytelen adószám.' });
  if (!techUser || !techPassword || !signingKey || !exchangeKey) {
    return sendJson(res, 400, { error: 'Minden mező kitöltése kötelező (technikai felhasználó, jelszó, aláírókulcs, cserekulcs).' });
  }
  licenseDb.prepare(`
    INSERT INTO company_nav_credentials (ceg_kulcs, nav_taxnumber, nav_tech_user, nav_tech_password_enc, nav_signing_key_enc, nav_exchange_key_enc, nav_sandbox, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ceg_kulcs) DO UPDATE SET
      nav_taxnumber = excluded.nav_taxnumber, nav_tech_user = excluded.nav_tech_user,
      nav_tech_password_enc = excluded.nav_tech_password_enc, nav_signing_key_enc = excluded.nav_signing_key_enc,
      nav_exchange_key_enc = excluded.nav_exchange_key_enc, nav_sandbox = excluded.nav_sandbox, updated_at = excluded.updated_at
  `).run(session.cegKulcs, taxNumber, techUser, encryptNavSecret(techPassword), encryptNavSecret(signingKey), encryptNavSecret(exchangeKey), sandbox ? 1 : 0, new Date().toISOString());
  logActivity({ type: 'nav_credentials_change', ok: true, companyKey: session.companyKey, nev: session.nev, detail: 'Saját NAV-kapcsolat beállítva/frissítve.' });
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/profile/nav-test-connection', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const creds = getCompanyNavCreds(session.cegKulcs);
  if (!navCredsComplete(creds)) return sendJson(res, 400, { error: 'A NAV-kapcsolat nincs beállítva.' });
  try {
    const result = await navTokenExchange(creds);
    logActivity({ type: 'nav_test_connection', ok: true, companyKey: session.companyKey, nev: session.nev, detail: `Sikeres NAV tokenExchange (${creds.sandbox ? 'teszt' : 'éles'} környezet)` });
    sendJson(res, 200, { ok: true, tokenValidTo: result.validTo });
  } catch (e) {
    logActivity({ type: 'nav_test_connection', ok: false, companyKey: session.companyKey, nev: session.nev, detail: e.message });
    sendJson(res, 500, { error: e.message });
  }
});

// A cég SAJÁT bejövő/kimenő számláinak lekérdezése, ALAPVETŐ elemzésekkel
// (havi összesítés, top partnerek) — a kivonat-adatokból számolva. Mélyebb,
// tételes (termék/szolgáltatás-szintű) elemzés ehhez a teljes számla-
// tartalom (queryInvoiceData) lekérdezését igényelné, ez egy KÖVETKEZŐ
// fejlesztési kör lehetősége, mivel ez laponként/számlánként külön
// hálózati hívást jelentene.
route('GET', '/api/profile/nav-invoices', async (req, res, query) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const creds = getCompanyNavCreds(session.cegKulcs);
  if (!navCredsComplete(creds)) return sendJson(res, 400, { error: 'A NAV-kapcsolat nincs beállítva.' });

  const direction = query.direction === 'INBOUND' ? 'INBOUND' : 'OUTBOUND';
  const dateTo = query.dateTo || todayIsoServer();
  const dateFrom = query.dateFrom || addDaysISO(dateTo, -30);
  const napokSzama = Math.round((new Date(dateTo) - new Date(dateFrom)) / (24 * 60 * 60 * 1000));
  if (napokSzama > 35 || napokSzama < 0) {
    return sendJson(res, 400, { error: 'A lekérdezési időszak legfeljebb 35 nap lehet (ezt a NAV korlátozza).' });
  }
  try {
    const result = await navQueryInvoiceDigest({ direction, dateFrom, dateTo, page: 1, creds });

    // Alap-elemzés a kivonat-adatokból: havi bontás, top partnerek.
    const havonta = new Map();
    const partnerek = new Map();
    for (const inv of result.invoices) {
      const honap = (inv.invoiceIssueDate || '').slice(0, 7);
      const netto = Number(inv.invoiceNetAmountHUF) || 0;
      if (honap) {
        if (!havonta.has(honap)) havonta.set(honap, { honap, osszeg: 0, darab: 0 });
        const h = havonta.get(honap); h.osszeg += netto; h.darab += 1;
      }
      const partnerNev = direction === 'OUTBOUND' ? inv.customerName : inv.supplierName;
      if (partnerNev) {
        if (!partnerek.has(partnerNev)) partnerek.set(partnerNev, { nev: partnerNev, osszeg: 0, darab: 0 });
        const p = partnerek.get(partnerNev); p.osszeg += netto; p.darab += 1;
      }
    }

    sendJson(res, 200, {
      ...result, direction, dateFrom, dateTo,
      havonta: [...havonta.values()].sort((a, b) => a.honap.localeCompare(b.honap)),
      topPartnerek: [...partnerek.values()].sort((a, b) => b.osszeg - a.osszeg).slice(0, 10),
    });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

// A KIVONAT-ban szereplő számlák TELJES tartalmának lekérdezése és a
// tételsorok helyi eltárolása — ez teszi lehetővé a tételes (termék/
// szolgáltatás-szintű) elemzést. Mivel ez számlánként külön NAV-hívást
// jelent, EGYSZERRE csak korlátozott számút (NAV_LINE_SYNC_BATCH_SIZE)
// dolgozunk fel — a felhasználó igény szerint többször is elindíthatja,
// amíg minden számla feldolgozásra nem kerül (a már feldolgozottakat nem
// kérdezzük le újra).
const NAV_LINE_SYNC_BATCH_SIZE = 15;
// A TELJES tartalom (tételsorok) szinkronizálásának közös, újrahasznosítható
// magja — ugyanezt hívja a kézi "Szinkronizálás" gomb ÉS a bejelentkezéskor
// induló, háttérben futó automatikus szinkronizálás is.
async function syncCompanyNavLines(cegKulcs, direction, dateFrom, dateTo, creds) {
  const digest = await navQueryInvoiceDigest({ direction, dateFrom, dateTo, page: 1, creds });
  const alreadySynced = new Set(
    licenseDb.prepare(`SELECT invoice_number FROM company_nav_synced_invoices WHERE ceg_kulcs = ? AND invoice_direction = ?`)
      .all(cegKulcs, direction).map((r) => r.invoice_number)
  );
  const toSync = digest.invoices.filter((inv) => inv.invoiceNumber && !alreadySynced.has(inv.invoiceNumber)).slice(0, NAV_LINE_SYNC_BATCH_SIZE);

  let syncedCount = 0;
  let totalLinesFound = 0;
  const errors = [];
  for (const inv of toSync) {
    try {
      const invoiceXml = await navQueryInvoiceData({ invoiceNumber: inv.invoiceNumber, direction, taxNumber: creds.taxNumber, creds });
      // Átláthatóság/hibaelhárítás céljából a NYERS számla-XML-t is
      // eltároljuk — ha egy számlánál 0 tételt találunk, ebből
      // közvetlenül látszik, hogy a NAV válasza valóban nem tartalmazott
      // tételsorokat, vagy a kinyerő logikánk hibás.
      const rawFajlnev = saveNavRawResponse(`${cegKulcs}-${inv.invoiceNumber}`, `invoicedata-${direction}`, invoiceXml);
      const lines = extractInvoiceLines(invoiceXml);
      totalLinesFound += lines.length;
      const partnerNev = direction === 'OUTBOUND' ? inv.customerName : inv.supplierName;
      const now = new Date().toISOString();
      for (const line of lines) {
        try {
          licenseDb.prepare(`
            INSERT INTO company_nav_invoice_lines (ceg_kulcs, invoice_direction, invoice_number, invoice_issue_date, partner_name, line_description, quantity, unit_of_measure, net_amount, vat_amount, gross_amount, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING
          `).run(cegKulcs, direction, inv.invoiceNumber, inv.invoiceIssueDate || null, partnerNev || null, line.description, line.quantity, line.unitOfMeasure, line.netAmount, line.vatAmount, line.grossAmount, now);
        } catch (_) {}
      }
      licenseDb.prepare(`INSERT INTO company_nav_synced_invoices (ceg_kulcs, invoice_direction, invoice_number, synced_at, raw_response_fajlnev, lines_found) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
        .run(cegKulcs, direction, inv.invoiceNumber, now, rawFajlnev, lines.length);
      syncedCount += 1;
    } catch (e) {
      console.error(`[NAV] Számla-tartalom szinkronizálási hiba (${inv.invoiceNumber}): ${e.message}`);
      errors.push({ invoiceNumber: inv.invoiceNumber, message: e.message });
    }
  }
  const remaining = digest.invoices.filter((inv) => inv.invoiceNumber && !alreadySynced.has(inv.invoiceNumber)).length - toSync.length;
  return { synced: syncedCount, remaining: Math.max(0, remaining), linesFound: totalLinesFound, errors };
}

// Bejelentkezéskor induló, HÁTTÉRBEN futó automatikus szinkronizálás — ez
// SOHA nem blokkolhatja/lassíthatja a bejelentkezést magát, ezért
// SZÁNDÉKOSAN nincs "await"-elve a hívási helyén (fire-and-forget). Csak
// akkor csinál bármit, ha a cégnek ténylegesen be van állítva a saját
// NAV-kapcsolata.
function triggerBackgroundNavSync(cegKulcs) {
  const creds = getCompanyNavCreds(cegKulcs);
  if (!navCredsComplete(creds)) return;
  const dateTo = todayIsoServer();
  const dateFrom = addDaysISO(dateTo, -30);
  (async () => {
    for (const direction of ['OUTBOUND', 'INBOUND']) {
      try {
        const result = await syncCompanyNavLines(cegKulcs, direction, dateFrom, dateTo, creds);
        if (result.synced > 0) {
          logActivity({ type: 'nav_line_sync', ok: true, companyKey: cegKulcs, nev: null, detail: `Bejelentkezéskori automatikus szinkronizálás (${direction}): ${result.synced} számla` });
        }
      } catch (e) {
        console.error(`[NAV] Bejelentkezéskori automatikus szinkronizálási hiba (${cegKulcs}, ${direction}): ${e.message}`);
      }
    }
  })();
}

route('POST', '/api/profile/nav-sync-lines', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const creds = getCompanyNavCreds(session.cegKulcs);
  if (!navCredsComplete(creds)) return sendJson(res, 400, { error: 'A NAV-kapcsolat nincs beállítva.' });
  const body = await readJsonBody(req);
  const direction = body.direction === 'INBOUND' ? 'INBOUND' : 'OUTBOUND';
  const dateTo = body.dateTo || todayIsoServer();
  const dateFrom = body.dateFrom || addDaysISO(dateTo, -30);
  const napokSzama = Math.round((new Date(dateTo) - new Date(dateFrom)) / (24 * 60 * 60 * 1000));
  if (napokSzama > 35 || napokSzama < 0) {
    return sendJson(res, 400, { error: 'A lekérdezési időszak legfeljebb 35 nap lehet (ezt a NAV korlátozza).' });
  }

  try {
    const result = await syncCompanyNavLines(session.cegKulcs, direction, dateFrom, dateTo, creds);
    sendJson(res, 200, { ok: true, synced: result.synced, remaining: result.remaining, linesFound: result.linesFound, errors: result.errors });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

// A helyben eltárolt, tételes (termék/szolgáltatás-szintű) adatok
// elemzése — ez a MÉLYEBB elemzés, ami már a szinkronizált (nem csak a
// kivonat-szintű) adatokból dolgozik.
route('GET', '/api/profile/nav-line-analytics', async (req, res, query) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const direction = query.direction === 'INBOUND' ? 'INBOUND' : 'OUTBOUND';
  const dateTo = query.dateTo || todayIsoServer();
  const dateFrom = query.dateFrom || addDaysISO(dateTo, -30);

  const rows = licenseDb.prepare(`
    SELECT * FROM company_nav_invoice_lines
    WHERE ceg_kulcs = ? AND invoice_direction = ? AND invoice_issue_date BETWEEN ? AND ?
  `).all(session.cegKulcs, direction, dateFrom, dateTo);

  const termekek = new Map();
  for (const r of rows) {
    if (!termekek.has(r.line_description)) termekek.set(r.line_description, { nev: r.line_description, darabszam: 0, mennyiseg: 0, netto: 0 });
    const t = termekek.get(r.line_description);
    t.darabszam += 1; t.mennyiseg += r.quantity; t.netto += r.net_amount;
  }
  const syncedCount = licenseDb.prepare(`SELECT COUNT(*) AS c FROM company_nav_synced_invoices WHERE ceg_kulcs = ? AND invoice_direction = ?`).get(session.cegKulcs, direction).c;

  sendJson(res, 200, {
    direction, dateFrom, dateTo, szinkronizaltSzamlakSzama: syncedCount,
    topTermekek: [...termekek.values()].sort((a, b) => b.netto - a.netto).slice(0, 15),
  });
});

// A már szinkronizált számlák listája, tételszámmal és a nyers válasz
// linkjével — átláthatóság/hibaelhárítás céljából (pl. ha egy számlánál
// 0 tételt talált a rendszer, ebből közvetlenül látszik, miért).
route('GET', '/api/profile/nav-synced-invoices', async (req, res, query) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const direction = query.direction === 'INBOUND' ? 'INBOUND' : 'OUTBOUND';
  const rows = licenseDb.prepare(`
    SELECT invoice_number, synced_at, raw_response_fajlnev, lines_found FROM company_nav_synced_invoices
    WHERE ceg_kulcs = ? AND invoice_direction = ? ORDER BY synced_at DESC LIMIT 50
  `).all(session.cegKulcs, direction);
  sendJson(res, 200, {
    invoices: rows.map((r) => ({ invoiceNumber: r.invoice_number, syncedAt: r.synced_at, linesFound: r.lines_found, rawResponseFajlnev: r.raw_response_fajlnev })),
  });
});

route('GET', '/api/profile/nav-raw-response', async (req, res, query) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const fajlnev = String(query.fajlnev || '').replace(/[^a-zA-Z0-9._\-]/g, '');
  if (!fajlnev) return sendJson(res, 400, { error: 'Hiányzó fájlnév.' });
  // Csak a SAJÁT cégéhez tartozó fájlt nézheti meg — ezt a fájlnév elején
  // szereplő cégkulccsal ellenőrizzük (lásd saveNavRawResponse hívása).
  if (!fajlnev.startsWith(`${session.cegKulcs}-`)) return sendJson(res, 403, { error: 'Ehhez a fájlhoz nincs jogosultságod.' });
  const exists = licenseDb.prepare(`SELECT 1 FROM company_nav_synced_invoices WHERE ceg_kulcs = ? AND raw_response_fajlnev = ?`).get(session.cegKulcs, fajlnev);
  if (!exists) return sendJson(res, 404, { error: 'Nincs ilyen eltárolt válasz.' });
  const filePath = path.join(NAV_RESPONSES_DIR, fajlnev);
  if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'A fájl nem található a szerveren.' });
  res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': `inline; filename="${fajlnev}"`, 'Cache-Control': 'private, max-age=3600' });
  res.end(fs.readFileSync(filePath));
});

// ---------------------------------------------------------------------------
// FUNKCIÓK ÖNKISZOLGÁLÓ VÁLASZTÁSA — a cég (tulajdonos VAGY üzletvezető,
// a SAJÁT telephelyére) maga választhatja ki, mely funkciókra van szüksége,
// pontosan ugyanabból a katalógusból és ugyanabba a company_licenses
// táblába írva, amit az admin felület is használ — így bármelyik oldalon
// történő módosítás AZONNAL látszik a másikon is, mert ugyanaz az egy
// adatforrás.
//
// FONTOS, ELŐRE JELZETT KORLÁTOZÁS: ez a választás JELENLEG nincs
// fizetéshez kötve — bárki bármit bekapcsolhat magának, azonnali hatállyal,
// lejárat nélkül. Ez SZÁNDÉKOS, átmeneti állapot, amíg a fizetési
// összekötés (havi díj, automatikus letiltás fizetés elmaradása esetén)
// el nem készül egy következő körben.
// ---------------------------------------------------------------------------
route('GET', '/api/profile/features', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  if (!session.telephelyKod) return sendJson(res, 400, { error: 'Előbb válassz telephelyet — a funkciók telephelyenként külön választhatók.' });
  const catalog = licenseDb.prepare(`SELECT key, nev, leiras, alap_ar FROM license_features WHERE aktiv = 1 ORDER BY sorrend, nev`).all();
  const grants = getCompanyLicenseGrants(session.cegKulcs, session.telephelyKod);
  // Ha a cégnek/telephelynek VAN már aktív kiosztása egy olyan funkcióra,
  // amit admin időközben inaktiválta a katalógusban, azt is meg kell
  // mutatnunk — különben egy ténylegesen még aktív funkció "eltűnne"
  // a cég szeméből, miközben a rendszer háttérben továbbra is
  // engedélyezettként kezeli. Enélkül épp ez okozta korábban, hogy az
  // admin és az ügyfél nézete eltért egymástól.
  const catalogKeys = new Set(catalog.map((f) => f.key));
  const orphanedGrantedKeys = [...grants.keys()].filter((k) => !catalogKeys.has(k) && grants.get(k).aktiv);
  const orphanedFeatures = orphanedGrantedKeys.length
    ? licenseDb.prepare(`SELECT key, nev, leiras, alap_ar FROM license_features WHERE key IN (${orphanedGrantedKeys.map(() => '?').join(',')})`).all(...orphanedGrantedKeys)
    : [];
  const features = [...catalog, ...orphanedFeatures].map((f) => {
    const row = grants.get(f.key);
    const status = licenseRowStatus(row);
    return {
      key: f.key, nev: f.nev, leiras: f.leiras, alapAr: f.alap_ar,
      kivalasztva: !!row && !!row.aktiv && status.allapot !== 'expired',
      sajatTelephelySpecifikus: !!row && row.telephely_kod === session.telephelyKod,
      lejarat: row ? row.lejarat : null,
    };
  });
  sendJson(res, 200, { features, telephelyKod: session.telephelyKod });
});

route('POST', '/api/profile/features/toggle', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  if (!session.telephelyKod) return sendJson(res, 400, { error: 'Előbb válassz telephelyet — a funkciók telephelyenként külön választhatók.' });
  const { featureKey, kivalasztva } = await readJsonBody(req);
  const feature = licenseDb.prepare(`SELECT key, nev, alap_ar FROM license_features WHERE key = ? AND aktiv = 1`).get(featureKey);
  if (!feature) return sendJson(res, 404, { error: 'Ismeretlen funkció.' });

  if (kivalasztva) {
    licenseDb.prepare(`
      INSERT INTO company_licenses (ceg_kulcs, telephely_kod, feature_key, ar, lejarat, aktiv, jovahagyta, updated_at)
      VALUES (?, ?, ?, ?, NULL, 1, ?, ?)
      ON CONFLICT(ceg_kulcs, telephely_kod, feature_key) DO UPDATE SET aktiv = 1, jovahagyta = excluded.jovahagyta, updated_at = excluded.updated_at
    `).run(session.cegKulcs, session.telephelyKod, featureKey, feature.alap_ar, `saját (${session.nev})`, new Date().toISOString());
  } else {
    licenseDb.prepare(`DELETE FROM company_licenses WHERE ceg_kulcs = ? AND telephely_kod = ? AND feature_key = ?`)
      .run(session.cegKulcs, session.telephelyKod, featureKey);
  }
  logActivity({
    type: 'license_self_service', ok: true, companyKey: session.companyKey, nev: session.nev,
    detail: `${kivalasztva ? 'Bekapcsolva' : 'Kikapcsolva'} (önkiszolgáló, ${session.telephelyKod} telephely): ${feature.nev}`,
  });
  sendJson(res, 200, { ok: true });
});

// Admin: viszonteladó, cégtulajdonos vagy üzletvezető meghívása —
// bármelyik szintre, bármelyik céghez/telephelyhez.
route('POST', '/api/admin/invite-user', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const rl = checkGenericRateLimit('invite-send', 'admin', 40, 60 * 60 * 1000);
  if (!rl.allowed) return sendGenericRateLimited(res, rl.retryAfterSeconds, 'Túl sok meghívó egy óra alatt. Próbáld újra később.');
  const body = await readJsonBody(req);
  const role = String(body.role || '');
  if (!['reseller', 'owner', 'manager'].includes(role)) return sendJson(res, 400, { error: 'Érvénytelen szerepkör.' });
  const email = String(body.email || '').trim();
  if (!email) return sendJson(res, 400, { error: 'Az email cím megadása kötelező.' });

  let cegKulcs = null, telephelyKod = null, cegNev = null;
  if (role === 'owner' || role === 'manager') {
    cegKulcs = companyKeyFromAdoszam(body.adoszam);
    if (cegKulcs.length < 8) return sendJson(res, 400, { error: 'Érvénytelen adószám.' });
    const codes = readAccessCodes();
    if (!codes[cegKulcs]) { codes[cegKulcs] = { code: generateAccessCode(), email: '' }; writeAccessCodes(codes); }
    ensureTelephely(cegKulcs, '01', 'Fő telephely');
    if (role === 'manager') {
      telephelyKod = normalizeTelephelyKod(body.telephelyKod);
      if (!listTelephelyek(cegKulcs).some((t) => t.kod === telephelyKod)) return sendJson(res, 404, { error: 'Ismeretlen telephely ennél a cégnél.' });
    }
    const anySite = [...companyIndex.values()].find((e) => e.cegKulcs === cegKulcs);
    cegNev = anySite?.nev || null;
  }

  let token;
  try {
    token = createInvite({ email, nev: '', role, cegKulcs, telephelyKod, invitedBy: 'admin' });
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const link = buildInviteLink(req, token);
  let emailWarning = null;
  try { await sendInviteEmail(link, { email, nev: '', role, adoszam: body.adoszam, cegNev }); }
  catch (e) { emailWarning = e.message; }
  logActivity({ type: 'user_invite_sent', ok: true, companyKey: cegKulcs, nev: 'admin', detail: `${ROLE_LABELS[role]} meghívva: ${email}` });
  sendJson(res, 200, { ok: true, inviteLink: link, emailWarning });
});

// Felhasználók listája — hierarchia szerint kiegészítve (viszonteladó neve,
// cégnév, telephely neve), hogy az admin panel csoportosítva tudja mutatni.
route('GET', '/api/admin/users', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const rows = usersDb.prepare(
    `SELECT id, email, role, ceg_kulcs, telephely_kod, reseller_id, nev, invited_by, status, created_at FROM users ORDER BY created_at DESC`
  ).all();
  const resellerNevByld = new Map(rows.filter((r) => r.role === 'reseller').map((r) => [r.id, r.nev]));
  const users = rows.map((u) => {
    let cegNev = null, telephelyNev = null;
    if (u.ceg_kulcs) {
      const anySite = [...companyIndex.values()].find((e) => e.cegKulcs === u.ceg_kulcs);
      cegNev = anySite ? anySite.nev : u.ceg_kulcs;
      if (u.telephely_kod) {
        const t = listTelephelyek(u.ceg_kulcs).find((x) => x.kod === u.telephely_kod);
        telephelyNev = t ? t.nev : u.telephely_kod;
      }
    }
    return {
      id: u.id, email: u.email, nev: u.nev, role: u.role, status: u.status,
      cegKulcs: u.ceg_kulcs, cegNev, telephelyKod: u.telephely_kod, telephelyNev,
      resellerId: u.reseller_id, resellerNev: u.reseller_id ? (resellerNevByld.get(u.reseller_id) || null) : null,
      invitedBy: u.invited_by, createdAt: u.created_at,
    };
  });
  sendJson(res, 200, { users });
});

// Felhasználó szerkesztése — csak a nevet és az állapotot (aktív/letiltva)
// lehet módosítani. A szerepkör/cég/telephely szándékosan NEM módosítható
// itt (ha ez kellene, töröld és hívd meg újra a megfelelő szinttel).
route('POST', '/api/admin/users/update', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { id, nev, status, cegKulcs, telephelyKod } = await readJsonBody(req);
  const u = usersDb.prepare('SELECT id, email, nev, role FROM users WHERE id = ?').get(id);
  if (!u) return sendJson(res, 404, { error: 'Ismeretlen felhasználó.' });
  const cleanNev = String(nev || '').trim();
  if (!cleanNev) return sendJson(res, 400, { error: 'A név megadása kötelező.' });
  if (!['active', 'disabled', 'pending'].includes(status)) return sendJson(res, 400, { error: 'Érvénytelen állapot.' });

  let detail = `${u.email}: név/állapot módosítva (${status})`;
  if (u.role === 'owner') {
    // Cégtulajdonos áthelyezhető egy másik (akár még nem szinkronizált) céghez.
    const newCegKulcs = companyKeyFromAdoszam(cegKulcs || '');
    if (newCegKulcs.length < 8) return sendJson(res, 400, { error: 'Érvénytelen adószám.' });
    const codes = readAccessCodes();
    if (!codes[newCegKulcs]) { codes[newCegKulcs] = { code: generateAccessCode(), email: '' }; writeAccessCodes(codes); }
    ensureTelephely(newCegKulcs, '01', 'Fő telephely');
    usersDb.prepare('UPDATE users SET nev = ?, status = ?, ceg_kulcs = ?, telephely_kod = NULL WHERE id = ?').run(cleanNev, status, newCegKulcs, id);
    detail += `, cég: ${newCegKulcs}`;
  } else if (u.role === 'manager') {
    // Üzletvezető áthelyezhető egy másik cég/telephely párosra.
    const newCegKulcs = companyKeyFromAdoszam(cegKulcs || '');
    if (newCegKulcs.length < 8) return sendJson(res, 400, { error: 'Érvénytelen adószám.' });
    const newTelephelyKod = normalizeTelephelyKod(telephelyKod || '01');
    const codes = readAccessCodes();
    if (!codes[newCegKulcs]) { codes[newCegKulcs] = { code: generateAccessCode(), email: '' }; writeAccessCodes(codes); }
    ensureTelephely(newCegKulcs, '01', 'Fő telephely');
    if (!listTelephelyek(newCegKulcs).some((t) => t.kod === newTelephelyKod)) {
      return sendJson(res, 404, { error: 'Ismeretlen telephely ennél a cégnél.' });
    }
    usersDb.prepare('UPDATE users SET nev = ?, status = ?, ceg_kulcs = ?, telephely_kod = ? WHERE id = ?').run(cleanNev, status, newCegKulcs, newTelephelyKod, id);
    detail += `, cég/telephely: ${newCegKulcs}/${newTelephelyKod}`;
  } else {
    usersDb.prepare('UPDATE users SET nev = ?, status = ? WHERE id = ?').run(cleanNev, status, id);
  }
  logActivity({ type: 'user_update', ok: true, companyKey: null, nev: 'admin', detail });
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/admin/users/delete', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { id } = await readJsonBody(req);
  const u = usersDb.prepare('SELECT id, email, role, nev FROM users WHERE id = ?').get(id);
  if (!u) return sendJson(res, 404, { error: 'Ismeretlen felhasználó.' });
  if (u.role === 'reseller') {
    const dependentCount = usersDb.prepare(`SELECT COUNT(*) AS c FROM users WHERE reseller_id = ?`).get(id).c;
    if (dependentCount > 0) {
      return sendJson(res, 400, { error: `Ez a viszonteladó ${dependentCount} céghez van rendelve — előbb azokat rendeld át vagy töröld.` });
    }
  }
  usersDb.prepare('DELETE FROM users WHERE id = ?').run(id);
  logActivity({ type: 'user_delete', ok: true, companyKey: u.ceg_kulcs || null, nev: 'admin', detail: `${u.email} (${u.role}) törölve` });
  sendJson(res, 200, { ok: true });
});

// Admin által kezdeményezett jelszó-visszaállítás — pl. ha egy felhasználó
// telefonon elakadt (rossz jelszó, zárolás), az admin KÖZVETLENÜL tud neki
// egy friss, azonnal használható linket adni, anélkül hogy a felhasználónak
// magának kellene végigmennie az "elfelejtett jelszó" e-mailes folyamaton.
// (Az admin már hitelesített/megbízható, ezért itt — a nyilvános
// "elfelejtett jelszó" végponttól eltérően — biztonságosan visszaadható a
// link közvetlenül a válaszban.)
route('POST', '/api/admin/users/reset-link', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { id } = await readJsonBody(req);
  const u = usersDb.prepare('SELECT id, email, nev, role, status FROM users WHERE id = ?').get(id);
  if (!u) return sendJson(res, 404, { error: 'Ismeretlen felhasználó.' });
  if (u.status === 'disabled') return sendJson(res, 400, { error: 'Ez a felhasználó le van tiltva — előbb aktiváld, ha jelszót akarsz neki adni.' });
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  usersDb.prepare(`UPDATE users SET invite_token = ?, invite_expires = ?, status = 'active' WHERE id = ?`).run(token, expires, id);
  const link = `${(req.headers['x-forwarded-proto'] || 'http')}://${req.headers.host}/?jelszo-visszaallitas=${token}`;
  logActivity({ type: 'password_reset_admin', ok: true, companyKey: u.ceg_kulcs || null, nev: 'admin', detail: `Admin jelszó-visszaállító linket generált: ${u.email} részére` });
  sendJson(res, 200, { ok: true, link });
});

// Bejelentkezési zárolás feloldása egy adott felhasználóra — az EMAIL
// CÍMÉHEZ tartozó összes zárolást töröljük, függetlenül attól, melyik
// IP-címről érkeztek a sikertelen próbálkozások (a felhasználó telefonja
// gyakran más IP-t kap Wifi és mobilnet között váltva, ezért nem elég
// csak egyetlen konkrét IP-t feloldani).
route('POST', '/api/admin/users/clear-lockout', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { id } = await readJsonBody(req);
  const u = usersDb.prepare('SELECT id, email, nev FROM users WHERE id = ?').get(id);
  if (!u) return sendJson(res, 404, { error: 'Ismeretlen felhasználó.' });
  const emailLower = u.email.toLowerCase();
  let removed = 0;
  for (const key of [...loginAttempts.keys()]) {
    if (key.endsWith(`::${emailLower}`)) { loginAttempts.delete(key); removed++; }
  }
  logActivity({ type: 'login_lockout_cleared', ok: true, companyKey: u.ceg_kulcs || null, nev: 'admin', detail: `Bejelentkezési zárolás feloldva: ${u.email} (${removed} bejegyzés törölve)` });
  sendJson(res, 200, { ok: true, removed });
});

// ---------------------------------------------------------------------------
// Admin — Licenc-kezelés
// ---------------------------------------------------------------------------

// Funkció-katalógus listája (aktív és kivezetett is, hogy a korábban
// kiosztott, de már kivezetett funkciók se tűnjenek el nyomtalanul).
route('GET', '/api/admin/license/features', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const rows = licenseDb.prepare(`SELECT key, nev, leiras, alap_ar, aktiv, sorrend FROM license_features ORDER BY sorrend, nev`).all();
  sendJson(res, 200, {
    features: rows.map((r) => ({ key: r.key, nev: r.nev, leiras: r.leiras || '', alapAr: r.alap_ar, aktiv: !!r.aktiv, sorrend: r.sorrend })),
  });
});

// Funkció felvétele / szerkesztése (upsert `key` alapján). Ha nincs `key`
// megadva, a névből generálunk egyet — de admin megadhat SAJÁT, explicit
// kulcsot is felvételkor (pl. hogy pontosan az androidos appban már
// hardkódolt funkció-azonosítót használja, ne egy AI-generált slugot).
// Meglévő kulcs átnevezésére (a company_licenses kiosztásokkal együtt)
// külön végpont van: /api/admin/license/features/rename-key.
// Egy már ÉLŐ, meglévő katalógusnál is biztonságosan pótolja a valós,
// Androidban hardkódolt kulcsok közül azokat, amik MÉG NINCSENEK benne —
// ami már megvan (akár a régi, AI-tippre generált néven), azt EGYÁLTALÁN
// NEM bántja. A meglévő, feleslegessé vált kulcsokat ezután kézzel,
// szabadon átnevezheted (rename-key) vagy törölheted, a saját tempódban.
route('POST', '/api/admin/license/features/seed-real', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const now = new Date().toISOString();
  const added = [];
  for (const [key, nev, leiras, alapAr, sorrend] of REAL_LICENSE_FEATURE_DEFAULTS) {
    const exists = licenseDb.prepare('SELECT 1 FROM license_features WHERE key = ?').get(key);
    if (exists) continue;
    licenseDb.prepare(
      `INSERT INTO license_features (key, nev, leiras, alap_ar, aktiv, sorrend, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)`
    ).run(key, nev, leiras, alapAr, sorrend, now);
    added.push(key);
  }
  if (added.length) {
    logActivity({ type: 'license_feature_seed_real', ok: true, companyKey: null, nev: 'admin', detail: `Hiányzó valós funkciók pótolva: ${added.join(', ')}` });
  }
  sendJson(res, 200, { ok: true, added });
});

// A katalógusban lévő, de a valós 12 azonosító közé NEM tartozó ("kamu",
// régi AI-tippre generált) bejegyzések eltávolítása — csak azokat törli,
// amik SEHOL nincsenek kiosztva egyetlen cégnél sem (ugyanaz a védelem,
// mint az egyenkénti törlésnél). Amit nem tud törölni, azt jelenti.
route('POST', '/api/admin/license/features/remove-fake', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const realKeys = new Set(REAL_LICENSE_FEATURE_DEFAULTS.map((d) => d[0]));
  const all = licenseDb.prepare('SELECT key, nev FROM license_features').all();
  const removed = [];
  const skipped = [];
  for (const f of all) {
    if (realKeys.has(f.key)) continue;
    const inUse = licenseDb.prepare('SELECT COUNT(*) AS c FROM company_licenses WHERE feature_key = ?').get(f.key).c;
    if (inUse > 0) { skipped.push(`${f.nev} (${f.key}) — ${inUse} cégnél kiosztva`); continue; }
    licenseDb.prepare('DELETE FROM license_features WHERE key = ?').run(f.key);
    removed.push(f.key);
  }
  if (removed.length) {
    logActivity({ type: 'license_feature_remove_fake', ok: true, companyKey: null, nev: 'admin', detail: `Kamu funkciók törölve: ${removed.join(', ')}` });
  }
  sendJson(res, 200, { ok: true, removed, skipped });
});

route('POST', '/api/admin/license/features/save', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const body = await readJsonBody(req);
  const nev = clampStr(body.nev, 100);
  if (!nev) return sendJson(res, 400, { error: 'A funkció nevének megadása kötelező.' });
  const alapAr = Math.max(0, parseInt(body.alapAr, 10) || 0);
  const sorrend = parseInt(body.sorrend, 10) || 0;
  const aktiv = body.aktiv === false ? 0 : 1;
  const leiras = String(body.leiras || '').trim();
  let key = String(body.key || '').trim();
  const existing = key ? licenseDb.prepare('SELECT key FROM license_features WHERE key = ?').get(key) : null;
  const isNew = !existing;
  if (isNew) {
    if (!key) {
      key = slugifyFeatureKey(nev);
      // Ütközés esetén (ugyanaz a slug már foglalt) számot fűzünk a végére.
      let candidate = key, n = 2;
      while (licenseDb.prepare('SELECT 1 FROM license_features WHERE key = ?').get(candidate)) {
        candidate = `${key}_${n}`; n += 1;
      }
      key = candidate;
    }
    licenseDb.prepare(
      `INSERT INTO license_features (key, nev, leiras, alap_ar, aktiv, sorrend, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(key, nev, leiras, alapAr, aktiv, sorrend, new Date().toISOString());
    logActivity({ type: 'license_feature_save', ok: true, companyKey: null, nev: 'admin', detail: `Új funkció felvéve: ${nev} (${key})` });
  } else {
    licenseDb.prepare(
      `UPDATE license_features SET nev = ?, leiras = ?, alap_ar = ?, aktiv = ?, sorrend = ? WHERE key = ?`
    ).run(nev, leiras, alapAr, aktiv, sorrend, key);
    logActivity({ type: 'license_feature_save', ok: true, companyKey: null, nev: 'admin', detail: `Funkció módosítva: ${nev} (${key})` });
  }
  sendJson(res, 200, { ok: true, key });
});

// Meglévő funkció-kulcs átnevezése — arra kell, ha egy korábban tippre
// felvett kulcsot utólag az androidos appban ténylegesen használt, fix
// azonosítóra kell cserélni. A már kiosztott company_licenses sorokat is
// átvezeti az új kulcsra, hogy egyetlen meglévő cég licence se vesszen el.
route('POST', '/api/admin/license/features/rename-key', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { key, ujKulcs } = await readJsonBody(req);
  const regi = String(key || '').trim();
  const uj = String(ujKulcs || '').trim();
  if (!regi || !uj) return sendJson(res, 400, { error: 'Hiányzó régi vagy új kulcs.' });
  if (regi === uj) return sendJson(res, 200, { ok: true, key: uj });
  const feature = licenseDb.prepare('SELECT key, nev FROM license_features WHERE key = ?').get(regi);
  if (!feature) return sendJson(res, 404, { error: 'Ismeretlen funkció-kulcs.' });
  if (licenseDb.prepare('SELECT 1 FROM license_features WHERE key = ?').get(uj)) {
    return sendJson(res, 400, { error: 'Az új kulcs már foglalt egy másik funkciónál.' });
  }
  licenseDb.prepare('UPDATE license_features SET key = ? WHERE key = ?').run(uj, regi);
  licenseDb.prepare('UPDATE company_licenses SET feature_key = ? WHERE feature_key = ?').run(uj, regi);
  logActivity({ type: 'license_feature_rename', ok: true, companyKey: null, nev: 'admin', detail: `Funkció-kulcs átnevezve: ${feature.nev} (${regi} → ${uj})` });
  sendJson(res, 200, { ok: true, key: uj });
});

// Funkció törlése a katalógusból — csak akkor engedjük, ha egyetlen cég
// sem rendelkezik vele (különben inkább kapcsold ki az "aktív" jelzőt).
route('POST', '/api/admin/license/features/delete', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { key, force } = await readJsonBody(req);
  const feature = licenseDb.prepare('SELECT key, nev FROM license_features WHERE key = ?').get(key);
  if (!feature) return sendJson(res, 404, { error: 'Ismeretlen funkció-kulcs.' });

  // FONTOS: csak a TÉNYLEGESEN aktív (nem letiltott, nem lejárt)
  // kiosztásokat számoljuk "használatban lévőnek" — egy régi, már
  // letiltott vagy lejárt sor a company_licenses táblában (ami
  // szándékosan megmarad, mint történeti adat) NEM jelenti azt, hogy a
  // funkció ma valakinél ténylegesen aktív lenne. Korábban ez a
  // különbségtétel hiányzott, és emiatt hamisan blokkolta a törlést.
  const allGrants = licenseDb.prepare('SELECT ceg_kulcs, aktiv, lejarat FROM company_licenses WHERE feature_key = ?').all(key);
  const activeGrants = allGrants.filter((r) => licenseRowStatus(r).allapot === 'ok');

  if (activeGrants.length > 0 && !force) {
    return sendJson(res, 400, {
      error: `Ez a funkció ${activeGrants.length} cégnél ténylegesen aktívan ki van osztva — előbb vond vissza azoknál, vagy erősítsd meg a törlést a figyelmeztetés elfogadásával.`,
      activeCount: activeGrants.length,
      canForce: true,
    });
  }

  licenseDb.prepare('DELETE FROM company_licenses WHERE feature_key = ?').run(key);
  licenseDb.prepare('DELETE FROM license_features WHERE key = ?').run(key);
  const detail = activeGrants.length > 0
    ? `Funkció törölve a katalógusból (kényszerítve, ${activeGrants.length} aktív kiosztás visszavonásával): ${feature.nev} (${key})`
    : `Funkció törölve a katalógusból: ${feature.nev} (${key})`;
  logActivity({ type: 'license_feature_delete', ok: true, companyKey: null, nev: 'admin', detail });
  sendJson(res, 200, { ok: true, revokedCount: activeGrants.length });
});

// ---------------------------------------------------------------------------
// CSOMAGOK — egyszerű, kényelmi gyűjtőnevek a katalógus funkcióira. Egy
// csomag csak azt adja meg, mely funkciók tartoznak bele; a tényleges
// hozzáférés-kiosztás mindig a meglévő company_licenses táblát írja.
// ---------------------------------------------------------------------------
route('GET', '/api/admin/license/packages', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const packages = licenseDb.prepare('SELECT id, nev, leiras, ar, aktiv, sorrend FROM license_packages ORDER BY sorrend, nev').all();
  const featureRows = licenseDb.prepare('SELECT package_id, feature_key FROM license_package_features').all();
  const featuresByPkg = new Map();
  for (const r of featureRows) {
    if (!featuresByPkg.has(r.package_id)) featuresByPkg.set(r.package_id, []);
    featuresByPkg.get(r.package_id).push(r.feature_key);
  }
  sendJson(res, 200, {
    packages: packages.map((p) => ({ ...p, aktiv: !!p.aktiv, featureKeys: featuresByPkg.get(p.id) || [] })),
  });
});

// Csomag létrehozása/módosítása — upsert id szerint (id nélkül új).
route('POST', '/api/admin/license/packages/save', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { id, nev, leiras, ar, aktiv, sorrend, featureKeys } = await readJsonBody(req);
  const cleanNev = String(nev || '').trim();
  if (!cleanNev) return sendJson(res, 400, { error: 'A csomag nevének megadása kötelező.' });
  const cleanAr = Math.max(0, parseInt(ar, 10) || 0);
  const cleanAktiv = aktiv === false ? 0 : 1;
  const cleanSorrend = parseInt(sorrend, 10) || 0;
  const cleanKeys = Array.isArray(featureKeys) ? featureKeys.filter((k) => typeof k === 'string' && k) : [];
  // Csak létező katalógus-kulcsokat fogadunk el a csomagba.
  const validKeys = new Set(licenseDb.prepare('SELECT key FROM license_features').all().map((r) => r.key));
  const finalKeys = cleanKeys.filter((k) => validKeys.has(k));

  let pkgId = id ? parseInt(id, 10) : null;
  if (pkgId) {
    const exists = licenseDb.prepare('SELECT id FROM license_packages WHERE id = ?').get(pkgId);
    if (!exists) return sendJson(res, 404, { error: 'Ismeretlen csomag.' });
    licenseDb.prepare('UPDATE license_packages SET nev = ?, leiras = ?, ar = ?, aktiv = ?, sorrend = ? WHERE id = ?')
      .run(cleanNev, leiras || null, cleanAr, cleanAktiv, cleanSorrend, pkgId);
  } else {
    const result = licenseDb.prepare(
      'INSERT INTO license_packages (nev, leiras, ar, aktiv, sorrend, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(cleanNev, leiras || null, cleanAr, cleanAktiv, cleanSorrend, new Date().toISOString());
    pkgId = Number(result.lastInsertRowid);
  }
  licenseDb.prepare('DELETE FROM license_package_features WHERE package_id = ?').run(pkgId);
  for (const key of finalKeys) {
    licenseDb.prepare('INSERT INTO license_package_features (package_id, feature_key) VALUES (?, ?)').run(pkgId, key);
  }
  logActivity({ type: 'license_package_save', ok: true, companyKey: null, nev: 'admin', detail: `Csomag mentve: ${cleanNev} (${finalKeys.length} funkció)` });
  sendJson(res, 200, { ok: true, id: pkgId });
});

route('POST', '/api/admin/license/packages/delete', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { id } = await readJsonBody(req);
  const pkg = licenseDb.prepare('SELECT nev FROM license_packages WHERE id = ?').get(id);
  if (!pkg) return sendJson(res, 404, { error: 'Ismeretlen csomag.' });
  licenseDb.prepare('DELETE FROM license_package_features WHERE package_id = ?').run(id);
  licenseDb.prepare('DELETE FROM license_packages WHERE id = ?').run(id);
  logActivity({ type: 'license_package_delete', ok: true, companyKey: null, nev: 'admin', detail: `Csomag törölve: ${pkg.nev}` });
  sendJson(res, 200, { ok: true });
});

// Egy csomag kiosztása egy cégnek — a csomagban lévő ÖSSZES funkciót
// egyszerre, ugyanazzal a lejárattal állítja be a company_licenses
// táblában (a csomag ára itt csak tájékoztató, magára a csomagra nem
// jön létre külön nyilvántartás — lásd fenti megjegyzés).
// Egy csomag funkcióinak kiosztása egy cégnek — közös logika, amit az
// admin-végpont ÉS a myPOS fizetés-visszaigazolás egyaránt meghív.
function grantPackageToCompany(cegKulcs, packageId, lejarat, jovahagyta) {
  const pkg = licenseDb.prepare('SELECT id, nev, ar FROM license_packages WHERE id = ?').get(packageId);
  if (!pkg) throw new Error('Ismeretlen csomag.');
  const keys = licenseDb.prepare('SELECT feature_key FROM license_package_features WHERE package_id = ?').all(packageId).map((r) => r.feature_key);
  if (!keys.length) throw new Error('Ennek a csomagnak nincs funkciója beállítva.');
  const cleanLejarat = /^\d{4}-\d{2}-\d{2}$/.test(lejarat || '') ? lejarat : null;
  const now = new Date().toISOString();
  for (const key of keys) {
    licenseDb.prepare(`
      INSERT INTO company_licenses (ceg_kulcs, feature_key, ar, lejarat, aktiv, jovahagyta, updated_at)
      VALUES (?, ?, 0, ?, 1, ?, ?)
      ON CONFLICT(ceg_kulcs, feature_key) DO UPDATE SET lejarat = excluded.lejarat, aktiv = 1, jovahagyta = excluded.jovahagyta, updated_at = excluded.updated_at
    `).run(cegKulcs, key, cleanLejarat, jovahagyta, now);
  }
  return { featureCount: keys.length, pkgNev: pkg.nev };
}

route('POST', '/api/admin/license/packages/grant', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { cegKulcs, packageId, lejarat } = await readJsonBody(req);
  if (!cegKulcs || !packageId) return sendJson(res, 400, { error: 'Hiányzó cégkulcs vagy csomag-azonosító.' });
  const anySite = [...companyIndex.values()].find((e) => e.cegKulcs === cegKulcs);
  if (!anySite && !listTelephelyek(cegKulcs).length) return sendJson(res, 404, { error: 'Ismeretlen cég.' });
  let result;
  try { result = grantPackageToCompany(cegKulcs, packageId, lejarat, 'admin'); }
  catch (e) { return sendJson(res, 404, { error: e.message }); }
  logActivity({
    type: 'license_package_grant', ok: true, companyKey: cegKulcs, nev: anySite?.nev || cegKulcs,
    detail: `Csomag kiosztva: ${result.pkgNev} (${result.featureCount} funkció)${lejarat ? `, lejárat: ${lejarat}` : ', nincs lejárat'}`,
  });
  sendJson(res, 200, { ok: true, featureCount: result.featureCount });
});

// Cégenkénti licenc-áttekintés — minden ismert cég (a companyIndexből,
// telephelyenként deduplikálva egyetlen céges sorra), mindegyikhez az
// összes katalógus-funkció aktuális állapotával (kiosztva/nincs kiosztva).
route('GET', '/api/admin/license/companies', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const features = licenseDb.prepare(`SELECT key, nev, alap_ar, aktiv FROM license_features ORDER BY sorrend, nev`).all();

  // Cégek deduplikálása cégkulcs szerint — egy cégnek több telephelye is
  // lehet a companyIndexben, de a licenc céges szintű, nem telephelyszintű.
  const byCeg = new Map();
  for (const entry of companyIndex.values()) {
    if (!byCeg.has(entry.cegKulcs)) byCeg.set(entry.cegKulcs, entry);
  }
  const grantsByCeg = new Map();
  for (const row of licenseDb.prepare('SELECT * FROM company_licenses').all()) {
    if (!grantsByCeg.has(row.ceg_kulcs)) grantsByCeg.set(row.ceg_kulcs, new Map());
    grantsByCeg.get(row.ceg_kulcs).set(`${row.telephely_kod}::${row.feature_key}`, row);
  }
  // Eszközszám cégenként (hány regisztrált eszköz van), a beállított
  // korláttal együtt — hogy az admin lista egyben mutassa, pl. "3 / 5".
  const deviceCountByCeg = new Map(
    licenseDb.prepare('SELECT ceg_kulcs, COUNT(*) AS c FROM company_devices GROUP BY ceg_kulcs').all()
      .map((r) => [r.ceg_kulcs, r.c])
  );
  const deviceLimitByCeg = new Map(
    licenseDb.prepare('SELECT ceg_kulcs, eszkoz_limit FROM company_device_limits').all()
      .map((r) => [r.ceg_kulcs, r.eszkoz_limit])
  );
  const subscriptionByCeg = new Map(
    licenseDb.prepare('SELECT ceg_kulcs, aktiv, megjegyzes, proba_vege, proba_kezi FROM company_subscription').all()
      .map((r) => [r.ceg_kulcs, r])
  );
  const enforceOn = isLicenseEnforceOn();

  const companies = [...byCeg.entries()].map(([cegKulcs, entry]) => {
    const grants = grantsByCeg.get(cegKulcs) || new Map();
    const licenses = features.map((f) => {
      const row = grants.get(`::${f.key}`); // '' = cégszintű (a régi, telephely-független) kiosztás
      const status = licenseRowStatus(row);
      return {
        key: f.key, nev: f.nev, alapAr: f.alap_ar, katalogusAktiv: !!f.aktiv,
        kiosztva: !!row, ar: row ? row.ar : null, lejarat: row ? row.lejarat : null,
        aktiv: row ? !!row.aktiv : false, ...status,
      };
    });
    // Telephelyenkénti bontás — az adott telephelyre TÉNYLEGESEN érvényes
    // (saját, specifikus VAGY a cégszintűről öröklődő) funkció-lista, hogy
    // az admin pontosan lássa, mi jutna érvényre egy konkrét telephelyen.
    const telephelyek = listTelephelyek(cegKulcs).map((t) => {
      const siteGrants = getCompanyLicenseGrants(cegKulcs, t.kod);
      return {
        kod: t.kod, nev: t.nev,
        licenses: features.map((f) => {
          const row = siteGrants.get(f.key);
          const status = licenseRowStatus(row);
          return {
            key: f.key, nev: f.nev, alapAr: f.alap_ar, katalogusAktiv: !!f.aktiv,
            kiosztva: !!row, ar: row ? row.ar : null, lejarat: row ? row.lejarat : null,
            aktiv: row ? !!row.aktiv : false,
            sajatTelephelySpecifikus: !!row && row.telephely_kod === t.kod,
            fizetosElofizetes: !!row && !!row.kartya_token,
            ...status,
          };
        }),
      };
    });
    const sub = subscriptionByCeg.get(cegKulcs);
    const trialEnd = enforceOn ? companyTrialEnd(cegKulcs) : null;
    const effectiveInTrial = enforceOn && !!(trialEnd && Date.now() < trialEnd.getTime());
    const effectiveTrialDaysLeft = effectiveInTrial ? Math.max(0, Math.ceil((trialEnd.getTime() - Date.now()) / 86400000)) : null;
    return {
      cegKulcs, nev: entry.nev, adoszam: entry.adoszam, varos: entry.varos, licenses, telephelyek,
      eszkozSzam: deviceCountByCeg.get(cegKulcs) || 0,
      eszkozLimit: deviceLimitByCeg.has(cegKulcs) ? deviceLimitByCeg.get(cegKulcs) : null,
      alapElofizetesAktiv: !sub || !!sub.aktiv,
      alapMegjegyzes: sub ? sub.megjegyzes : null,
      probaKezi: !!(sub && sub.proba_kezi),
      probaVege: sub && sub.proba_kezi ? sub.proba_vege : null,
      probaNapokHatra: sub && sub.proba_kezi
        ? (sub.proba_vege ? Math.max(0, Math.ceil((new Date(sub.proba_vege + 'T23:59:59') - new Date()) / 86400000)) : 0)
        : null,
      effectiveInTrial, effectiveTrialDaysLeft,
    };
  }).sort((a, b) => (a.nev || '').localeCompare(b.nev || '', 'hu'));

  sendJson(res, 200, { companies, enforceOn, features: features.map((f) => ({ key: f.key, nev: f.nev, alapAr: f.alap_ar, aktiv: !!f.aktiv })) });
});


// Az alap regisztráltság (a havidíj fizetve van-e) be/kikapcsolása egy
// cégnek — ettől FÜGGETLEN minden funkció-kiosztás, hogy az admin ne
// veszítse el a beállításokat, ha egy cég átmenetileg nem fizet, majd
// visszatér.
route('POST', '/api/admin/license/subscription', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { cegKulcs, aktiv, megjegyzes } = await readJsonBody(req);
  if (!cegKulcs) return sendJson(res, 400, { error: 'Hiányzó cégkulcs.' });
  const anySite = [...companyIndex.values()].find((e) => e.cegKulcs === cegKulcs);
  if (!anySite && !listTelephelyek(cegKulcs).length) return sendJson(res, 404, { error: 'Ismeretlen cég.' });
  const cleanAktiv = aktiv === false ? 0 : 1;
  const cleanMegjegyzes = String(megjegyzes || '').trim() || null;
  licenseDb.prepare(`
    INSERT INTO company_subscription (ceg_kulcs, aktiv, megjegyzes, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(ceg_kulcs) DO UPDATE SET aktiv = excluded.aktiv, megjegyzes = excluded.megjegyzes, updated_at = excluded.updated_at
  `).run(cegKulcs, cleanAktiv, cleanMegjegyzes, new Date().toISOString());
  logActivity({
    type: 'license_subscription', ok: true, companyKey: cegKulcs, nev: anySite?.nev || cegKulcs,
    detail: `Alap regisztráció ${cleanAktiv ? 'aktiválva' : 'szüneteltetve'}${cleanMegjegyzes ? ` — ${cleanMegjegyzes}` : ''}`,
  });
  sendJson(res, 200, { ok: true });
});

// Cégenkénti próbaidő KÉZI beállítása/felülbírálása — hány nap van hátra
// a próbaidőből, MOSTANTÓL számítva. 0 = nincs próbaidő (azonnal a
// tényleges funkció-kiosztás számít). Ha ezt egyszer beállítottad egy
// cégre, onnantól ez felülírja az automatikus (első szinkrontól
// számított) próbaidő-logikát — a "napok" mező üresen hagyásával/
// törlésével visszaállítható az automatikus viselkedés.
route('POST', '/api/admin/license/trial', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { cegKulcs, napok } = await readJsonBody(req);
  if (!cegKulcs) return sendJson(res, 400, { error: 'Hiányzó cégkulcs.' });
  const anySite2 = [...companyIndex.values()].find((e) => e.cegKulcs === cegKulcs);
  if (!anySite2 && !listTelephelyek(cegKulcs).length) return sendJson(res, 404, { error: 'Ismeretlen cég.' });

  if (napok === null || napok === '' || napok === undefined) {
    // Visszaállítás az automatikus viselkedésre.
    licenseDb.prepare(`
      INSERT INTO company_subscription (ceg_kulcs, aktiv, proba_vege, proba_kezi, updated_at) VALUES (?, 1, NULL, 0, ?)
      ON CONFLICT(ceg_kulcs) DO UPDATE SET proba_vege = NULL, proba_kezi = 0, updated_at = excluded.updated_at
    `).run(cegKulcs, new Date().toISOString());
    logActivity({ type: 'license_trial_set', ok: true, companyKey: cegKulcs, nev: anySite2?.nev || cegKulcs, detail: 'Próbaidő visszaállítva automatikusra.' });
    return sendJson(res, 200, { ok: true });
  }

  const cleanNapok = Math.max(0, parseInt(napok, 10) || 0);
  const probaVege = cleanNapok > 0 ? addDaysISO(todayIsoServer(), cleanNapok) : null;
  licenseDb.prepare(`
    INSERT INTO company_subscription (ceg_kulcs, aktiv, proba_vege, proba_kezi, updated_at) VALUES (?, 1, ?, 1, ?)
    ON CONFLICT(ceg_kulcs) DO UPDATE SET proba_vege = excluded.proba_vege, proba_kezi = 1, updated_at = excluded.updated_at
  `).run(cegKulcs, probaVege, new Date().toISOString());
  logActivity({
    type: 'license_trial_set', ok: true, companyKey: cegKulcs, nev: anySite2?.nev || cegKulcs,
    detail: cleanNapok > 0 ? `Próbaidő kézzel beállítva: ${cleanNapok} nap (lejár: ${probaVege})` : 'Próbaidő kikapcsolva (0 nap).',
  });
  sendJson(res, 200, { ok: true, probaVege });
});

// ---------------------------------------------------------------------------
// FIZETÉS — myPOS Checkout API. Lásd a fájl elején a myPOS-config
// szakaszt a szükséges környezeti változókról.
// ---------------------------------------------------------------------------

// Egy fizetés-cél (alap előfizetés / csomag / önálló funkció) áráért és
// leírásáért felelős — mindhárom esetet egy helyen kezeljük.
function resolvePaymentTarget(cel) {
  if (cel === 'alap_elofizetes') {
    const ar = parseInt(process.env.ALAP_ELOFIZETES_AR_HUF || '0', 10);
    if (!ar) throw new Error('Az alap előfizetés ára nincs beállítva (ALAP_ELOFIZETES_AR_HUF).');
    return { osszeg: ar, penznem: 'HUF', leiras: 'Alap előfizetés' };
  }
  if (cel.startsWith('csomag:')) {
    const id = parseInt(cel.slice(7), 10);
    const pkg = licenseDb.prepare('SELECT id, nev, ar FROM license_packages WHERE id = ? AND aktiv = 1').get(id);
    if (!pkg) throw new Error('Ismeretlen vagy inaktív csomag.');
    if (!pkg.ar) throw new Error('Ennek a csomagnak nincs ára beállítva.');
    return { osszeg: pkg.ar, penznem: 'HUF', leiras: `Csomag: ${pkg.nev}` };
  }
  if (cel.startsWith('funkcio:')) {
    const key = cel.slice(8);
    const f = licenseDb.prepare('SELECT key, nev, alap_ar FROM license_features WHERE key = ? AND aktiv = 1').get(key);
    if (!f) throw new Error('Ismeretlen vagy inaktív funkció.');
    if (!f.alap_ar) throw new Error('Ennek a funkciónak nincs ára beállítva.');
    return { osszeg: f.alap_ar, penznem: 'HUF', leiras: `Funkció: ${f.nev}` };
  }
  // Telephely-specifikus, HAVONTA ISMÉTLŐDŐ funkció-előfizetés — ezt
  // indítja a cég a Profil oldalán, ha egy fizetős funkciót választ ki
  // magának. Formátum: "funkcio_telephely:<telephelyKod>:<featureKey>".
  if (cel.startsWith('funkcio_telephely:')) {
    const [, telephelyKod, key] = cel.split(':');
    if (!telephelyKod || !key) throw new Error('Érvénytelen fizetési cél.');
    const f = licenseDb.prepare('SELECT key, nev, alap_ar FROM license_features WHERE key = ? AND aktiv = 1').get(key);
    if (!f) throw new Error('Ismeretlen vagy inaktív funkció.');
    if (!f.alap_ar) throw new Error('Ennek a funkciónak nincs ára beállítva.');
    return { osszeg: f.alap_ar, penznem: 'HUF', leiras: `Funkció (${telephelyKod} telephely): ${f.nev}`, telephelyKod, featureKey: key };
  }
  throw new Error('Ismeretlen fizetési cél.');
}

// Fizetés indítása — a cég bejelentkezett felhasználója kéri (owner vagy
// manager egyaránt). Visszaadja a myPOS hosted checkout oldalára mutató,
// előre aláírt POST-mezőket — a frontend ezekből épít egy automatikusan
// elküldött HTML-űrlapot, ami átirányítja a vásárlót a myPOS fizetési
// oldalára.
route('POST', '/api/payment/start', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  if (!myposConfigured()) {
    return sendJson(res, 501, { error: 'A bankkártyás fizetés még nincs beállítva a szerveren (hiányzó myPOS hozzáférési adatok) — keresd az üzemeltetőt.' });
  }
  const { cel } = await readJsonBody(req);
  let target;
  try { target = resolvePaymentTarget(String(cel || '')); }
  catch (e) { return sendJson(res, 400, { error: e.message }); }

  const isRecurring = String(cel || '').startsWith('funkcio_telephely:');
  const orderId = `LNY${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const now = new Date().toISOString();
  licenseDb.prepare(`
    INSERT INTO license_payments (order_id, ceg_kulcs, telephely_kod, feature_key, cel, osszeg, penznem, allapot, ismetlodo, letrehozva)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'FUGGOBEN', ?, ?)
  `).run(orderId, session.cegKulcs, target.telephelyKod || null, target.featureKey || null, cel, target.osszeg, target.penznem, isRecurring ? 1 : 0, now);

  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const origin = `${proto}://${req.headers.host}`;
  const fields = [
    ['IPCmethod', 'IPCPurchase'],
    ['IPCVersion', '1.4'],
    ['IPCLanguage', 'HU'],
    ['SID', process.env.MYPOS_SID],
    ['WalletNumber', process.env.MYPOS_WALLET],
    ['Amount', target.osszeg.toFixed(2)],
    ['Currency', target.penznem],
    ['OrderID', orderId],
    ['URL_OK', `${origin}/api/payment/return?order=${orderId}`],
    ['URL_Cancel', `${origin}/api/payment/return?order=${orderId}&cancelled=1`],
    ['URL_Notify', `${origin}/api/payment/notify`],
    // Havi, ismétlődő funkció-előfizetésnél KÁRTYA-TOKENT kérünk (1), hogy a
    // következő havi terhelést a vásárló újbóli átirányítása nélkül,
    // szerver-szerver hívással (IPCIAPurchase) tudjuk elindítani. FONTOS,
    // ŐSZINTE MEGJEGYZÉS: a myPOS dokumentációja szerint a tokenes,
    // automatikus terhelés ÉLES környezetben myPOS-os jóváhagyást igényel a
    // kereskedői fiókhoz — sandbox/demo módban (MYPOS_SANDBOX=1) ez
    // enélkül is tesztelhető.
    ['CardTokenRequest', isRecurring ? '1' : '0'],
    ['KeyIndex', process.env.MYPOS_KEY_INDEX || '1'],
    ['PaymentParametersRequired', '1'],
    ['PaymentMethod', '1'],
  ];
  const signature = myposSign(fields, myposPrivateKey());
  const postFields = Object.fromEntries(fields);
  postFields.Signature = signature;

  logActivity({ type: 'payment_start', ok: true, companyKey: session.cegKulcs, nev: session.nev, detail: `Fizetés indítva: ${target.leiras}, ${target.osszeg} ${target.penznem} (${orderId})` });
  sendJson(res, 200, { ok: true, checkoutUrl: MYPOS_CHECKOUT_URL, fields: postFields, orderId, leiras: target.leiras, osszeg: target.osszeg, penznem: target.penznem });
});

// A vásárló böngészője ide tér vissza a fizetés után (URL_OK/URL_Cancel) —
// ez NEM megbízható visszaigazolás (a myPOS dokumentációja is kifejezetten
// figyelmeztet erre), csak egy egyszerű "köszönjük, ellenőrizzük" oldalt
// mutat. A TÉNYLEGES visszaigazolás a lenti /api/payment/notify
// szerver-szerver hívásból érkezik.
// ---------------------------------------------------------------------------
// DEMO FIZETÉS — nincs mögötte valódi fizetési átjáró (myPOS nélkül is
// használható). A fejlesztő kifejezett kérésére: a fizetési LÉPÉS meg van
// jelenítve (kosárszerűen — több funkció is kiválasztható, majd EGY közös
// "Fizetés" gombbal, egy összesítő után), de a tényleges terhelés csak
// szimulált — azonnal "sikeresnek" jelöljük. A funkciók innentől ugyanúgy
// HAVONTA "megújulnak" (a napi ütemezett feladat automatikusan, valódi
// terhelés nélkül meghosszabbítja), amíg a cég ki nem kapcsolja őket.
// ---------------------------------------------------------------------------
const DEMO_CARD_TOKEN = 'DEMO_TOKEN';

route('POST', '/api/payment/demo-pay', async (req, res) => {
  const session = requireCegAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  if (!session.telephelyKod) return sendJson(res, 400, { error: 'Előbb válassz telephelyet.' });
  const { featureKeys } = await readJsonBody(req);
  const keys = Array.isArray(featureKeys) ? [...new Set(featureKeys.filter(Boolean))] : [];
  if (!keys.length) return sendJson(res, 400, { error: 'Nincs kiválasztott funkció.' });

  const tetelek = [];
  for (const key of keys) {
    const f = licenseDb.prepare('SELECT key, nev, alap_ar FROM license_features WHERE key = ? AND aktiv = 1').get(key);
    if (!f) return sendJson(res, 400, { error: `Ismeretlen vagy inaktív funkció: ${key}` });
    if (!f.alap_ar) return sendJson(res, 400, { error: `A(z) "${f.nev}" funkciónak nincs ára beállítva.` });
    tetelek.push({ key, nev: f.nev, osszeg: f.alap_ar });
  }

  // Számla csak akkor állítható ki, ha a cég számlázási címe hiánytalanul,
  // NAV-formátumban ki van töltve — enélkül a számla-adatszolgáltatás
  // garantáltan elutasításra kerülne, ezért a fizetést magát sem engedjük
  // elindítani.
  const billingRow = licenseDb.prepare(`SELECT * FROM company_settings WHERE ceg_kulcs = ?`).get(session.cegKulcs);
  const cimReszletekEllenorzeshez = billingRow ? {
    iranyitoszam: billingRow.szamlazasi_iranyitoszam, telepules: billingRow.szamlazasi_telepules,
    kozteruletNev: billingRow.szamlazasi_kozterulet_nev, hazszam: billingRow.szamlazasi_hazszam,
  } : {};
  if (!navAddressComplete(cimReszletekEllenorzeshez)) {
    return sendJson(res, 400, { error: 'MISSING_BILLING_ADDRESS', message: 'A fizetéshez előbb ki kell töltened a cég számlázási címét a Profil oldalon (irányítószám, település, közterület neve, házszám).' });
  }

  const orderId = `LNYDEMO${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const now = new Date().toISOString();
  const lejarat = addDaysISO(todayIsoServer(), 30);
  for (const t of tetelek) {
    licenseDb.prepare(`
      INSERT INTO license_payments (order_id, ceg_kulcs, telephely_kod, feature_key, cel, osszeg, penznem, allapot, kartya_token, ismetlodo, letrehozva, lezarva)
      VALUES (?, ?, ?, ?, ?, ?, 'HUF', 'SIKERES', ?, 1, ?, ?)
    `).run(`${orderId}-${t.key}`, session.cegKulcs, session.telephelyKod, t.key, `funkcio_telephely:${session.telephelyKod}:${t.key}`, t.osszeg, DEMO_CARD_TOKEN, now, now);

    licenseDb.prepare(`
      INSERT INTO company_licenses (ceg_kulcs, telephely_kod, feature_key, ar, lejarat, aktiv, jovahagyta, kartya_token, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(ceg_kulcs, telephely_kod, feature_key) DO UPDATE SET
        lejarat = excluded.lejarat, aktiv = 1, jovahagyta = excluded.jovahagyta, kartya_token = excluded.kartya_token, updated_at = excluded.updated_at
    `).run(session.cegKulcs, session.telephelyKod, t.key, t.osszeg, lejarat, `demo fizetés (${session.nev})`, DEMO_CARD_TOKEN, now);
  }

  const osszesen = tetelek.reduce((s, t) => s + t.osszeg, 0);
  logActivity({ type: 'payment_demo', ok: true, companyKey: session.companyKey, nev: session.nev, detail: `Demo fizetés (${session.telephelyKod}): ${tetelek.map((t) => t.nev).join(', ')} — összesen ${osszesen} HUF (${orderId})` });

  let emailWarning = null;
  try {
    await sendDemoInvoiceEmail({ cegKulcs: session.cegKulcs, tetelek: tetelek.map((t) => ({ nev: `${t.nev} (${session.telephelyKod} telephely) - havi előfizetés (demo)`, osszeg: t.osszeg })), penznem: 'HUF', orderId, ismetlodo: false });
  } catch (e) {
    console.error('[fizetés] demo számla-email hiba:', e.message);
    logActivity({ type: 'payment_invoice_email', ok: false, companyKey: session.cegKulcs, nev: null, detail: e.message });
    emailWarning = e.message;
  }

  sendJson(res, 200, { ok: true, orderId, lejarat, osszesen, emailWarning });
});

// A vásárló böngészője ide tér vissza a fizetés után (URL_OK/URL_Cancel) —
// ez NEM megbízható visszaigazolás (a myPOS dokumentációja is kifejezetten
// figyelmeztet erre), csak egy egyszerű "köszönjük, ellenőrizzük" oldalt
// mutat. A TÉNYLEGES visszaigazolás a lenti /api/payment/notify
// szerver-szerver hívásból érkezik.
route('GET', '/api/payment/return', async (req, res, query) => {
  const orderId = query.order || '';
  const cancelled = query.cancelled === '1';
  const row = licenseDb.prepare('SELECT allapot FROM license_payments WHERE order_id = ?').get(orderId);
  const html = `<!DOCTYPE html><html lang="hu"><head><meta charset="utf-8"><title>Fizetés</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
    <body style="font-family:sans-serif;text-align:center;padding:60px 20px;">
    <h2>${cancelled ? 'A fizetés megszakadt' : 'Köszönjük!'}</h2>
    <p>${cancelled ? 'Nem történt terhelés.' : `A fizetés állapota: ${row ? row.allapot : 'feldolgozás alatt'}. Ez az oldal nem a végleges visszaigazolás — pár másodpercen belül frissül a rendszerben.`}</p>
    <p><a href="/">Vissza az alkalmazásba</a></p>
    </body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

// A myPOS SZERVER-SZERVER értesítése egy fizetés eredményéről — EZ a
// megbízható forrás, nem a fenti böngésző-visszairányítás. Aláírás-
// ellenőrzés a myPOS nyilvános tanúsítványával, majd összeg/pénznem
// egyeztetés a saját nyilvántartásunkkal, mielőtt bármit jóváírnánk.
route('POST', '/api/payment/notify', async (req, res) => {
  const body = await readFormBody(req);
  const publicCert = myposPublicCert();
  if (!publicCert) {
    console.error('[fizetés] myPOS notify érkezett, de nincs beállítva MYPOS_PUBLIC_CERT_PATH — nem tudjuk ellenőrizni az aláírást, elutasítva.');
    res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('NOK');
  }
  const fieldOrder = ['IPCmethod', 'SID', 'Amount', 'Currency', 'OrderID', 'IPC_Trnref', 'RequestSTAN', 'RequestDateTime'];
  const orderedFields = fieldOrder.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]);
  const validSignature = body.Signature && myposVerify(orderedFields, body.Signature, publicCert);
  if (!validSignature) {
    logActivity({ type: 'payment_notify', ok: false, companyKey: null, nev: null, detail: `Érvénytelen aláírás — elutasítva (OrderID: ${body.OrderID || '?'})` });
    res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('NOK');
  }

  const payment = licenseDb.prepare('SELECT * FROM license_payments WHERE order_id = ?').get(body.OrderID);
  if (!payment) {
    logActivity({ type: 'payment_notify', ok: false, companyKey: null, nev: null, detail: `Ismeretlen OrderID: ${body.OrderID}` });
    res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('NOK');
  }
  const amountMatches = Math.abs(parseFloat(body.Amount) - payment.osszeg) < 0.01;
  const currencyMatches = body.Currency === payment.penznem;
  if (!amountMatches || !currencyMatches) {
    logActivity({ type: 'payment_notify', ok: false, companyKey: payment.ceg_kulcs, nev: null, detail: `Összeg/pénznem eltérés (OrderID: ${body.OrderID}) — várt: ${payment.osszeg} ${payment.penznem}, kapott: ${body.Amount} ${body.Currency}` });
    res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('NOK');
  }

  const now = new Date().toISOString();
  licenseDb.prepare(`UPDATE license_payments SET allapot = 'SIKERES', mypos_trnref = ?, kartya_token = ?, lezarva = ? WHERE order_id = ?`)
    .run(body.IPC_Trnref || null, body.CardToken || null, now, body.OrderID);

  // A fizetés tárgyának tényleges jóváírása.
  let invoiceInfo = null;
  try {
    if (payment.cel === 'alap_elofizetes') {
      const napok = parseInt(process.env.ALAP_ELOFIZETES_IDOTARTAM_NAP || '30', 10);
      licenseDb.prepare(`
        INSERT INTO company_subscription (ceg_kulcs, aktiv, megjegyzes, updated_at) VALUES (?, 1, ?, ?)
        ON CONFLICT(ceg_kulcs) DO UPDATE SET aktiv = 1, megjegyzes = excluded.megjegyzes, updated_at = excluded.updated_at
      `).run(payment.ceg_kulcs, `Fizetve myPOS-on (${body.IPC_Trnref}), ${napok} napra`, now);
    } else if (payment.cel.startsWith('csomag:')) {
      const packageId = parseInt(payment.cel.slice(7), 10);
      const napok = parseInt(process.env.ALAP_ELOFIZETES_IDOTARTAM_NAP || '30', 10);
      grantPackageToCompany(payment.ceg_kulcs, packageId, addDaysISO(todayIsoServer(), napok), `myPOS fizetés (${body.IPC_Trnref})`);
    } else if (payment.cel.startsWith('funkcio_telephely:')) {
      // Telephely-specifikus, HAVONTA ISMÉTLŐDŐ funkció-előfizetés — az
      // első, sikeres fizetéskor kapott kártya-tokent is elmentjük, hogy a
      // következő havi terhelést automatikusan, a vásárló újbóli
      // átirányítása nélkül tudjuk elindítani (lásd a lenti, napi
      // ütemezett újraterhelő feladatot).
      const napok = 30;
      const lejarat = addDaysISO(todayIsoServer(), napok);
      const feature = licenseDb.prepare('SELECT nev FROM license_features WHERE key = ?').get(payment.feature_key);
      licenseDb.prepare(`
        INSERT INTO company_licenses (ceg_kulcs, telephely_kod, feature_key, ar, lejarat, aktiv, jovahagyta, kartya_token, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(ceg_kulcs, telephely_kod, feature_key) DO UPDATE SET
          lejarat = excluded.lejarat, aktiv = 1, jovahagyta = excluded.jovahagyta, kartya_token = excluded.kartya_token, updated_at = excluded.updated_at
      `).run(payment.ceg_kulcs, payment.telephely_kod, payment.feature_key, payment.osszeg, lejarat, `myPOS fizetés (${body.IPC_Trnref})`, body.CardToken || null, now);
      invoiceInfo = { tetelek: [{ nev: `${feature?.nev || payment.feature_key} (${payment.telephely_kod} telephely) - havi előfizetés`, osszeg: payment.osszeg }], ismetlodo: false };
    } else if (payment.cel.startsWith('funkcio:')) {
      const key = payment.cel.slice(8);
      const napok = parseInt(process.env.ALAP_ELOFIZETES_IDOTARTAM_NAP || '30', 10);
      const lejarat = addDaysISO(todayIsoServer(), napok);
      licenseDb.prepare(`
        INSERT INTO company_licenses (ceg_kulcs, telephely_kod, feature_key, ar, lejarat, aktiv, jovahagyta, updated_at)
        VALUES (?, '', ?, 0, ?, 1, ?, ?)
        ON CONFLICT(ceg_kulcs, telephely_kod, feature_key) DO UPDATE SET lejarat = excluded.lejarat, aktiv = 1, jovahagyta = excluded.jovahagyta, updated_at = excluded.updated_at
      `).run(payment.ceg_kulcs, key, lejarat, `myPOS fizetés (${body.IPC_Trnref})`, now);
    }
    logActivity({ type: 'payment_notify', ok: true, companyKey: payment.ceg_kulcs, nev: null, detail: `Sikeres fizetés jóváírva: ${payment.cel}, ${payment.osszeg} ${payment.penznem} (OrderID: ${body.OrderID})` });
  } catch (e) {
    console.error('[fizetés] jóváírási hiba:', e.message);
    logActivity({ type: 'payment_notify', ok: false, companyKey: payment.ceg_kulcs, nev: null, detail: `Fizetés sikeres volt, de a jóváírás hibázott: ${e.message}` });
  }

  // A demo-számla PDF kiküldése — ez SOHA nem akaszthatja meg a fizetés
  // jóváírását, ezért teljesen külön, saját try/catch-ben fut, és a hibája
  // csak naplózásra kerül.
  if (invoiceInfo) {
    try { await sendDemoInvoiceEmail({ cegKulcs: payment.ceg_kulcs, penznem: payment.penznem, orderId: body.OrderID, ...invoiceInfo }); }
    catch (e) { console.error('[fizetés] számla-email hiba:', e.message); logActivity({ type: 'payment_invoice_email', ok: false, companyKey: payment.ceg_kulcs, nev: null, detail: e.message }); }
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});

// Admin: fizetési előzmények — minden kísérlet, nem csak a sikeresek.
// ---------------------------------------------------------------------------
// HAVI, AUTOMATIKUS ÚJRATERHELÉS — a myPOS IPCIAPurchase ("In-App Purchase")
// hívásával, a korábban (CardTokenRequest=1 mellett) kapott, tárolt kártya-
// tokennel. Ez KÖZVETLEN, szerver-szerver hívás, NEM böngésző-átirányítás —
// a vásárlónak nem kell újra megadnia a kártyaadatait.
//
// ŐSZINTE, FONTOS MEGJEGYZÉS: ez a rész a myPOS hivatalos dokumentációjában
// leírt módszert követi (IPCPurchase CardTokenRequest=1 → IPCIAPurchase
// CardToken-nel), de mivel élő myPOS-fiók/sandbox nélkül nem tudtuk
// ténylegesen tesztelni a szerver-válasz PONTOS mezőszerkezetét, ez egy
// jóhiszemű, a dokumentáció alapján legjobb tudásunk szerinti implementáció
// — élesítés előtt MINDENKÉPP tesztelendő a myPOS sandbox-fiókkal, és a
// myPOS-szal is egyeztetendő (ők explicit jelzik, hogy a tokenes,
// kártyabirtokos-jelenlét nélküli terhelést éles fiókhoz jóvá kell hagyniuk).
function parseSimpleXmlField(xml, tag) {
  const m = new RegExp(`<${tag}>([^<]*)<\\/${tag}>`, 'i').exec(xml);
  return m ? m[1] : null;
}
async function chargeRecurringToken({ cardToken, amount, currency, orderId, note }) {
  const fields = [
    ['IPCmethod', 'IPCIAPurchase'],
    ['IPCVersion', '1.4'],
    ['IPCLanguage', 'HU'],
    ['SID', process.env.MYPOS_SID],
    ['WalletNumber', process.env.MYPOS_WALLET],
    ['Amount', amount.toFixed(2)],
    ['Currency', currency],
    ['OrderID', orderId],
    ['CardToken', cardToken],
    ['KeyIndex', process.env.MYPOS_KEY_INDEX || '1'],
    ['Note', note || ''],
  ];
  const signature = myposSign(fields, myposPrivateKey());
  const params = new URLSearchParams();
  for (const [k, v] of fields) params.append(k, String(v ?? ''));
  params.append('Signature', signature);

  const resp = await fetch(MYPOS_CHECKOUT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const text = await resp.text();
  const status = parseSimpleXmlField(text, 'Status');
  const trnref = parseSimpleXmlField(text, 'IPC_Trnref') || parseSimpleXmlField(text, 'Trn_ref');
  const statusMsg = parseSimpleXmlField(text, 'StatusMsg');
  return { success: status === '0', trnref, statusMsg: statusMsg || 'ismeretlen válasz', raw: text };
}

// Napi ütemezett feladat — megkeresi azokat a telephely-specifikus,
// kártya-tokennel rendelkező funkció-előfizetéseket, amiknek MA jár le
// (vagy már lejárt) a hozzáférése, és megpróbálja újraterhelni őket.
// Sikeres terhelés: +30 nap, új demo-számla emailben. Sikertelen terhelés:
// a funkció LETILTÁSRA kerül (pontosan ahogy a fejlesztő kérte).
async function runRecurringBillingCycle() {
  const today = todayIsoServer();
  const expiring = licenseDb.prepare(`
    SELECT * FROM company_licenses
    WHERE kartya_token IS NOT NULL AND aktiv = 1 AND lejarat IS NOT NULL AND lejarat <= ?
  `).all(today);

  for (const row of expiring) {
    const feature = licenseDb.prepare('SELECT nev, alap_ar FROM license_features WHERE key = ?').get(row.feature_key);
    const amount = row.ar || feature?.alap_ar || 0;
    if (!amount) continue; // időközben ingyenessé vált — nincs mit terhelni
    const isDemo = row.kartya_token === DEMO_CARD_TOKEN;
    if (!isDemo && !myposConfigured()) continue; // valódi tokenhez myPOS-konfiguráció is kell
    const orderId = `LNYR${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    licenseDb.prepare(`
      INSERT INTO license_payments (order_id, ceg_kulcs, telephely_kod, feature_key, cel, osszeg, penznem, allapot, kartya_token, ismetlodo, letrehozva)
      VALUES (?, ?, ?, ?, ?, ?, 'HUF', 'FUGGOBEN', ?, 1, ?)
    `).run(orderId, row.ceg_kulcs, row.telephely_kod, row.feature_key, `funkcio_telephely:${row.telephely_kod}:${row.feature_key}`, amount, row.kartya_token, now);

    try {
      // DEMO-tokennel rendelkező előfizetésnél nincs valódi fizetési átjáró
      // — a fejlesztő kérésének megfelelően ez a "megújítás" mindig
      // szimuláltan sikeres, valódi terhelési kísérlet nélkül.
      const result = isDemo
        ? { success: true, trnref: `DEMO-${orderId}` }
        : await chargeRecurringToken({
            cardToken: row.kartya_token, amount, currency: 'HUF', orderId,
            note: `Havi megujitas: ${feature?.nev || row.feature_key} (${row.telephely_kod})`,
          });
      if (result.success) {
        const ujLejarat = addDaysISO(today, 30);
        licenseDb.prepare(`UPDATE company_licenses SET lejarat = ?, updated_at = ? WHERE id = ?`).run(ujLejarat, now, row.id);
        licenseDb.prepare(`UPDATE license_payments SET allapot = 'SIKERES', mypos_trnref = ?, lezarva = ? WHERE order_id = ?`).run(result.trnref, now, orderId);
        logActivity({ type: 'payment_recurring', ok: true, companyKey: row.ceg_kulcs, nev: null, detail: `Havi megújítás sikeres${isDemo ? ' (demo)' : ''}: ${feature?.nev || row.feature_key} (${row.telephely_kod}), ${amount} HUF` });
        try {
          await sendDemoInvoiceEmail({
            cegKulcs: row.ceg_kulcs, penznem: 'HUF', orderId, ismetlodo: true,
            tetelek: [{ nev: `${feature?.nev || row.feature_key} (${row.telephely_kod} telephely) - havi megújítás${isDemo ? ' (demo)' : ''}`, osszeg: amount }],
          });
        } catch (e) { console.error('[fizetés] ismétlődő számla-email hiba:', e.message); }
      } else {
        licenseDb.prepare(`UPDATE license_payments SET allapot = 'SIKERTELEN', lezarva = ? WHERE order_id = ?`).run(now, orderId);
        licenseDb.prepare(`UPDATE company_licenses SET aktiv = 0, updated_at = ? WHERE id = ?`).run(now, row.id);
        logActivity({ type: 'payment_recurring', ok: false, companyKey: row.ceg_kulcs, nev: null, detail: `Havi megújítás sikertelen (${result.statusMsg}) — a funkció letiltva: ${feature?.nev || row.feature_key} (${row.telephely_kod})` });
      }
    } catch (e) {
      licenseDb.prepare(`UPDATE license_payments SET allapot = 'SIKERTELEN', lezarva = ? WHERE order_id = ?`).run(new Date().toISOString(), orderId);
      licenseDb.prepare(`UPDATE company_licenses SET aktiv = 0, updated_at = ? WHERE id = ?`).run(new Date().toISOString(), row.id);
      logActivity({ type: 'payment_recurring', ok: false, companyKey: row.ceg_kulcs, nev: null, detail: `Havi megújítás hiba miatt sikertelen (${e.message}) — a funkció letiltva: ${feature?.nev || row.feature_key} (${row.telephely_kod})` });
    }
  }
}
// Naponta egyszer ellenőrzi a lejáró, tokenes előfizetéseket — csak akkor
// fut ténylegesen érdemben, ha van myPOS-konfiguráció.
setInterval(() => { runRecurringBillingCycle().catch((e) => console.error('[fizetés] ismétlődő terhelési ciklus hiba:', e.message)); }, 24 * 60 * 60 * 1000).unref();

// Admin: a napi ismétlődő-terhelési ciklus KÉZI elindítása — hasznos
// teszteléshez, és éles hibaelhárításhoz is (nem kell megvárni a napi
// automatikus futást, ha valamit ellenőrizni kell).
route('POST', '/api/admin/license/run-recurring-billing', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  try {
    await runRecurringBillingCycle();
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

// Admin: fizetési előzmények — minden kísérlet, nem csak a sikeresek.
route('GET', '/api/admin/payments', async (req, res, query) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const limit = Math.min(parseInt(query.limit || '100', 10) || 100, 500);
  const rows = licenseDb.prepare('SELECT * FROM license_payments ORDER BY letrehozva DESC LIMIT ?').all(limit);
  sendJson(res, 200, {
    myposConfigured: myposConfigured(),
    payments: rows.map((p) => ({
      orderId: p.order_id, cegKulcs: p.ceg_kulcs, cel: p.cel, osszeg: p.osszeg, penznem: p.penznem,
      allapot: p.allapot, myposTrnref: p.mypos_trnref, szamlaSorszam: p.szamla_sorszam, letrehozva: p.letrehozva, lezarva: p.lezarva,
    })),
  });
});

// NAV Online Számla — kapcsolat állapota és élő tesztelése. A tényleges
// XML-alapú számla-beküldés (manageInvoice) egy KÖVETKEZŐ fejlesztési
// körben készül el — ez a végpont egyelőre a hitelesítést (tokenExchange)
// teszteli, mivel ez az alapja mindennek, és élő NAV-kapcsolat nélkül
// (a fejlesztői sandbox-ban) nem tudtuk kipróbálni.
route('GET', '/api/admin/nav/status', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  sendJson(res, 200, {
    configured: navConfigured(),
    sandbox: NAV_SANDBOX,
    baseUrl: NAV_BASE_URL,
    taxNumber: process.env.NAV_TAXNUMBER || null,
    techUser: process.env.NAV_TECH_USER || null,
  });
});

route('POST', '/api/admin/nav/test-connection', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  if (!navConfigured()) return sendJson(res, 400, { error: 'A NAV-kapcsolat nincs beállítva (hiányzó környezeti változók).' });
  try {
    const result = await navTokenExchange();
    logActivity({ type: 'nav_test_connection', ok: true, companyKey: null, nev: 'admin', detail: `Sikeres NAV tokenExchange (${NAV_SANDBOX ? 'teszt' : 'éles'} környezet)` });
    sendJson(res, 200, { ok: true, tokenValidFrom: result.validFrom, tokenValidTo: result.validTo });
  } catch (e) {
    logActivity({ type: 'nav_test_connection', ok: false, companyKey: null, nev: 'admin', detail: e.message });
    sendJson(res, 500, { error: e.message });
  }
});

// A hitelesített adószámhoz (a rendszert üzemeltető cég) tartozó bejövő és
// kimenő számlák böngészése, közvetlenül a NAV Online Számla
// nyilvántartásából lekérdezve — nem csak a saját, helyben tárolt
// adatainkat mutatja, hanem TÉNYLEGESEN azt, amit a NAV is lát.
route('GET', '/api/admin/nav/invoices', async (req, res, query) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  if (!navConfigured()) return sendJson(res, 400, { error: 'A NAV-kapcsolat nincs beállítva.' });
  const direction = query.direction === 'INBOUND' ? 'INBOUND' : 'OUTBOUND';
  const page = Math.max(parseInt(query.page || '1', 10) || 1, 1);
  const dateTo = query.dateTo || todayIsoServer();
  const dateFrom = query.dateFrom || addDaysISO(dateTo, -30);
  // A NAV a lekérdezési intervallum hosszát legfeljebb 35 napban maximálja
  // — ezt itt, a hívás előtt ellenőrizzük, hogy ne kelljen felesleges
  // hálózati kört tenni egy garantáltan elutasított kéréshez.
  const napokSzama = Math.round((new Date(dateTo) - new Date(dateFrom)) / (24 * 60 * 60 * 1000));
  if (napokSzama > 35 || napokSzama < 0) {
    return sendJson(res, 400, { error: 'A lekérdezési időszak legfeljebb 35 nap lehet (ezt a NAV korlátozza).' });
  }
  try {
    const result = await navQueryInvoiceDigest({ direction, dateFrom, dateTo, page });
    sendJson(res, 200, { ...result, direction, dateFrom, dateTo });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});


// cégenként/funkciónként/havonta lebontva, plusz a ténylegesen kiküldött
// (és lemezen eltárolt) PDF-számlák listája, letölthető formában.
// ---------------------------------------------------------------------------
route('GET', '/api/admin/finance/overview', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const successfulPayments = licenseDb.prepare(`SELECT * FROM license_payments WHERE allapot = 'SIKERES'`).all();

  const cegNevByKulcs = new Map();
  for (const entry of companyIndex.values()) cegNevByKulcs.set(entry.cegKulcs, entry.nev);
  const featureNevByKey = new Map(licenseDb.prepare(`SELECT key, nev FROM license_features`).all().map((f) => [f.key, f.nev]));

  const byCompany = new Map();
  const byFeature = new Map();
  const byMonth = new Map();
  let osszesenMindenIdok = 0, osszesenIdeiEv = 0, osszesenEHonap = 0;
  const now = new Date();
  const ezHonap = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const ideiEv = String(now.getFullYear());

  for (const p of successfulPayments) {
    osszesenMindenIdok += p.osszeg;
    if (p.letrehozva.startsWith(ideiEv)) osszesenIdeiEv += p.osszeg;
    if (p.letrehozva.startsWith(ezHonap)) osszesenEHonap += p.osszeg;

    const cegNev = cegNevByKulcs.get(p.ceg_kulcs) || p.ceg_kulcs;
    if (!byCompany.has(p.ceg_kulcs)) byCompany.set(p.ceg_kulcs, { cegKulcs: p.ceg_kulcs, cegNev, osszeg: 0, darab: 0 });
    const c = byCompany.get(p.ceg_kulcs); c.osszeg += p.osszeg; c.darab += 1;

    const fKey = p.feature_key || p.cel;
    const featureNev = featureNevByKey.get(p.feature_key) || fKey;
    if (!byFeature.has(fKey)) byFeature.set(fKey, { featureKey: fKey, featureNev, osszeg: 0, darab: 0 });
    const f = byFeature.get(fKey); f.osszeg += p.osszeg; f.darab += 1;

    const honap = p.letrehozva.slice(0, 7);
    if (!byMonth.has(honap)) byMonth.set(honap, { honap, osszeg: 0, darab: 0 });
    const m = byMonth.get(honap); m.osszeg += p.osszeg; m.darab += 1;
  }

  sendJson(res, 200, {
    osszesenMindenIdok, osszesenIdeiEv, osszesenEHonap,
    cegenkent: [...byCompany.values()].sort((a, b) => b.osszeg - a.osszeg),
    funkciononkent: [...byFeature.values()].sort((a, b) => b.osszeg - a.osszeg),
    havonta: [...byMonth.values()].sort((a, b) => b.honap.localeCompare(a.honap)).slice(0, 12),
  });
});

// A kiállított számlák listája — telephely+funkció szinten tárolt sorokat
// SZÁMLA-SORSZÁM szerint csoportosítva mutatja (egy fizetés több tételt/
// funkciót is tartalmazhatott egyetlen közös számlán).
route('GET', '/api/admin/finance/invoices', async (req, res, query) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const limit = Math.min(parseInt(query.limit || '200', 10) || 200, 1000);
  const rows = licenseDb.prepare(`SELECT * FROM license_payments WHERE szamla_sorszam IS NOT NULL ORDER BY letrehozva DESC LIMIT 5000`).all();

  const cegNevByKulcs = new Map();
  for (const entry of companyIndex.values()) cegNevByKulcs.set(entry.cegKulcs, entry.nev);
  const featureNevByKey = new Map(licenseDb.prepare(`SELECT key, nev FROM license_features`).all().map((f) => [f.key, f.nev]));

  const bySzamla = new Map();
  for (const p of rows) {
    if (!bySzamla.has(p.szamla_sorszam)) {
      bySzamla.set(p.szamla_sorszam, {
        szamlaSorszam: p.szamla_sorszam, cegKulcs: p.ceg_kulcs, cegNev: cegNevByKulcs.get(p.ceg_kulcs) || p.ceg_kulcs,
        letrehozva: p.letrehozva, allapot: p.allapot, penznem: p.penznem, osszeg: 0, tetelek: [],
        pdfElerheto: !!p.szamla_pdf_fajlnev, pdfFajlnev: p.szamla_pdf_fajlnev,
        navAllapot: p.nav_allapot, navTranzakcioId: p.nav_transaction_id, navUzenet: p.nav_uzenet, orderId: p.order_id,
        navRetryCount: p.nav_retry_count, navRawResponseFajlnev: p.nav_raw_response_fajlnev,
      });
    }
    const inv = bySzamla.get(p.szamla_sorszam);
    inv.osszeg += p.osszeg;
    inv.tetelek.push({ nev: featureNevByKey.get(p.feature_key) || p.feature_key || p.cel, osszeg: p.osszeg });
  }
  const invoices = [...bySzamla.values()].sort((a, b) => b.letrehozva.localeCompare(a.letrehozva)).slice(0, limit);
  sendJson(res, 200, { invoices });
});

// A ténylegesen lemezen eltárolt PDF-számla letöltése/megnyitása.
route('GET', '/api/admin/finance/invoice-pdf', async (req, res, query) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const fajlnev = String(query.fajlnev || '').replace(/[^a-zA-Z0-9.\-]/g, '');
  if (!fajlnev) return sendJson(res, 400, { error: 'Hiányzó fájlnév.' });
  const exists = licenseDb.prepare(`SELECT 1 FROM license_payments WHERE szamla_pdf_fajlnev = ?`).get(fajlnev);
  if (!exists) return sendJson(res, 404, { error: 'Nincs ilyen számla.' });
  const filePath = path.join(INVOICES_DIR, fajlnev);
  if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'A számla PDF-fájlja nem található a szerveren.' });
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${fajlnev}"`, 'Cache-Control': 'private, max-age=3600' });
  res.end(fs.readFileSync(filePath));
});

// Egy már eltárolt számla ÚJRAKÜLDÉSE a NAV-nak (pl. korábbi hálózati vagy
// XML-hiba után). A meglévő számla-adatokból rekonstruálja az XML-t, majd
// újra beküldi — FONTOS: ezzel egy ÚJ NAV-tranzakció jön létre, a korábbi
// (sikertelen) próbálkozás nem törlődik, csak a mezők frissülnek.
route('POST', '/api/admin/finance/resend-nav', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  if (!navConfigured()) return sendJson(res, 400, { error: 'A NAV-kapcsolat nincs beállítva.' });
  const { szamlaSorszam } = await readJsonBody(req);
  if (!szamlaSorszam) return sendJson(res, 400, { error: 'Hiányzó számlasorszám.' });

  const ctx = gatherNavSubmissionContext(szamlaSorszam);
  if (!ctx) return sendJson(res, 404, { error: 'Nincs ilyen számla.' });
  if (!ctx.adoszam) return sendJson(res, 400, { error: 'A cégnek nincs ismert adószáma — NAV-beküldés nem lehetséges.' });

  const result = await attemptNavSubmission({ ...ctx, incrementRetry: true });
  logActivity({ type: 'nav_invoice_submit', ok: result.ok, companyKey: ctx.cegKulcs, nev: admin.nev || 'admin', detail: `Kézi újraküldés: ${szamlaSorszam}` });
  if (result.ok) sendJson(res, 200, { ok: true, transactionId: result.transactionId });
  else sendJson(res, 400, { error: result.error || 'A számlázási cím vagy a vevő adószáma miatt a beküldés nem történt meg — nézd meg az állapotot a listában.' });
});

// A NAV-beküldéshez szükséges összes adat összegyűjtése egy meglévő
// számlasorszám alapján — ugyanezt használja a manuális "Újraküldés" és
// az automatikus háttér-újrapróbálkozási ciklus is.
function gatherNavSubmissionContext(szamlaSorszam) {
  const rows = licenseDb.prepare(`SELECT * FROM license_payments WHERE szamla_sorszam = ?`).all(szamlaSorszam);
  if (!rows.length) return null;
  const first = rows[0];
  const anySite = [...companyIndex.values()].find((e) => e.cegKulcs === first.ceg_kulcs);
  const cegNev = anySite?.nev || first.ceg_kulcs;
  const adoszam = anySite?.adoszam || '';
  const billingRow = licenseDb.prepare(`SELECT * FROM company_settings WHERE ceg_kulcs = ?`).get(first.ceg_kulcs);
  const cimReszletek = billingRow ? {
    iranyitoszam: billingRow.szamlazasi_iranyitoszam, telepules: billingRow.szamlazasi_telepules,
    kozteruletNev: billingRow.szamlazasi_kozterulet_nev, kozteruletJelleg: billingRow.szamlazasi_kozterulet_jelleg,
    hazszam: billingRow.szamlazasi_hazszam, emelet: billingRow.szamlazasi_emelet,
  } : {};
  const featureNevByKey = new Map(licenseDb.prepare(`SELECT key, nev FROM license_features`).all().map((f) => [f.key, f.nev]));
  const tetelek = rows.map((p) => ({ nev: featureNevByKey.get(p.feature_key) || p.feature_key || p.cel, osszeg: p.osszeg }));
  return {
    cegKulcs: first.ceg_kulcs, szamlaSorszam, datum: first.letrehozva.slice(0, 10),
    cegNev, adoszam, cimReszletek, tetelek, penznem: first.penznem,
  };
}


// A NAV aszinkron dolgozza fel a beküldött számlákat — ez a végpont a
// tranzakció-azonosítóval lekérdezi a TÉNYLEGES feldolgozási eredményt
// (elfogadva / figyelmeztetéssel / elutasítva), és frissíti a tárolt
// állapotot ez alapján.
route('POST', '/api/admin/finance/check-nav-status', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  if (!navConfigured()) return sendJson(res, 400, { error: 'A NAV-kapcsolat nincs beállítva.' });
  const { szamlaSorszam } = await readJsonBody(req);
  if (!szamlaSorszam) return sendJson(res, 400, { error: 'Hiányzó számlasorszám.' });

  const row = licenseDb.prepare(`SELECT nav_transaction_id, ceg_kulcs FROM license_payments WHERE szamla_sorszam = ? AND nav_transaction_id IS NOT NULL LIMIT 1`).get(szamlaSorszam);
  if (!row?.nav_transaction_id) return sendJson(res, 404, { error: 'Ehhez a számlához nincs eltárolt NAV tranzakció-azonosító.' });

  try {
    const { ujAllapot, uzenetek } = await checkAndUpdateNavStatus(szamlaSorszam, row.nav_transaction_id, row.ceg_kulcs, admin.nev || 'admin');
    sendJson(res, 200, { ok: true, allapot: ujAllapot, uzenetek });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

// A NAV feldolgozási állapotának lekérdezése és a tárolt állapot
// frissítése — a nyers választ is elmenti. Ugyanezt hívja a manuális
// "Állapot lekérdezése" gomb ÉS az automatikus háttér-ciklus is.
async function checkAndUpdateNavStatus(szamlaSorszam, transactionId, cegKulcs, actorName) {
  const result = await navQueryTransactionStatus(transactionId);
  const ujAllapot = result.processingResult || 'FELDOLGOZÁS ALATT';
  const fajlnev = saveNavRawResponse(szamlaSorszam, 'status', result.raw);
  licenseDb.prepare(`UPDATE license_payments SET nav_allapot = ?, nav_uzenet = ?, nav_raw_response_fajlnev = ? WHERE szamla_sorszam = ?`)
    .run(ujAllapot, result.businessValidationMessages.join(' | ') || null, fajlnev, szamlaSorszam);
  logActivity({ type: 'nav_status_check', ok: true, companyKey: cegKulcs, nev: actorName, detail: `NAV állapot lekérdezve: ${szamlaSorszam} → ${ujAllapot}` });
  return { ujAllapot, uzenetek: result.businessValidationMessages };
}

// A hányszori automatikus újrapróbálkozás után adjuk fel egy tartósan
// hibás számlánál (ezután már csak kézi "Újraküldés"-sel próbálkozhat
// az admin, miután feltehetően javított valamin, pl. a számlázási címen).
const NAV_MAX_AUTO_RETRY = 10;

// AUTOMATIKUS háttér-folyamat — ETTŐL FOGVA NEM KELL KÉZZEL kattintgatni
// az "Újraküldés" vagy "Állapot lekérdezése" gombokra: ez a ciklus
// rendszeresen (naponta többször) magától:
//   1) lekérdezi a még "BEKULDVE" (feldolgozás alatt) számlák végleges
//      NAV-állapotát,
//   2) újra megpróbálja beküldeni a korábban sikertelen (HIBA, hiányzó
//      cím, érvénytelen vevő adószám, ABORTED) számlákat — de csak egy
//      ésszerű próbálkozás-szám (NAV_MAX_AUTO_RETRY) eléréséig, hogy egy
//      tartósan hibás adat ne generáljon végtelen NAV-hívást.
async function runNavAutoProcessCycle() {
  if (!navConfigured()) return;

  const bekuldve = licenseDb.prepare(`
    SELECT DISTINCT szamla_sorszam, nav_transaction_id, ceg_kulcs FROM license_payments
    WHERE nav_allapot = 'BEKULDVE' AND nav_transaction_id IS NOT NULL
  `).all();
  for (const row of bekuldve) {
    try {
      await checkAndUpdateNavStatus(row.szamla_sorszam, row.nav_transaction_id, row.ceg_kulcs, 'automatikus');
    } catch (e) {
      console.error(`[NAV] Automatikus állapot-lekérdezés hiba (${row.szamla_sorszam}): ${e.message}`);
    }
  }

  const ujrapoblalando = licenseDb.prepare(`
    SELECT DISTINCT szamla_sorszam FROM license_payments
    WHERE nav_allapot IN ('HIBA', 'HIÁNYZÓ_CÍM', 'ÉRVÉNYTELEN_VEVŐ_ADÓSZÁM', 'ABORTED') AND nav_retry_count < ?
  `).all(NAV_MAX_AUTO_RETRY);
  for (const row of ujrapoblalando) {
    const ctx = gatherNavSubmissionContext(row.szamla_sorszam);
    if (!ctx || !ctx.adoszam) continue;
    try {
      await attemptNavSubmission({ ...ctx, incrementRetry: true });
    } catch (e) {
      console.error(`[NAV] Automatikus újraküldési hiba (${row.szamla_sorszam}): ${e.message}`);
    }
  }
}
// 15 percenként fut — elég gyakori ahhoz, hogy a legtöbb státusz-változás
// hamar látszódjon, de nem terheli feleslegesen a NAV szerverét.
setInterval(() => { runNavAutoProcessCycle().catch((e) => console.error('[NAV] Automatikus ciklus hiba:', e.message)); }, 15 * 60 * 1000).unref();

// Az automatikus ciklus KÉZI, azonnali elindítása — hasznos teszteléshez,
// nem kell megvárni a 15 perces automatikus futást.
route('POST', '/api/admin/nav/run-auto-cycle', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  try {
    await runNavAutoProcessCycle();
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

// Egy adott számlához tartozó, lemezen eltárolt NYERS NAV-XML-válasz
// megtekintése/letöltése — átláthatóság és hibaelhárítás céljából.
route('GET', '/api/admin/finance/nav-response', async (req, res, query) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const fajlnev = String(query.fajlnev || '').replace(/[^a-zA-Z0-9._\-]/g, '');
  if (!fajlnev) return sendJson(res, 400, { error: 'Hiányzó fájlnév.' });
  const exists = licenseDb.prepare(`SELECT 1 FROM license_payments WHERE nav_raw_response_fajlnev = ?`).get(fajlnev);
  if (!exists) return sendJson(res, 404, { error: 'Nincs ilyen NAV-válasz.' });
  const filePath = path.join(NAV_RESPONSES_DIR, fajlnev);
  if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'A fájl nem található a szerveren.' });
  res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': `inline; filename="${fajlnev}"`, 'Cache-Control': 'private, max-age=3600' });
  res.end(fs.readFileSync(filePath));
});

// ---------------------------------------------------------------------------
// REGISZTRÁCIÓK — Cég → Telephely(ek) → Eszköz(ök) hierarchia, a régi
// LSZAMLA rendszerből importált adatokból, a saját L-NYUGTA cég-
// nyilvántartással összefésülve. Azok a cégek is megjelennek, akiknek MÉG
// nincs egyetlen regisztrációjuk sem (üresen) — és fordítva, azok a
// regisztrációk is, amikhez (még) nincs tényleges L-NYUGTA szinkron.
// ---------------------------------------------------------------------------
route('GET', '/api/admin/registrations', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });

  const companies = licenseDb.prepare('SELECT * FROM reg_companies ORDER BY nev').all();
  const sites = licenseDb.prepare('SELECT * FROM reg_sites').all();
  const devices = licenseDb.prepare('SELECT * FROM reg_devices').all();
  const sitesByCompany = new Map();
  sites.forEach((s) => {
    if (!sitesByCompany.has(s.company_id)) sitesByCompany.set(s.company_id, []);
    sitesByCompany.get(s.company_id).push(s);
  });
  const devicesBySite = new Map();
  devices.forEach((d) => {
    if (!devicesBySite.has(d.site_id)) devicesBySite.set(d.site_id, []);
    devicesBySite.get(d.site_id).push(d);
  });

  // Melyik adószámokhoz van TÉNYLEGES, élő L-NYUGTA szinkron (companyIndex)?
  const liveByAdoszam = new Map();
  for (const [key, entry] of companyIndex) {
    if (!liveByAdoszam.has(entry.adoszam)) liveByAdoszam.set(entry.adoszam, []);
    liveByAdoszam.get(entry.adoszam).push({ key, telephelyKod: entry.telephelyKod, nev: entry.nev });
  }

  const result = companies.map((c) => ({
    id: c.id, adoszam: c.adoszam, nev: c.nev,
    hasLiveSync: liveByAdoszam.has(c.adoszam),
    liveSites: liveByAdoszam.get(c.adoszam) || [],
    sites: (sitesByCompany.get(c.id) || []).map((s) => ({
      id: s.id, nev: s.nev, varos: s.varos, cim: s.cim,
      devices: (devicesBySite.get(s.id) || []).map((d) => ({
        id: d.id, uuid: d.uuid, progtip: d.progtip, verzio: d.verzio,
        regdat: d.regdat, ervdat: d.ervdat, email: d.email, telefon: d.telefon,
        kapcsnev: d.kapcsnev, regmodel: d.regmodel, regmanufacturer: d.regmanufacturer,
        statusz: d.statusz, szszelotag: d.szszelotag,
      })),
    })),
  }));

  // Azok az élő L-NYUGTA cégek is bekerülnek (üres regisztrációval), amikhez
  // MÉG nincs egyetlen reg_companies bejegyzés sem.
  const knownAdoszamok = new Set(companies.map((c) => c.adoszam));
  const seenEmpty = new Set();
  for (const [, entry] of companyIndex) {
    if (knownAdoszamok.has(entry.adoszam) || seenEmpty.has(entry.adoszam)) continue;
    seenEmpty.add(entry.adoszam);
    result.push({
      id: null, adoszam: entry.adoszam, nev: entry.nev,
      hasLiveSync: true, liveSites: liveByAdoszam.get(entry.adoszam) || [],
      sites: [],
    });
  }

  result.sort((a, b) => (a.nev || '').localeCompare(b.nev || '', 'hu'));
  sendJson(res, 200, { companies: result });
});

route('POST', '/api/admin/registrations/company/add', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { adoszam, nev } = await readJsonBody(req);
  const cleanAdoszam = clampStr(adoszam, 20);
  if (!cleanAdoszam) return sendJson(res, 400, { error: 'Az adószám megadása kötelező.' });
  const existing = licenseDb.prepare('SELECT id FROM reg_companies WHERE adoszam = ?').get(cleanAdoszam);
  if (existing) return sendJson(res, 409, { error: 'Ez az adószám már szerepel a nyilvántartásban.' });
  const result = licenseDb.prepare('INSERT INTO reg_companies (adoszam, nev, created_at) VALUES (?, ?, ?)')
    .run(cleanAdoszam, clampStr(nev, 150) || null, new Date().toISOString());
  logActivity({ type: 'reg_company_add', ok: true, companyKey: null, nev: 'admin', detail: `Regisztrációs cég felvéve: ${nev} (${cleanAdoszam})` });
  sendJson(res, 200, { ok: true, id: Number(result.lastInsertRowid) });
});

route('POST', '/api/admin/registrations/site/add', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { companyId, nev, varos, cim } = await readJsonBody(req);
  const company = licenseDb.prepare('SELECT id FROM reg_companies WHERE id = ?').get(companyId);
  if (!company) return sendJson(res, 404, { error: 'Ismeretlen cég.' });
  const result = licenseDb.prepare('INSERT INTO reg_sites (company_id, nev, varos, cim) VALUES (?, ?, ?, ?)')
    .run(companyId, clampStr(nev, 100) || 'Telephely', clampStr(varos, 80) || null, clampStr(cim, 150) || null);
  sendJson(res, 200, { ok: true, id: Number(result.lastInsertRowid) });
});

route('POST', '/api/admin/registrations/site/save', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { id, nev, varos, cim } = await readJsonBody(req);
  const site = licenseDb.prepare('SELECT id FROM reg_sites WHERE id = ?').get(id);
  if (!site) return sendJson(res, 404, { error: 'Ismeretlen telephely.' });
  licenseDb.prepare('UPDATE reg_sites SET nev = ?, varos = ?, cim = ? WHERE id = ?')
    .run(clampStr(nev, 100) || null, clampStr(varos, 80) || null, clampStr(cim, 150) || null, id);
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/admin/registrations/device/add', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const b = await readJsonBody(req);
  const site = licenseDb.prepare('SELECT id FROM reg_sites WHERE id = ?').get(b.siteId);
  if (!site) return sendJson(res, 404, { error: 'Ismeretlen telephely.' });
  const now = new Date().toISOString();
  const result = licenseDb.prepare(`
    INSERT INTO reg_devices (site_id, uuid, progtip, verzio, regdat, ervdat, email, telefon, kapcsnev, regmodel, regmanufacturer, statusz, szszelotag, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    b.siteId, clampStr(b.uuid, 80) || null, clampStr(b.progtip, 40) || null, clampStr(b.verzio, 30) || null, clampStr(b.regdat, 30) || null, clampStr(b.ervdat, 30) || null,
    clampStr(b.email, 150) || null, clampStr(b.telefon, 30) || null, clampStr(b.kapcsnev, 100) || null, clampStr(b.regmodel, 80) || null, clampStr(b.regmanufacturer, 80) || null,
    clampStr(b.statusz, 5) || 'I', clampStr(b.szszelotag, 10) || null, now, now
  );
  sendJson(res, 200, { ok: true, id: Number(result.lastInsertRowid) });
});

route('POST', '/api/admin/registrations/device/save', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const b = await readJsonBody(req);
  const device = licenseDb.prepare('SELECT id FROM reg_devices WHERE id = ?').get(b.id);
  if (!device) return sendJson(res, 404, { error: 'Ismeretlen eszköz.' });
  licenseDb.prepare(`
    UPDATE reg_devices SET uuid = ?, progtip = ?, verzio = ?, regdat = ?, ervdat = ?, email = ?, telefon = ?,
      kapcsnev = ?, regmodel = ?, regmanufacturer = ?, statusz = ?, szszelotag = ?, updated_at = ?
    WHERE id = ?
  `).run(
    clampStr(b.uuid, 80) || null, clampStr(b.progtip, 40) || null, clampStr(b.verzio, 30) || null, clampStr(b.regdat, 30) || null, clampStr(b.ervdat, 30) || null,
    clampStr(b.email, 150) || null, clampStr(b.telefon, 30) || null, clampStr(b.kapcsnev, 100) || null, clampStr(b.regmodel, 80) || null, clampStr(b.regmanufacturer, 80) || null,
    clampStr(b.statusz, 5) || null, clampStr(b.szszelotag, 10) || null, new Date().toISOString(), b.id
  );
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/admin/registrations/device/delete', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { id } = await readJsonBody(req);
  licenseDb.prepare('DELETE FROM reg_devices WHERE id = ?').run(id);
  sendJson(res, 200, { ok: true });
});

// Licenc kiosztása / módosítása egy cégnek egy adott funkcióra — upsert.
route('POST', '/api/admin/license/grant', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { cegKulcs, telephelyKod, featureKey, ar, lejarat, aktiv } = await readJsonBody(req);
  if (!cegKulcs || !featureKey) return sendJson(res, 400, { error: 'Hiányzó cégkulcs vagy funkció-kulcs.' });
  const anySite = [...companyIndex.values()].find((e) => e.cegKulcs === cegKulcs);
  if (!anySite && !listTelephelyek(cegKulcs).length) return sendJson(res, 404, { error: 'Ismeretlen cég.' });
  const feature = licenseDb.prepare('SELECT key, nev FROM license_features WHERE key = ?').get(featureKey);
  if (!feature) return sendJson(res, 404, { error: 'Ismeretlen funkció-kulcs.' });
  const cleanAr = Math.max(0, parseInt(ar, 10) || 0);
  const cleanLejarat = /^\d{4}-\d{2}-\d{2}$/.test(lejarat || '') ? lejarat : null;
  const cleanAktiv = aktiv === false ? 0 : 1;
  const cleanTelephely = clampStr(telephelyKod, 40) || '';
  licenseDb.prepare(`
    INSERT INTO company_licenses (ceg_kulcs, telephely_kod, feature_key, ar, lejarat, aktiv, jovahagyta, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ceg_kulcs, telephely_kod, feature_key) DO UPDATE SET ar = excluded.ar, lejarat = excluded.lejarat, aktiv = excluded.aktiv, jovahagyta = excluded.jovahagyta, updated_at = excluded.updated_at
  `).run(cegKulcs, cleanTelephely, featureKey, cleanAr, cleanLejarat, cleanAktiv, 'admin', new Date().toISOString());
  const scopeLabel = cleanTelephely ? ` (${cleanTelephely} telephely)` : ' (teljes cég)';
  logActivity({
    type: 'license_grant', ok: true, companyKey: cegKulcs, nev: anySite?.nev || cegKulcs,
    detail: `Licenc frissítve${scopeLabel} — ${feature.nev}: ${cleanAr} Ft${cleanLejarat ? `, lejárat: ${cleanLejarat}` : ', nincs lejárat'}${cleanAktiv ? '' : ' (letiltva)'}`,
  });
  sendJson(res, 200, { ok: true });
});

// Licenc visszavonása (a kiosztás teljes törlése — a cég ismét
// "nincs regisztráció" állapotba kerül az adott funkcióra).
route('POST', '/api/admin/license/revoke', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { cegKulcs, telephelyKod, featureKey } = await readJsonBody(req);
  const cleanTelephely = clampStr(telephelyKod, 40) || '';
  const feature = licenseDb.prepare('SELECT nev FROM license_features WHERE key = ?').get(featureKey);
  const changes = licenseDb.prepare('DELETE FROM company_licenses WHERE ceg_kulcs = ? AND telephely_kod = ? AND feature_key = ?').run(cegKulcs, cleanTelephely, featureKey).changes;
  if (!changes) return sendJson(res, 404, { error: 'Ez a cég (ezen a telephelyen) nem rendelkezik ezzel a funkcióval.' });
  const scopeLabel = cleanTelephely ? ` (${cleanTelephely} telephely)` : ' (teljes cég)';
  logActivity({ type: 'license_revoke', ok: true, companyKey: cegKulcs, nev: 'admin', detail: `Licenc visszavonva${scopeLabel}: ${feature?.nev || featureKey}` });
  sendJson(res, 200, { ok: true });
});

// Cég eszközkorlátjának beállítása/módosítása — ha eszkozLimit 0 vagy
// hiányzik, a korlát törlődik (ismét korlátlan lesz, ez az alapállapot).
route('POST', '/api/admin/license/device-limit', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { cegKulcs, eszkozLimit } = await readJsonBody(req);
  if (!cegKulcs) return sendJson(res, 400, { error: 'Hiányzó cégkulcs.' });
  const anySite = [...companyIndex.values()].find((e) => e.cegKulcs === cegKulcs);
  if (!anySite && !listTelephelyek(cegKulcs).length) return sendJson(res, 404, { error: 'Ismeretlen cég.' });
  const limit = parseInt(eszkozLimit, 10) || 0;
  if (limit <= 0) {
    licenseDb.prepare('DELETE FROM company_device_limits WHERE ceg_kulcs = ?').run(cegKulcs);
    logActivity({ type: 'license_device_limit', ok: true, companyKey: cegKulcs, nev: anySite?.nev || cegKulcs, detail: 'Eszközkorlát törölve (korlátlan).' });
  } else {
    licenseDb.prepare(`
      INSERT INTO company_device_limits (ceg_kulcs, eszkoz_limit, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(ceg_kulcs) DO UPDATE SET eszkoz_limit = excluded.eszkoz_limit, updated_at = excluded.updated_at
    `).run(cegKulcs, limit, new Date().toISOString());
    logActivity({ type: 'license_device_limit', ok: true, companyKey: cegKulcs, nev: anySite?.nev || cegKulcs, detail: `Eszközkorlát beállítva: ${limit} db.` });
  }
  sendJson(res, 200, { ok: true });
});

// Egy cég regisztrált eszközeinek listája + a beállított korlát — az admin
// felület ebből rakja ki, hogy pl. "3 / 5 eszköz foglalt".
route('GET', '/api/admin/license/devices', async (req, res, query) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const cegKulcs = String(query.cegKulcs || '').trim();
  if (!cegKulcs) return sendJson(res, 400, { error: 'Hiányzó cégkulcs.' });
  const limitRow = licenseDb.prepare('SELECT eszkoz_limit FROM company_device_limits WHERE ceg_kulcs = ?').get(cegKulcs);
  const devices = licenseDb.prepare(
    'SELECT id, eszkoz_azonosito, telephely_kod, nev, progtip, verzio, elso_latott, utolso_latott FROM company_devices WHERE ceg_kulcs = ? ORDER BY elso_latott'
  ).all(cegKulcs);
  sendJson(res, 200, {
    cegKulcs,
    eszkozLimit: limitRow ? limitRow.eszkoz_limit : null,
    devices: devices.map((d) => ({
      id: d.id, eszkozAzonosito: d.eszkoz_azonosito, telephelyKod: d.telephely_kod, nev: d.nev,
      progtip: d.progtip, verzio: d.verzio, elsoLatott: d.elso_latott, utolsoLatott: d.utolso_latott,
    })),
  });
});

// Egy eszköz saját, kényelmi neve (pl. "1-es kassza") — az admin adja
// meg, az app maga csak az UUID-t és a programtípust küldi.
route('POST', '/api/admin/license/devices/rename', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { id, nev } = await readJsonBody(req);
  const device = licenseDb.prepare('SELECT id FROM company_devices WHERE id = ?').get(id);
  if (!device) return sendJson(res, 404, { error: 'Ismeretlen eszköz.' });
  licenseDb.prepare('UPDATE company_devices SET nev = ? WHERE id = ?').run(String(nev || '').trim() || null, id);
  sendJson(res, 200, { ok: true });
});

// Programtípus-katalógus — melyik androidos app-változatokat láttuk már
// valaha szinkronizálni (automatikusan bővül, lásd recordDeviceSync).
route('GET', '/api/admin/license/program-types', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const types = licenseDb.prepare('SELECT kulcs, nev, elso_latott FROM program_tipusok ORDER BY kulcs').all();
  sendJson(res, 200, { types });
});

// Egy eszköz eltávolítása a cég regisztrált eszközei közül — pl. ha az
// ügyfél lecserélt egy telefont, ezzel szabadul fel a helye az újnak.
route('POST', '/api/admin/license/devices/remove', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { id } = await readJsonBody(req);
  const device = licenseDb.prepare('SELECT ceg_kulcs, eszkoz_azonosito FROM company_devices WHERE id = ?').get(id);
  if (!device) return sendJson(res, 404, { error: 'Ismeretlen eszköz.' });
  licenseDb.prepare('DELETE FROM company_devices WHERE id = ?').run(id);
  const anySite = [...companyIndex.values()].find((e) => e.cegKulcs === device.ceg_kulcs);
  logActivity({
    type: 'license_device_remove', ok: true, companyKey: device.ceg_kulcs, nev: anySite?.nev || device.ceg_kulcs,
    detail: `Eszköz eltávolítva a regisztráltak közül: ${device.eszkoz_azonosito}`,
  });
  sendJson(res, 200, { ok: true });
});


// ---------------------------------------------------------------------------
// Összehasonlítás — rugalmas, mód-alapú elemzési motor. Minden mód pontosan
// két, azonos hosszúságú időszakot (A és B) állít elő különböző logika
// szerint, utána egy KÖZÖS számítás fut le mindkettőre (napi sorozat, hét
// napjai szerinti bontás, cikk-mozgások, automatikus szöveges elemzés).
// ---------------------------------------------------------------------------
function addDaysISO(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function addMonthsISO(iso, months) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}
function addYearsISO(iso, years) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}
function spanDaysOf(from, to) { return Math.round((new Date(to) - new Date(from)) / 86400000) + 1; }
function weekdayOfISO(iso) { return new Date(iso + 'T00:00:00Z').getUTCDay(); }
function mondayOfWeek(iso) {
  const wd = weekdayOfISO(iso); // 0=vasárnap
  const back = wd === 0 ? 6 : wd - 1;
  return addDaysISO(iso, -back);
}

function periodRevenue(k, from, to, cikk) {
  if (cikk) {
    const r = get(k,
      `SELECT IFNULL(SUM(nt.sorbrutto),0) AS revenue, IFNULL(SUM(nt.menny),0) AS menny, COUNT(DISTINCT nf.bsz) AS cnt
       FROM nytet nt JOIN nyfej nf ON nf.bsz = nt.bsz
       WHERE nf.keltdat BETWEEN ? AND ? AND ${notStorno('nf')} AND nt.megnevezes = ?`,
      [from, to, cikk]
    );
    return { revenue: r.revenue, cnt: r.cnt, menny: r.menny };
  }
  return get(k,
    `SELECT COUNT(*) AS cnt, IFNULL(SUM(bruttokp+bruttoafr+bruttokartya),0) AS revenue
     FROM nyfej WHERE keltdat BETWEEN ? AND ? AND ${NOT_STORNO}`,
    [from, to]
  );
}
function dailySeries(k, from, to, cikk) {
  const rows = cikk
    ? all(k,
        `SELECT nf.keltdat AS d, IFNULL(SUM(nt.sorbrutto),0) AS revenue
         FROM nytet nt JOIN nyfej nf ON nf.bsz = nt.bsz
         WHERE nf.keltdat BETWEEN ? AND ? AND ${notStorno('nf')} AND nt.megnevezes = ? GROUP BY nf.keltdat`,
        [from, to, cikk]
      )
    : all(k,
        `SELECT keltdat AS d, IFNULL(SUM(bruttokp+bruttoafr+bruttokartya),0) AS revenue
         FROM nyfej WHERE keltdat BETWEEN ? AND ? AND ${NOT_STORNO} GROUP BY keltdat`,
        [from, to]
      );
  const map = new Map(rows.map((r) => [r.d, r.revenue]));
  const out = [];
  let d = from, i = 0;
  while (d <= to) { out.push({ idx: i, d, revenue: map.get(d) || 0 }); d = addDaysISO(d, 1); i++; }
  return out;
}
function weekdayBreakdown(k, from, to, cikk) {
  const rows = cikk
    ? all(k,
        `SELECT CAST(strftime('%w', nf.keltdat) AS INTEGER) AS wd,
                IFNULL(SUM(nt.sorbrutto),0) AS revenue, COUNT(DISTINCT nf.keltdat) AS napok
         FROM nytet nt JOIN nyfej nf ON nf.bsz = nt.bsz
         WHERE nf.keltdat BETWEEN ? AND ? AND ${notStorno('nf')} AND nt.megnevezes = ? GROUP BY wd`,
        [from, to, cikk]
      )
    : all(k,
        `SELECT CAST(strftime('%w', keltdat) AS INTEGER) AS wd,
                IFNULL(SUM(bruttokp+bruttoafr+bruttokartya),0) AS revenue, COUNT(DISTINCT keltdat) AS napok
         FROM nyfej WHERE keltdat BETWEEN ? AND ? AND ${NOT_STORNO} GROUP BY wd`,
        [from, to]
      );
  const byWd = new Map(rows.map((r) => [r.wd, r]));
  const labels = ['Vasárnap', 'Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek', 'Szombat'];
  return labels.map((label, wd) => {
    const r = byWd.get(wd);
    return { wd, label, avgRevenue: r && r.napok ? Math.round(r.revenue / r.napok) : 0 };
  });
}
function productMovers(k, fromA, toA, fromB, toB) {
  const a = all(k,
    `SELECT nt.megnevezes AS nev, IFNULL(SUM(nt.sorbrutto),0) AS revenue, IFNULL(SUM(nt.menny),0) AS menny
     FROM nytet nt JOIN nyfej nf ON nf.bsz = nt.bsz WHERE nf.keltdat BETWEEN ? AND ? AND ${notStorno('nf')} GROUP BY nt.megnevezes`,
    [fromA, toA]
  );
  const b = all(k,
    `SELECT nt.megnevezes AS nev, IFNULL(SUM(nt.sorbrutto),0) AS revenue, IFNULL(SUM(nt.menny),0) AS menny
     FROM nytet nt JOIN nyfej nf ON nf.bsz = nt.bsz WHERE nf.keltdat BETWEEN ? AND ? AND ${notStorno('nf')} GROUP BY nt.megnevezes`,
    [fromB, toB]
  );
  const bMap = new Map(b.map((p) => [p.nev, p]));
  const names = new Set([...a.map((p) => p.nev), ...b.map((p) => p.nev)]);
  const movers = [...names].map((nev) => {
    const pa = a.find((p) => p.nev === nev) || { revenue: 0, menny: 0 };
    const pb = bMap.get(nev) || { revenue: 0, menny: 0 };
    return { nev, aRevenue: pa.revenue, bRevenue: pb.revenue, deltaRevenue: pa.revenue - pb.revenue, deltaMenny: pa.menny - pb.menny };
  }).sort((x, y) => Math.abs(y.deltaRevenue) - Math.abs(x.deltaRevenue));
  return { gainers: movers.filter((m) => m.deltaRevenue > 0).slice(0, 8), losers: movers.filter((m) => m.deltaRevenue < 0).slice(0, 8) };
}
function pctChange(a, b) { if (!b) return a > 0 ? 100 : 0; return Math.round(((a - b) / b) * 1000) / 10; }

// Rövid, legfeljebb ~50 szavas, automatikusan generált, "szakértői szemű"
// elemzés-szöveg — a tényleges számított adatokra reagál, sablon-alapon.
function buildAnalysisText({ labelA, labelB, revenueA, revenueB, weekdayA, weekdayB, movers }) {
  const delta = pctChange(revenueA, revenueB);
  const parts = [];
  if (revenueB === 0 && revenueA === 0) {
    parts.push(`Egyik időszakban sincs forgalom — nincs miből következtetni.`);
    return parts.join(' ');
  }
  const irany = delta > 0 ? 'nőtt' : delta < 0 ? 'csökkent' : 'nem változott';
  parts.push(`A forgalom ${Math.abs(delta)}%-kal ${irany} (${labelA}: ${Math.round(revenueA).toLocaleString('hu-HU')} Ft, ${labelB}: ${Math.round(revenueB).toLocaleString('hu-HU')} Ft).`);

  if (weekdayA && weekdayB) {
    let bestWd = null, bestDelta = -Infinity;
    for (let i = 0; i < weekdayA.length; i++) {
      const d = weekdayA[i].avgRevenue - weekdayB[i].avgRevenue;
      if (Math.abs(d) > Math.abs(bestDelta)) { bestDelta = d; bestWd = weekdayA[i].label; }
    }
    if (bestWd && Math.abs(bestDelta) > 0) {
      parts.push(`A legnagyobb eltérés ${bestWd}-n mutatkozik (${bestDelta > 0 ? '+' : ''}${Math.round(bestDelta).toLocaleString('hu-HU')} Ft/nap átlagosan).`);
    }
  }
  if (movers && (movers.gainers.length || movers.losers.length)) {
    const top = movers.gainers[0] || movers.losers[0];
    if (top) {
      const irany2 = top.deltaRevenue > 0 ? 'húzta leginkább a növekedést' : 'okozta leginkább a visszaesést';
      parts.push(`A(z) "${top.nev}" ${irany2} (${top.deltaRevenue > 0 ? '+' : ''}${Math.round(top.deltaRevenue).toLocaleString('hu-HU')} Ft).`);
    }
  }
  return parts.join(' ');
}

function computeComparison(k, periodA, periodB, cikk) {
  const a = periodRevenue(k, periodA.from, periodA.to, cikk);
  const b = periodRevenue(k, periodB.from, periodB.to, cikk);
  const dailyA = dailySeries(k, periodA.from, periodA.to, cikk);
  const dailyB = dailySeries(k, periodB.from, periodB.to, cikk);
  const weekdayA = weekdayBreakdown(k, periodA.from, periodA.to, cikk);
  const weekdayB = weekdayBreakdown(k, periodB.from, periodB.to, cikk);
  const movers = cikk ? null : productMovers(k, periodA.from, periodA.to, periodB.from, periodB.to);
  const analysis = buildAnalysisText({
    labelA: periodA.label, labelB: periodB.label,
    revenueA: a.revenue, revenueB: b.revenue, weekdayA, weekdayB, movers,
  });
  return {
    periodA: { ...periodA, revenue: a.revenue, receiptCount: a.cnt },
    periodB: { ...periodB, revenue: b.revenue, receiptCount: b.cnt },
    deltaPct: pctChange(a.revenue, b.revenue),
    dailyA, dailyB, weekdayA, weekdayB, movers, analysis,
  };
}

route('GET', '/api/compare', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const k = session.companyKey;
  const mode = query.mode || '';
  const cikk = query.cikk ? String(query.cikk) : null;
  const today = todayIsoServer();
  let periodA, periodB;

  if (mode === 'years') {
    const yA = parseInt(query.yearA, 10), yB = parseInt(query.yearB, 10);
    if (!yA || !yB) return sendJson(res, 400, { error: 'Válassz ki két évet.' });
    periodA = { from: `${yA}-01-01`, to: `${yA}-12-31`, label: String(yA) };
    periodB = { from: `${yB}-01-01`, to: `${yB}-12-31`, label: String(yB) };
  } else if (mode === 'ytd') {
    const y = parseInt(today.slice(0, 4), 10);
    periodA = { from: `${y}-01-01`, to: today, label: `${y} eddig` };
    periodB = { from: `${y - 1}-01-01`, to: addYearsISO(today, -1), label: `${y - 1} azonos időszaka` };
  } else if (mode === 'month') {
    const monthStart = today.slice(0, 8) + '01';
    const prevMonthStart = addMonthsISO(monthStart, -1);
    const prevMonthSameDay = addMonthsISO(today, -1);
    periodA = { from: monthStart, to: today, label: 'Ez a hónap (eddig)' };
    periodB = { from: prevMonthStart, to: prevMonthSameDay, label: 'Előző hónap (azonos hosszban)' };
  } else if (mode === 'same-month-last-year') {
    const monthStart = today.slice(0, 8) + '01';
    const dayOfMonth = parseInt(today.slice(8, 10), 10);
    const lastYearMonthStart = addYearsISO(monthStart, -1);
    // Ha a hónap tört (pl. ma a hónap 18. napja), az előző év azonos
    // hónapját is CSAK ugyanaddig a napig nézzük, ne a teljes hónapig —
    // rövidebb hónapnál (pl. február) a hónap tényleges utolsó napjára
    // szorítva, hogy sose lépjünk át a következő hónapba.
    const lastYearMonthEndFull = addDaysISO(addMonthsISO(lastYearMonthStart, 1), -1);
    const lastYearSameDay = addDaysISO(lastYearMonthStart, dayOfMonth - 1);
    const lastYearTo = lastYearSameDay <= lastYearMonthEndFull ? lastYearSameDay : lastYearMonthEndFull;
    periodA = { from: monthStart, to: today, label: 'Ez a hónap (eddig)' };
    periodB = { from: lastYearMonthStart, to: lastYearTo, label: 'Előző év, ugyanez a hónap (azonos napig)' };
  } else if (mode === 'week') {
    const mondayThis = mondayOfWeek(today);
    periodA = { from: mondayThis, to: today, label: 'Ez a hét (eddig)' };
    periodB = { from: addDaysISO(mondayThis, -7), to: addDaysISO(today, -7), label: 'Előző hét (azonos hosszban)' };
  } else if (mode === 'custom') {
    const { fromA, toA, fromB, toB } = query;
    if (!fromA || !toA || !fromB || !toB) return sendJson(res, 400, { error: 'Add meg mind a két időszak kezdő és záró dátumát.' });
    const lenA = spanDaysOf(fromA, toA), lenB = spanDaysOf(fromB, toB);
    if (lenA !== lenB) return sendJson(res, 400, { error: `A két időszaknak azonos hosszúnak kell lennie (jelenleg ${lenA} vs. ${lenB} nap).` });
    periodA = { from: fromA, to: toA, label: `${fromA} – ${toA}` };
    periodB = { from: fromB, to: toB, label: `${fromB} – ${toB}` };
  } else if (mode === 'weekday') {
    // Nem A/B összehasonlítás, hanem EGY adott hét-napjának minden
    // előfordulása egy kiválasztott időszakon belül — trendként.
    const { from, to } = query;
    const wd = parseInt(query.weekday, 10);
    if (!from || !to || Number.isNaN(wd)) return sendJson(res, 400, { error: 'Add meg az időszakot és a hét napját.' });
    const rows = cikk
      ? all(k,
          `SELECT nf.keltdat AS d, IFNULL(SUM(nt.sorbrutto),0) AS revenue
           FROM nytet nt JOIN nyfej nf ON nf.bsz = nt.bsz
           WHERE nf.keltdat BETWEEN ? AND ? AND ${notStorno('nf')} AND nt.megnevezes = ?
             AND CAST(strftime('%w', nf.keltdat) AS INTEGER) = ?
           GROUP BY nf.keltdat ORDER BY nf.keltdat`,
          [from, to, cikk, wd]
        )
      : all(k,
          `SELECT keltdat AS d, IFNULL(SUM(bruttokp+bruttoafr+bruttokartya),0) AS revenue
           FROM nyfej WHERE keltdat BETWEEN ? AND ? AND ${NOT_STORNO} AND CAST(strftime('%w', keltdat) AS INTEGER) = ?
           GROUP BY keltdat ORDER BY keltdat`,
          [from, to, wd]
        );
    const labels = ['Vasárnap', 'Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek', 'Szombat'];
    const avg = rows.length ? rows.reduce((s, r) => s + r.revenue, 0) / rows.length : 0;
    const max = rows.reduce((m, r) => Math.max(m, r.revenue), 0);
    const trend = rows.length >= 2 ? pctChange(rows[rows.length - 1].revenue, rows[0].revenue) : 0;
    const analysis = rows.length
      ? `${rows.length} ${labels[wd].toLowerCase()} volt a vizsgált időszakban, átlagosan ${Math.round(avg).toLocaleString('hu-HU')} Ft forgalommal. ` +
        `A legerősebb nap ${Math.round(max).toLocaleString('hu-HU')} Ft-ot hozott. ` +
        `Az első és az utolsó előfordulás között ${trend > 0 ? '+' : ''}${trend}% a változás.`
      : `Nincs adat a kiválasztott napra ebben az időszakban.`;
    return sendJson(res, 200, { mode, weekday: wd, weekdayLabel: labels[wd], from, to, points: rows, avg: Math.round(avg), analysis });
  } else {
    return sendJson(res, 400, { error: 'Ismeretlen vagy hiányzó mód.' });
  }

  sendJson(res, 200, { mode, cikk, ...computeComparison(k, periodA, periodB, cikk) });
});

route('GET', '/api/compare/products', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const k = session.companyKey;
  const q = String(query.q || '').trim();
  const rows = all(k,
    `SELECT DISTINCT megnevezes AS nev FROM cikkt WHERE status='A' ${q ? 'AND megnevezes LIKE ?' : ''} ORDER BY megnevezes LIMIT 30`,
    q ? [`%${q}%`] : []
  );
  sendJson(res, 200, { items: rows.map((r) => r.nev) });
});

// ---------------------------------------------------------------------------
// Nyitvatartás-optimalizálás — hét napja szerint összeveti a TÉNYLEGESEN
// rögzített nyitvatartást a valós, óránkénti forgalmi eloszlással, hogy
// megmutassa: van-e "holt" (nyitva, de érdemi eladás nélküli) időszak a
// nyitvatartás szélein, vagy fordítva — zárás közelében is van-e még
// számottevő forgalom, ami esetleg hosszabbítást indokolna.
// ---------------------------------------------------------------------------
route('GET', '/api/analysis/opening-hours', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const k = session.companyKey;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : todayIsoServer();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : addDaysISO(to, -89);

  const labels = ['Vasárnap', 'Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek', 'Szombat'];

  // Tényleges, rögzített nyitvatartás átlaga hét napja szerint, PLUSZ maguk
  // a konkrét dátumok is (ez kell az óránkénti ÁTLAG/MEDIÁN helyes
  // számításához — enélkül a "nulla forgalmú óra" napok kimaradnának a
  // nevezőből, és torzítanák az átlagot).
  const openDaysRaw = all(k,
    `SELECT targynap, CAST(strftime('%w', targynap) AS INTEGER) AS wd,
            CAST(strftime('%H', nyitas) AS INTEGER) + CAST(strftime('%M', nyitas) AS INTEGER)/60.0 AS nyitasOra,
            CAST(strftime('%H', zaras) AS INTEGER) + CAST(strftime('%M', zaras) AS INTEGER)/60.0 AS zarasOra
     FROM ntaknapzaras WHERE targynap BETWEEN ? AND ? AND nyitas IS NOT NULL AND zaras IS NOT NULL`,
    [from, to]
  );
  const datesByWd = new Map(); // wd -> [targynap, ...]
  const openByWd = new Map(); // wd -> {nyitasOra: atlag, zarasOra: atlag, napok}
  for (let wd = 0; wd < 7; wd++) datesByWd.set(wd, []);
  const sumsByWd = new Map();
  openDaysRaw.forEach((r) => {
    datesByWd.get(r.wd).push(r.targynap);
    if (!sumsByWd.has(r.wd)) sumsByWd.set(r.wd, { nyitasSum: 0, zarasSum: 0, n: 0 });
    const s = sumsByWd.get(r.wd);
    s.nyitasSum += r.nyitasOra; s.zarasSum += r.zarasOra; s.n++;
  });
  for (const [wd, s] of sumsByWd) {
    openByWd.set(wd, { nyitasOra: s.nyitasSum / s.n, zarasOra: s.zarasSum / s.n, napok: s.n });
  }

  // Óránkénti forgalom ÉS nyugtaszám, DÁTUMONKÉNT (nem összesítve) — a
  // nyugta TÉNYLEGES kezdési időpontja (rendkezdatum) alapján, hogy utána
  // a JS oldalon kiszámolhassuk a helyes, óránkénti ÁTLAGOT és MEDIÁNT
  // MINDHÁROM mutatóra (forgalom, nyugtaszám, kosárérték) — a nulla
  // forgalmú órákat/napokat is figyelembe véve a nevezőben.
  const perDateHourly = all(k,
    `SELECT keltdat, CAST(strftime('%H', rendkezdatum) AS INTEGER) AS hh,
            COUNT(*) AS nyugtaszam,
            IFNULL(SUM(bruttokp+bruttoafr+bruttokartya),0) AS revenue
     FROM nyfej WHERE keltdat BETWEEN ? AND ? AND rendkezdatum IS NOT NULL AND ${NOT_STORNO}
     GROUP BY keltdat, hh`,
    [from, to]
  );
  const dateHourMap = new Map(); // "date-hh" -> { revenue, nyugtaszam }
  perDateHourly.forEach((r) => dateHourMap.set(`${r.keltdat}-${r.hh}`, { revenue: r.revenue, nyugtaszam: r.nyugtaszam }));

  function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  }
  function avgOf(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }

  const fmtHH = (dec) => {
    if (dec === undefined || dec === null || Number.isNaN(dec)) return null;
    const h = Math.floor(dec), m = Math.round((dec - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };

  const METRICS = ['revenue', 'nyugtaszam', 'kosarertek'];
  const weekdays = [];
  const heatmap = { revenue: [], nyugtaszam: [], kosarertek: [] }; // [metric][wd][hh] = ATLAG (nem osszeg!)
  for (let wd = 0; wd < 7; wd++) {
    const dates = datesByWd.get(wd);
    const hourly = { revenue: { avg: [], median: [] }, nyugtaszam: { avg: [], median: [] }, kosarertek: { avg: [], median: [] } };
    let totalAvgRevenue = 0, peakAvgRevenue = 0;
    for (let h = 0; h < 24; h++) {
      const revValues = [], cntValues = [], basketValues = [];
      dates.forEach((d) => {
        const cell = dateHourMap.get(`${d}-${h}`);
        const rev = cell ? cell.revenue : 0;
        const cnt = cell ? cell.nyugtaszam : 0;
        revValues.push(rev);
        cntValues.push(cnt);
        basketValues.push(cnt > 0 ? rev / cnt : 0);
      });
      const revAvg = Math.round(avgOf(revValues));
      hourly.revenue.avg.push(revAvg);
      hourly.revenue.median.push(median(revValues));
      hourly.nyugtaszam.avg.push(Math.round(avgOf(cntValues) * 10) / 10);
      hourly.nyugtaszam.median.push(median(cntValues));
      hourly.kosarertek.avg.push(Math.round(avgOf(basketValues)));
      hourly.kosarertek.median.push(median(basketValues));
      totalAvgRevenue += revAvg;
      if (revAvg > peakAvgRevenue) peakAvgRevenue = revAvg;
    }
    METRICS.forEach((m) => heatmap[m].push(hourly[m].avg));

    const open = openByWd.get(wd);
    let deadZoneStartHours = 0, deadZoneEndHours = 0, recommendation = null;
    if (open && peakAvgRevenue > 0) {
      const threshold = peakAvgRevenue * 0.08; // önkényes, de bevált küszöb: a csúcsóra 8%-a alatt "elhanyagolható" forgalom
      const openH = Math.round(open.nyitasOra);
      const closeH = Math.round(open.zarasOra);
      const revAvgArr = hourly.revenue.avg;
      for (let h = openH; h < closeH; h++) {
        if (revAvgArr[h] <= threshold) deadZoneStartHours++; else break;
      }
      for (let h = closeH - 1; h >= openH; h--) {
        if (revAvgArr[h] <= threshold) deadZoneEndHours++; else break;
      }
      const lastHourShare = revAvgArr[closeH - 1] && totalAvgRevenue ? Math.round((revAvgArr[closeH - 1] / totalAvgRevenue) * 100) : 0;

      const parts = [];
      if (deadZoneEndHours >= 1) {
        parts.push(`A zárás előtti ${deadZoneEndHours} óra átlagosan érdemi forgalom nélkül telik (a nyitvatartás vége: ${fmtHH(open.zarasOra)}) — érdemes lehet fontolóra venni a korábbi zárást.`);
      }
      if (deadZoneStartHours >= 1) {
        parts.push(`A nyitás utáni ${deadZoneStartHours} óra is jellemzően forgalom nélkül telik (nyitás: ${fmtHH(open.nyitasOra)}) — később nyitva is elegendő lehet.`);
      }
      if (deadZoneEndHours === 0 && lastHourShare >= 10) {
        parts.push(`A zárás előtti utolsó órában is jelentős (az átlagos napi forgalom ${lastHourShare}%-a) az eladás — érdemes megfontolni a nyitvatartás meghosszabbítását.`);
      }
      if (!parts.length) {
        parts.push(`A nyitvatartás jól illeszkedik a tényleges forgalmi mintázathoz, nincs számottevő holt időszak.`);
      }
      recommendation = parts.join(' ');
    }

    weekdays.push({
      wd, label: labels[wd],
      avgNyitas: open ? fmtHH(open.nyitasOra) : null,
      avgZaras: open ? fmtHH(open.zarasOra) : null,
      napok: open ? open.napok : 0,
      hourly, totalAvgRevenue, peakAvgRevenue,
      deadZoneStartHours, deadZoneEndHours, recommendation,
    });
  }

  // Globális, összegző megállapítás — melyik nap(ok) mutatják a legnagyobb
  // eltérést, hogy azonnal odairányítsuk a figyelmet.
  const withIssues = weekdays.filter((w) => w.recommendation && (w.deadZoneStartHours > 0 || w.deadZoneEndHours > 0));
  let globalRecommendation;
  if (!withIssues.length) {
    globalRecommendation = 'A vizsgált időszakban a nyitvatartás minden napon jól illeszkedik a tényleges forgalmi mintázathoz.';
  } else {
    const worst = [...withIssues].sort((a, b) => (b.deadZoneStartHours + b.deadZoneEndHours) - (a.deadZoneStartHours + a.deadZoneEndHours))[0];
    globalRecommendation = `A legnagyobb, nyitvatartással kapcsolatos eltérés ${worst.label.toLowerCase()}on/-en látszik — lásd lent a részleteket. ${withIssues.length} napon van érdemi eltérés a nyitvatartás és a tényleges forgalom között.`;
  }

  sendJson(res, 200, { from, to, weekdays, heatmap, globalRecommendation });
});

// ---------------------------------------------------------------------------
// CIKKENKÉNTI ELEMZÉS — ugyanaz a módszertan, mint a nyitvatartás-
// optimalizálásnál: a kiválasztott cikk óránkénti/hét napja szerinti
// eladási INTENZITÁSÁT mutatja (mennyiség és bevétel), hőtérképpel és
// automatikus szöveges megállapítással.
// ---------------------------------------------------------------------------

// Legjobban fogyó cikkek listája a kiválasztott időszakban — ez a
// belépési pont, innen választható ki egy konkrét cikk a részletes
// elemzéshez.
// ---------------------------------------------------------------------------
// ÁTFOGÓ RIPORT — egy oldalon összefoglalja a legfontosabb mutatókat
// (forgalom, nyugtaszám, kosárérték, hét napja szerinti minta, legjobban
// fogyó cikkek), automatikus szöveges összefoglalóval — ez a belépési
// pont, ami a másik két elemzésre (nyitvatartás, cikkenkénti) irányítja
// a figyelmet, ha ott mélyebbre érdemes ásni.
route('GET', '/api/analysis/report', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const k = session.companyKey;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : todayIsoServer();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : addDaysISO(to, -29);

  const cur = periodRevenue(k, from, to);
  const avgBasket = cur.cnt ? Math.round(cur.revenue / cur.cnt) : 0;
  const weekday = weekdayBreakdown(k, from, to);
  const topProducts = all(k,
    `SELECT nt.megnevezes AS nev, IFNULL(SUM(nt.menny),0) AS mennyiseg, IFNULL(SUM(nt.sorbrutto),0) AS bevetel
     FROM nytet nt JOIN nyfej nf ON nf.bsz = nt.bsz
     WHERE nf.keltdat BETWEEN ? AND ? AND ${notStorno('nf')}
     GROUP BY nt.megnevezes ORDER BY mennyiseg DESC LIMIT 5`,
    [from, to]
  );

  // A hét legerősebb és leggyengébb (de aktív) napja — ez adja az
  // automatikus szöveges összefoglaló gerincét.
  const activeWeekday = weekday.filter((w) => w.avgRevenue > 0);
  const best = [...activeWeekday].sort((a, b) => b.avgRevenue - a.avgRevenue)[0];
  const worst = [...activeWeekday].sort((a, b) => a.avgRevenue - b.avgRevenue)[0];

  const parts = [];
  parts.push(`A vizsgált időszakban (${from} – ${to}) az összforgalom ${Math.round(cur.revenue).toLocaleString('hu-HU')} Ft volt, ${cur.cnt} nyugtán, átlagosan ${avgBasket.toLocaleString('hu-HU')} Ft-os kosárértékkel.`);
  if (best && worst && best.label !== worst.label) {
    parts.push(`A legerősebb nap ${best.label.toLowerCase()} (átlag ${Math.round(best.avgRevenue).toLocaleString('hu-HU')} Ft/nap), a leggyengébb — de még aktív — nap ${worst.label.toLowerCase()} (átlag ${Math.round(worst.avgRevenue).toLocaleString('hu-HU')} Ft/nap).`);
  }
  if (topProducts.length) {
    parts.push(`A legjobban fogyó cikk a(z) "${topProducts[0].nev}" volt (${topProducts[0].mennyiseg} db).`);
  }
  parts.push('A "Nyitvatartás optimalizálása" és a "Cikkenkénti elemzés" nézetekben ezekre a mintázatokra órás bontásban, mélyebben is rá lehet nézni.');

  sendJson(res, 200, {
    from, to,
    revenue: cur.revenue, receiptCount: cur.cnt, avgBasket,
    weekday, topProducts,
    osszefoglalo: parts.join(' '),
  });
});

route('GET', '/api/analysis/products/top', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const k = session.companyKey;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : todayIsoServer();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : addDaysISO(to, -89);
  const limit = Math.min(parseInt(query.limit || '20', 10) || 20, 100);
  const rows = all(k,
    `SELECT nt.megnevezes AS nev, IFNULL(SUM(nt.menny),0) AS mennyiseg, IFNULL(SUM(nt.sorbrutto),0) AS bevetel
     FROM nytet nt JOIN nyfej nf ON nf.bsz = nt.bsz
     WHERE nf.keltdat BETWEEN ? AND ? AND ${notStorno('nf')}
     GROUP BY nt.megnevezes ORDER BY mennyiseg DESC LIMIT ?`,
    [from, to, limit]
  );
  sendJson(res, 200, { from, to, products: rows });
});

// Egy KONKRÉT cikk óránkénti/hét napja szerinti eladási intenzitása —
// pontosan a nyitvatartás-elemzéssel megegyező szerkezetben (heatmap,
// napi részletek, átlag+medián, automatikus megállapítás), csak
// mennyiségre és bevételre, nem nyitvatartásra vetítve.
route('GET', '/api/analysis/products/detail', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const k = session.companyKey;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : todayIsoServer();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : addDaysISO(to, -89);
  const cikk = String(query.cikk || '').trim();
  if (!cikk) return sendJson(res, 400, { error: 'Hiányzó cikk.' });

  const labels = ['Vasárnap', 'Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek', 'Szombat'];
  const labelsRagozott = ['Vasárnap', 'Hétfőn', 'Kedden', 'Szerdán', 'Csütörtökön', 'Pénteken', 'Szombaton'];

  // Minden nap, ami a vizsgált időszakban ténylegesen "élt" (volt rajta
  // legalább 1 nyugta, függetlenül attól, hogy ez a cikk fogyott-e azon
  // a napon) — ez adja a helyes nevezőt az átlagszámításhoz, hogy egy
  // olyan nap, amikor a cikk NEM fogyott, ne maradjon ki a nevezőből.
  const activeDates = all(k,
    `SELECT DISTINCT keltdat AS d, CAST(strftime('%w', keltdat) AS INTEGER) AS wd
     FROM nyfej WHERE keltdat BETWEEN ? AND ? AND ${NOT_STORNO}`,
    [from, to]
  );
  const datesByWd = new Map();
  for (let wd = 0; wd < 7; wd++) datesByWd.set(wd, []);
  activeDates.forEach((r) => datesByWd.get(r.wd).push(r.d));

  const perDateHourly = all(k,
    `SELECT nf.keltdat AS keltdat, CAST(strftime('%H', nf.rendkezdatum) AS INTEGER) AS hh,
            IFNULL(SUM(nt.menny),0) AS mennyiseg, IFNULL(SUM(nt.sorbrutto),0) AS bevetel
     FROM nytet nt JOIN nyfej nf ON nf.bsz = nt.bsz
     WHERE nf.keltdat BETWEEN ? AND ? AND nf.rendkezdatum IS NOT NULL AND ${notStorno('nf')} AND nt.megnevezes = ?
     GROUP BY nf.keltdat, hh`,
    [from, to, cikk]
  );
  const dateHourMap = new Map();
  perDateHourly.forEach((r) => dateHourMap.set(`${r.keltdat}-${r.hh}`, { mennyiseg: r.mennyiseg, bevetel: r.bevetel }));

  function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2 * 10) / 10;
  }
  function avgOf(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }

  const METRICS = ['mennyiseg', 'bevetel'];
  const weekdays = [];
  const heatmap = { mennyiseg: [], bevetel: [] };
  let grandTotalMenny = 0;
  for (let wd = 0; wd < 7; wd++) {
    const dates = datesByWd.get(wd);
    const hourly = { mennyiseg: { avg: [], median: [] }, bevetel: { avg: [], median: [] } };
    let peakMenny = 0, totalMenny = 0;
    for (let h = 0; h < 24; h++) {
      const mennyValues = [], bevValues = [];
      dates.forEach((d) => {
        const cell = dateHourMap.get(`${d}-${h}`);
        mennyValues.push(cell ? cell.mennyiseg : 0);
        bevValues.push(cell ? cell.bevetel : 0);
      });
      const mennyAvg = Math.round(avgOf(mennyValues) * 10) / 10;
      hourly.mennyiseg.avg.push(mennyAvg);
      hourly.mennyiseg.median.push(median(mennyValues));
      hourly.bevetel.avg.push(Math.round(avgOf(bevValues)));
      hourly.bevetel.median.push(median(bevValues));
      totalMenny += mennyAvg;
      if (mennyAvg > peakMenny) peakMenny = mennyAvg;
    }
    METRICS.forEach((m) => heatmap[m].push(hourly[m].avg));
    grandTotalMenny += totalMenny;

    let recommendation = null;
    if (dates.length && peakMenny > 0) {
      const peakHour = hourly.mennyiseg.avg.indexOf(peakMenny);
      recommendation = `${labelsRagozott[wd]} átlagosan ${Math.round(totalMenny * 10) / 10} db kel el naponta, a csúcs ${peakHour}:00–${peakHour + 1}:00 között van (átlagosan ${peakMenny} db/óra).`;
    } else if (dates.length) {
      recommendation = `${labelsRagozott[wd]} a vizsgált időszakban nem fogyott ez a cikk.`;
    }

    weekdays.push({ wd, label: labels[wd], napok: dates.length, hourly, totalAvgMenny: totalMenny, peakAvgMenny: peakMenny, recommendation });
  }

  const best = [...weekdays].filter((w) => w.napok > 0).sort((a, b) => b.totalAvgMenny - a.totalAvgMenny)[0];
  const globalRecommendation = best && best.totalAvgMenny > 0
    ? `A(z) "${cikk}" legerősebb napja: ${best.label} (átlagosan ${Math.round(best.totalAvgMenny * 10) / 10} db/nap). A vizsgált időszak teljes mennyisége: ${Math.round(grandTotalMenny * 10) / 10} db/nap-egyenérték átlagban a hét napjaira vetítve.`
    : `A(z) "${cikk}" nem fogyott a vizsgált időszakban.`;

  sendJson(res, 200, { from, to, cikk, weekdays, heatmap, globalRecommendation });
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
  const sortCols = { nev: 'nt.megnevezes', mennyiseg: 'mennyiseg', nyugtaszam: 'nyugtaszam', arbevetel: 'arbevetel' };
  const sortCol = sortCols[query.sort] || 'arbevetel';
  const sortDir = query.order === 'asc' ? 'ASC' : 'DESC';
  const params = [from, to];
  let where = `nf.keltdat BETWEEN ? AND ? AND ${notStorno('nf')}`;
  if (q) { where += ' AND nt.megnevezes LIKE ?'; params.push(`%${q}%`); }
  const rows = all(k,
    `SELECT nt.megnevezes AS nev, SUM(nt.menny) AS mennyiseg, nt.me AS me,
            IFNULL(SUM(nt.sorbrutto),0) AS arbevetel, COUNT(DISTINCT nt.bsz) AS nyugtaszam
     FROM nytet nt JOIN nyfej nf ON nf.bsz = nt.bsz
     WHERE ${where}
     GROUP BY nt.megnevezes, nt.me
     ORDER BY ${sortCol} ${sortDir}
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
  const sortCols = { bsz: 'bsz', keltdat: 'keltdat', fizmod: 'fizmod', osszeg: 'osszeg' };
  const sortCol = sortCols[query.sort] || 'id';
  const sortDir = query.order === 'asc' ? 'ASC' : 'DESC';

  let where = `keltdat BETWEEN ? AND ? AND ${NOT_STORNO}`;
  const params = [from, to];
  if (q) { where += ' AND bsz LIKE ?'; params.push(`%${q}%`); }
  if (fizmod) { where += ' AND fizmod = ?'; params.push(fizmod); }
  if (min !== null) { where += ' AND (bruttokp+bruttoafr+bruttokartya) >= ?'; params.push(min); }
  if (max !== null) { where += ' AND (bruttokp+bruttoafr+bruttokartya) <= ?'; params.push(max); }

  const rows = all(k,
    `SELECT bsz, keltdat, fizmod, (bruttokp+bruttoafr+bruttokartya) AS osszeg
     FROM nyfej WHERE ${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`,
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
  const ntakAktiv = isCompanyNtakActive(session.cegKulcs);
  // A "fokatjson"/"alkatjson"/"ntakszorzo"/"ntakme"/"azon"/"gongyolegazon"
  // oszlopok NEM léteznek minden cég cikkt-sémájában (régebbi androidos
  // alkalmazás-verzióknál hiányozhatnak) — ha rájuk hivatkoznánk, amikor
  // nincsenek ott, a teljes Cikktörzs-nézet egy szerverhibával elszállna.
  // Ezért előbb ellenőrizzük.
  const cikktColumns = all(session.companyKey, `PRAGMA table_info(cikkt)`);
  const hasNtakCols = ['fokatjson', 'alkatjson', 'ntakszorzo', 'ntakme'].every((col) => cikktColumns.some((c) => c.name === col));
  const hasGongyoleg = cikktColumns.some((c) => c.name === 'gongyolegazon') && cikktColumns.some((c) => c.name === 'azon');
  const ntakSelect = hasNtakCols
    ? `c.fokatjson AS fokat, c.alkatjson AS alkat, c.ntakszorzo AS ntakSzorzo, c.ntakme AS ntakMe,`
    : `NULL AS fokat, NULL AS alkat, NULL AS ntakSzorzo, NULL AS ntakMe,`;
  const gongyolegSelect = hasGongyoleg
    ? `c.azon, c.gongyolegazon,
       (SELECT c2.megnevezes FROM cikkt c2 WHERE c2.azon = c.gongyolegazon AND c.gongyolegazon IS NOT NULL AND c.gongyolegazon != '') AS gongyolegNev,`
    : `NULL AS azon, NULL AS gongyolegazon, NULL AS gongyolegNev,`;
  const rows = all(session.companyKey,
    `SELECT c.megnevezes AS nev, c.me, c.bruttoar, c.afakod, c.vonalkod, c.status, c.afakodelv AS afakodElviteli,
            ${ntakSelect}
            ${gongyolegSelect}
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
      pendingMap.set(pl.megnevezes, { ...pl, csoportNev: pl.csoport?.megnevezes || meta.csoportNev || null });
    } catch (_) {}
  }
  const items = rows.map((r) => ({ ...r, pendingChange: pendingMap.get(r.nev) || null }));
  // olyan cikk is legyen látható, ami még csak függőben van (androidon még nem létezik)
  const existingNames = new Set(rows.map((r) => r.nev));
  for (const [nev, pl] of pendingMap) {
    if (!existingNames.has(nev)) items.push({ nev, me: pl.me, bruttoar: pl.bruttoar, afakod: pl.afakod, vonalkod: pl.vonalkod, status: 'A', csoportNev: pl.csoportNev || 'Nincs csoport', afakodElviteli: pl.afakodelv, fokat: pl.fokatjson || null, alkat: pl.alkatjson || null, ntakSzorzo: pl.ntakszorzo ?? null, ntakMe: pl.ntakme || null, azon: null, gongyolegazon: pl.gongyolegazon || null, gongyolegNev: null, pendingChange: pl, isNewPending: true });
  }
  items.sort((a, b) => a.nev.localeCompare(b.nev, 'hu'));
  // A termékfotók egy MÁSIK adatbázisban (stockDb) vannak, mert a cikkt
  // saját sémájában nincs kép-mező — itt fésüljük össze név szerint.
  const imageRows = stockDb.prepare(`SELECT cikk_nev, fajlnev FROM termek_kepek WHERE company_key = ?`).all(session.companyKey);
  const imageMap = new Map(imageRows.map((r) => [r.cikk_nev, r.fajlnev]));
  for (const it of items) it.kepFajlnev = imageMap.get(it.nev) || null;
  // A göngyöleg-választóhoz (más termék hozzákapcsolása "tapadó
  // göngyölegként") csak a MÁR TÉNYLEGESEN LÉTEZŐ (nem függőben lévő)
  // cikkeket ajánljuk fel — egy még nem szinkronizált termékre nem lehet
  // hivatkozni, mert annak nincs még valódi "azon" azonosítója.
  const packagingOptions = rows.filter((r) => r.azon).map((r) => ({ azon: r.azon, nev: r.nev }));
  sendJson(res, 200, { items, ntakAktiv, packagingOptions });
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
// A fejlesztő megerősítette (2026.07.15), hogy a "csoport": { "megnevezes":
// ... } mezőt mostantól KÜLÖN, nem-generikus logikával dolgozzák fel az
// androidos oldalon (nem a cikkt tábla generikus, mezőnév=oszlopnév alapú
// illesztőjén keresztül) — ezért ismét belekerülhet a payloadba.
function buildCikkPayload({ megnevezes, me, bruttoar, afakod, vonalkod, afakodelv, csoportNev, fokat, alkat, ntakSzorzo, ntakMe, gongyolegAzon }) {
  const payload = { megnevezes, me, bruttoar, afakod, vonalkod: vonalkod || null, afakodelv: afakodelv || null };
  if (csoportNev) payload.csoport = { megnevezes: csoportNev };
  // FONTOS: a mezőnevek itt PONTOSAN a cikkt tábla valódi oszlopneveit
  // követik (fokatjson/alkatjson/ntakszorzo/ntakme/gongyolegazon) — az
  // androidos alkalmazás a payload minden kulcsát mezőnév=oszlopnév
  // alapon, generikusan illeszti a cikkt táblára, és bármilyen ismeretlen
  // mezőnév esetén elutasítja az EGÉSZ szinkront, ezért itt nem lehet
  // "szebb", eltérő elnevezést használni.
  if (fokat !== undefined) payload.fokatjson = fokat || null;
  if (alkat !== undefined) payload.alkatjson = alkat || null;
  if (ntakSzorzo !== undefined) payload.ntakszorzo = ntakSzorzo ?? null;
  if (ntakMe !== undefined) payload.ntakme = ntakMe || null;
  if (gongyolegAzon !== undefined) payload.gongyolegazon = gongyolegAzon || null;
  return payload;
}

route('POST', '/api/products/change', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const body = await readJsonBody(req);
  const megnevezes = clampStr(body.megnevezes, 120);
  if (!megnevezes) return sendJson(res, 400, { error: 'A cikk neve kötelező.' });
  // SZERVER-OLDALI kikényszerítés — a kliens is jelzi ezt, de az önmagában
  // megkerülhető lenne (pl. közvetlen API-hívással); a cikk nevét a
  // szinkron a NÉV alapján azonosítja, ezért egy szerkesztés közbeni
  // átírás adatvesztéshez/duplikációhoz vezetne az androidos oldalon.
  const originalMegnevezes = clampStr(body.originalMegnevezes, 120);
  if (originalMegnevezes && originalMegnevezes !== megnevezes) {
    return sendJson(res, 400, { error: 'A cikk neve szerkesztés közben nem módosítható — ez azonosítja a cikket a szinkronban. Törlés után vegyél fel új cikket, ha át szeretnéd nevezni.' });
  }
  const bruttoar = parseFloat(body.bruttoar);
  if (!Number.isFinite(bruttoar) || bruttoar < 0) return sendJson(res, 400, { error: 'Érvénytelen bruttó ár.' });
  const afakod = clampStr(body.afakod, 10);
  if (!afakod) return sendJson(res, 400, { error: 'Az ÁFA kód kötelező.' });
  if (!VALID_AFA_CODES.includes(afakod)) return sendJson(res, 400, { error: `Érvénytelen ÁFA kód. Megengedett értékek: ${VALID_AFA_CODES.join(', ')}.` });
  const me = clampStr(body.me, 20) || 'Darab';
  const csoportNev = clampStr(body.csoportNev, 80) || null;
  const vonalkod = clampStr(body.vonalkod, 40) || null;
  const afakodelv = clampStr(body.afakodElviteli, 10) || null;
  if (afakodelv && !VALID_AFA_CODES.includes(afakodelv)) return sendJson(res, 400, { error: `Érvénytelen elviteli ÁFA kód. Megengedett értékek: ${VALID_AFA_CODES.join(', ')}.` });

  // Az NTAK-kategória mezők (fő- és alkategória) csak akkor kötelezők,
  // ha a cég a Profil menüpontban bekapcsolta az NTAK-os üzemmódot —
  // enélkül a legtöbb cégnek felesleges, értelmezhetetlen mezők lennének.
  const ntakAktiv = isCompanyNtakActive(session.cegKulcs);
  const fokat = clampStr(body.fokat, 60) || null;
  const alkat = clampStr(body.alkat, 60) || null;
  if (ntakAktiv) {
    if (!fokat) return sendJson(res, 400, { error: 'Az NTAK-főkategória megadása kötelező (a cég NTAK-os üzemmódban van — ez a Profil menüpontban kapcsolható ki).' });
    if (!alkat) return sendJson(res, 400, { error: 'Az NTAK-alkategória megadása kötelező (a cég NTAK-os üzemmódban van — ez a Profil menüpontban kapcsolható ki).' });
  }
  const ntakSzorzoRaw = body.ntakSzorzo;
  let ntakSzorzo = null;
  if (ntakSzorzoRaw !== undefined && ntakSzorzoRaw !== null && ntakSzorzoRaw !== '') {
    ntakSzorzo = parseFloat(ntakSzorzoRaw);
    if (!Number.isFinite(ntakSzorzo) || ntakSzorzo <= 0) return sendJson(res, 400, { error: 'Az NTAK-szorzó, ha meg van adva, pozitív számnak kell lennie.' });
  }
  const ntakMe = clampStr(body.ntakMe, 20) || null;
  const gongyolegAzon = clampStr(body.gongyolegAzon, 40) || null;
  if (gongyolegAzon) {
    let csomagolo = null;
    try { csomagolo = get(session.companyKey, `SELECT azon FROM cikkt WHERE azon = ? AND status = 'A'`, [gongyolegAzon]); } catch (_) {}
    if (!csomagolo) return sendJson(res, 400, { error: 'A kiválasztott göngyöleg-termék nem található — válassz egy meglévő cikket.' });
  }
  addProductChange(session.companyKey, 'cikk_upsert', buildCikkPayload({ megnevezes, me, bruttoar, afakod, vonalkod, afakodelv, csoportNev, fokat, alkat, ntakSzorzo, ntakMe, gongyolegAzon }), 'web_form');
  logActivity({ type: 'product_change_add', ok: true, companyKey: session.companyKey, nev: session.nev, detail: `${megnevezes} → ${bruttoar} Ft` });
  sendJson(res, 200, { ok: true });
});

// Termékfotó feltöltése — CSAK weben tárolt, kiegészítő adat (lásd fenti
// megjegyzés a termek_kepek táblánál). Ugyanaz a szigorú, tartalom-alapú
// típusellenőrzés védi, mint a bevételezési számla-fotókat.
route('POST', '/api/products/image', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const body = await readJsonBody(req);
  const cikkNev = clampStr(body.megnevezes, 120);
  if (!cikkNev) return sendJson(res, 400, { error: 'Hiányzó cikknév.' });
  if (!body.fajlAdat) return sendJson(res, 400, { error: 'Hiányzó fájl.' });
  const MAX_BYTES = 5 * 1024 * 1024;
  const match = /^data:([^;]+);base64,(.+)$/.exec(body.fajlAdat);
  const b64 = match ? match[2] : body.fajlAdat;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_BYTES) return sendJson(res, 400, { error: 'A kép túl nagy (max. 5 MB).' });
  const detectedExt = detectSafeFileType(buf);
  if (!detectedExt || detectedExt === '.pdf') return sendJson(res, 400, { error: 'Csak kép (JPG, PNG, WEBP, HEIC) tölthető fel.' });

  const safeDir = path.join(UPLOADS_DIR, session.companyKey.replace(/[^a-zA-Z0-9_-]/g, '_'), 'termekkepek');
  if (!fs.existsSync(safeDir)) fs.mkdirSync(safeDir, { recursive: true });
  const oldRow = stockDb.prepare(`SELECT fajlnev FROM termek_kepek WHERE company_key = ? AND cikk_nev = ?`).get(session.companyKey, cikkNev);
  if (oldRow) { try { fs.unlinkSync(path.join(safeDir, oldRow.fajlnev)); } catch (_) {} }
  const fajlnev = `${crypto.randomBytes(12).toString('hex')}${detectedExt}`;
  fs.writeFileSync(path.join(safeDir, fajlnev), buf);
  stockDb.prepare(`
    INSERT INTO termek_kepek (company_key, cikk_nev, fajlnev, feltoltve) VALUES (?, ?, ?, ?)
    ON CONFLICT(company_key, cikk_nev) DO UPDATE SET fajlnev = excluded.fajlnev, feltoltve = excluded.feltoltve
  `).run(session.companyKey, cikkNev, fajlnev, new Date().toISOString());
  sendJson(res, 200, { ok: true, fajlnev });
});

route('GET', '/api/products/image', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const fajlnev = String(query.fajlnev || '').replace(/[^a-zA-Z0-9.]/g, '');
  if (!fajlnev) return sendJson(res, 400, { error: 'Hiányzó fájlnév.' });
  const row = stockDb.prepare(`SELECT fajlnev FROM termek_kepek WHERE company_key = ? AND fajlnev = ?`).get(session.companyKey, fajlnev);
  if (!row) return sendJson(res, 404, { error: 'Nincs ilyen kép.' });
  const filePath = path.join(UPLOADS_DIR, session.companyKey.replace(/[^a-zA-Z0-9_-]/g, '_'), 'termekkepek', row.fajlnev);
  if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'A fájl nem található.' });
  const ext = path.extname(filePath).toLowerCase();
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic' }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'private, max-age=3600' });
  res.end(fs.readFileSync(filePath));
});

route('POST', '/api/products/image/delete', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const body = await readJsonBody(req);
  const cikkNev = clampStr(body.megnevezes, 120);
  if (!cikkNev) return sendJson(res, 400, { error: 'Hiányzó cikknév.' });
  const row = stockDb.prepare(`SELECT fajlnev FROM termek_kepek WHERE company_key = ? AND cikk_nev = ?`).get(session.companyKey, cikkNev);
  if (row) {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, session.companyKey.replace(/[^a-zA-Z0-9_-]/g, '_'), 'termekkepek', row.fajlnev)); } catch (_) {}
    stockDb.prepare(`DELETE FROM termek_kepek WHERE company_key = ? AND cikk_nev = ?`).run(session.companyKey, cikkNev);
  }
  sendJson(res, 200, { ok: true });
});

// Új termékcsoport létrehozása — szintén függő módosításként.
route('POST', '/api/products/group', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const body = await readJsonBody(req);
  const megnevezes = clampStr(body.megnevezes, 80);
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

  const cikktColumnsBulk = all(session.companyKey, `PRAGMA table_info(cikkt)`);
  const hasNtakColsBulk = ['fokatjson', 'alkatjson', 'ntakszorzo', 'ntakme'].every((col) => cikktColumnsBulk.some((c) => c.name === col));
  const ntakSelectBulk = hasNtakColsBulk
    ? `c.fokatjson AS fokat, c.alkatjson AS alkat, c.ntakszorzo AS ntakSzorzo, c.ntakme AS ntakMe,`
    : `NULL AS fokat, NULL AS alkat, NULL AS ntakSzorzo, NULL AS ntakMe,`;
  let products = all(session.companyKey,
    `SELECT c.megnevezes AS nev, c.me, c.bruttoar, c.afakod, c.vonalkod, c.afakodelv,
            ${ntakSelectBulk}
            IFNULL(g.megnevezes,'Nincs csoport') AS csoportNev
     FROM cikkt c LEFT JOIN cikkcsop g ON g.azon = c.csopazon WHERE c.status = 'A'`
  );
  if (csoportNev) products = products.filter((p) => p.csoportNev === csoportNev);
  if (names) products = products.filter((p) => names.includes(p.nev));
  if (!products.length) return sendJson(res, 400, { error: 'Nincs a feltételnek megfelelő cikk.' });

  for (const p of products) {
    let newPrice = mode === 'percent' ? p.bruttoar * (1 + value / 100) : p.bruttoar + value;
    newPrice = Math.max(0, Math.round(newPrice));
    addProductChange(session.companyKey, 'cikk_upsert',
      buildCikkPayload({
        megnevezes: p.nev, me: p.me, bruttoar: newPrice, afakod: p.afakod, vonalkod: p.vonalkod, afakodelv: p.afakodelv, csoportNev: p.csoportNev,
        fokat: p.fokat, alkat: p.alkat, ntakSzorzo: p.ntakSzorzo, ntakMe: p.ntakMe,
      }),
      'web_bulk_price');
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
      csoportNev: csoportNevImport,
    }), 'excel_import');
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
    `SELECT id, datum, cikk_nev AS cikkNev, me, mennyiseg, beszerzesi_ar AS beszerzesiAr, szallito, megjegyzes, szamla_fajl AS szamlaFajl, created_at AS createdAt
     FROM bevetelezesek WHERE company_key = ? ORDER BY id DESC LIMIT ?`
  ).all(session.companyKey, limit);
  sendJson(res, 200, { items: rows });
});

route('POST', '/api/stock/receipt', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const body = await readJsonBody(req);
  const cikkNev = clampStr(body.cikkNev, 120);
  const mennyiseg = parseFloat(body.mennyiseg);
  if (!cikkNev) return sendJson(res, 400, { error: 'A cikk neve kötelező.' });
  if (!Number.isFinite(mennyiseg) || mennyiseg <= 0) return sendJson(res, 400, { error: 'A mennyiségnek pozitív számnak kell lennie.' });
  const datum = /^\d{4}-\d{2}-\d{2}$/.test(body.datum || '') ? body.datum : todayIsoServer();
  const me = clampStr(body.me, 20) || null;
  const beszerzesiAr = body.beszerzesiAr !== undefined && body.beszerzesiAr !== '' ? parseFloat(body.beszerzesiAr) : null;
  const szallito = clampStr(body.szallito, 120) || null;
  const megjegyzes = clampStr(body.megjegyzes, 500) || null;

  // Számla-fotó/fájl csatolása — opcionális, base64-ben érkezik (data URL
  // vagy nyers base64), a szerver menti fájlba, csak a fájlnevet tároljuk el.
  // SZIGORÚ TÍPUS-ELLENŐRZÉS: csak a ténylegesen szükséges formátumok
  // (kép + PDF) engedélyezettek, és nem a kiterjesztésnek/a kliens által
  // állított MIME-nek hiszünk, hanem a fájl TARTALMÁT (mágikus bájtokat)
  // is ellenőrizzük — enélkül bárki tetszőleges (pl. futtatható) fájlt
  // tölthetne fel, csak átnevezve azt "kep.jpg"-re.
  let szamlaFajl = null;
  if (body.fajlAdat && body.fajlNev) {
    const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — bőven elég egy telefonos fotóhoz/PDF-hez
    const match = /^data:([^;]+);base64,(.+)$/.exec(body.fajlAdat);
    const b64 = match ? match[2] : body.fajlAdat;
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > MAX_BYTES) return sendJson(res, 400, { error: 'A csatolt fájl túl nagy (max. 8 MB).' });

    const detectedExt = detectSafeFileType(buf);
    if (!detectedExt) {
      return sendJson(res, 400, { error: 'Csak kép (JPG, PNG, WEBP, HEIC) vagy PDF fájl csatolható.' });
    }
    const safeDir = path.join(UPLOADS_DIR, session.companyKey.replace(/[^a-zA-Z0-9_-]/g, '_'));
    if (!fs.existsSync(safeDir)) fs.mkdirSync(safeDir, { recursive: true });
    szamlaFajl = `${crypto.randomBytes(12).toString('hex')}${detectedExt}`;
    fs.writeFileSync(path.join(safeDir, szamlaFajl), buf);
  }

  const result = stockDb.prepare(
    `INSERT INTO bevetelezesek (company_key, datum, cikk_nev, me, mennyiseg, beszerzesi_ar, szallito, megjegyzes, szamla_fajl, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(session.companyKey, datum, cikkNev, me, mennyiseg, beszerzesiAr, szallito, megjegyzes, szamlaFajl, new Date().toISOString());

  logActivity({ type: 'stock_receipt_add', ok: true, companyKey: session.companyKey, nev: session.nev, detail: `${cikkNev}: ${mennyiseg} ${me || ''}`.trim() });
  sendJson(res, 200, { ok: true, id: Number(result.lastInsertRowid) });
});

// A bevételezéshez csatolt számla-fájl (fotó/PDF) letöltése/megtekintése —
// csak a saját cég munkamenete érheti el. SZÁNDÉKOSAN a véletlenszerű
// fájlnevet (nem a sorszámozott adatbázis-id-t) használjuk keresési
// kulcsként — egy egyszerű, növekvő szám tippelhető/végigpróbálható lenne,
// a véletlenszerű fájlnév gyakorlatilag nem.
route('GET', '/api/stock/receipt-file', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const file = String(query.file || '').replace(/[^a-zA-Z0-9.]/g, '');
  if (!file) return sendJson(res, 400, { error: 'Hiányzó fájl-azonosító.' });
  const row = stockDb.prepare(`SELECT szamla_fajl FROM bevetelezesek WHERE szamla_fajl = ? AND company_key = ?`).get(file, session.companyKey);
  if (!row || !row.szamla_fajl) return sendJson(res, 404, { error: 'Nincs csatolt fájl.' });
  const safeDir = path.join(UPLOADS_DIR, session.companyKey.replace(/[^a-zA-Z0-9_-]/g, '_'));
  const filePath = path.join(safeDir, row.szamla_fajl);
  if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'A fájl nem található.' });
  const ext = path.extname(filePath).toLowerCase();
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf', '.heic': 'image/heic' }[ext] || 'application/octet-stream';
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'private, max-age=3600' });
  res.end(data);
});

route('DELETE', '/api/stock/receipt', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const id = parseInt(query.id, 10);
  if (!id) return sendJson(res, 400, { error: 'Hiányzó id.' });
  const existing = stockDb.prepare(`SELECT cikk_nev, mennyiseg, szamla_fajl FROM bevetelezesek WHERE id = ? AND company_key = ?`).get(id, session.companyKey);
  const result = stockDb.prepare(`DELETE FROM bevetelezesek WHERE id = ? AND company_key = ?`).run(id, session.companyKey);
  if (result.changes === 0) return sendJson(res, 404, { error: 'Nem található (vagy nem a te cégedhez tartozik).' });
  if (existing && existing.szamla_fajl) {
    try {
      const safeDir = path.join(UPLOADS_DIR, session.companyKey.replace(/[^a-zA-Z0-9_-]/g, '_'));
      fs.unlinkSync(path.join(safeDir, existing.szamla_fajl));
    } catch (_) { /* ha a fájl már nincs a lemezen, nem gond */ }
  }
  logActivity({ type: 'stock_receipt_delete', ok: true, companyKey: session.companyKey, nev: session.nev, detail: existing ? `${existing.cikk_nev}: ${existing.mennyiseg}` : `#${id}` });
  sendJson(res, 200, { ok: true });
});

// Teljes készlet nullázása — minden cikkhez egy korrekciós bevételezési
// tételt szúr be, ami pontosan nullára hozza az egyenleget. A meglévő
// bevételezési/eladási előzmény TELJES EGÉSZÉBEN megmarad, ez csak egy
// újabb, jól látható, "Készlet nullázása" jelölésű tételt ad hozzá —
// nem törli a korábbi adatokat.
route('POST', '/api/stock/reset', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const k = session.companyKey;

  const products = all(k, `SELECT megnevezes AS nev, me FROM cikkt WHERE status = 'A'`);
  const received = stockDb.prepare(
    `SELECT cikk_nev AS nev, SUM(mennyiseg) AS mennyiseg FROM bevetelezesek WHERE company_key = ? GROUP BY cikk_nev`
  ).all(k);
  const receivedMap = new Map(received.map((r) => [r.nev, r.mennyiseg]));
  const sold = all(k,
    `SELECT nt.megnevezes AS nev, IFNULL(SUM(nt.menny),0) AS mennyiseg
     FROM nytet nt JOIN nyfej nf ON nf.bsz = nt.bsz
     WHERE ${notStorno('nf')}
     GROUP BY nt.megnevezes`
  );
  const soldMap = new Map(sold.map((r) => [r.nev, r.mennyiseg]));

  const byName = new Map(products.map((p) => [p.nev, p]));
  for (const r of received) if (!byName.has(r.nev)) byName.set(r.nev, { nev: r.nev, me: null });
  for (const s of sold) if (!byName.has(s.nev)) byName.set(s.nev, { nev: s.nev, me: null });

  const datum = todayIsoServer();
  const now = new Date().toISOString();
  let count = 0;
  for (const p of byName.values()) {
    const bevetelezve = receivedMap.get(p.nev) || 0;
    const eladva = soldMap.get(p.nev) || 0;
    const keszlet = bevetelezve - eladva;
    if (keszlet === 0) continue; // már nulla, nincs teendő
    stockDb.prepare(
      `INSERT INTO bevetelezesek (company_key, datum, cikk_nev, me, mennyiseg, beszerzesi_ar, szallito, megjegyzes, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
    ).run(k, datum, p.nev, p.me, -keszlet, 'Készlet nullázása (automatikus korrekció)', now);
    count++;
  }
  logActivity({ type: 'stock_reset', ok: true, companyKey: k, nev: session.nev, detail: `${count} cikk készlete nullázva` });
  sendJson(res, 200, { ok: true, count });
});


route('POST', '/api/stock/threshold', async (req, res) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const body = await readJsonBody(req);
  const scope = body.scope === 'csoport' ? 'csoport' : 'cikk';
  const nev = clampStr(body.nev, 100);
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

  // Diagnosztika — MINDIG kiszámoljuk, függetlenül a kiválasztott
  // időszaktól, hogy üres eredmény esetén a felület meg tudja mutatni,
  // MIÉRT nincs adat (nincs egyáltalán szinkronizált NTAK-adat, vagy
  // csak épp ezen az időszakon kívül van) — minden lekérdezés külön
  // try/catch-ben, hogy egy hiányzó/eltérő szerkezetű tábla se
  // akassza meg a többit.
  const diag = { nyfej: null, nyfejEllenorzottInRange: null, ntakrms: null, ntaknapzaras: null, error: null };
  try {
    diag.nyfej = get(k, `SELECT COUNT(*) AS total, MIN(keltdat) AS minDate, MAX(keltdat) AS maxDate,
      SUM(CASE WHEN ntakzarasid IS NOT NULL THEN 1 ELSE 0 END) AS vanZarasid,
      SUM(CASE WHEN ellenorzott IS NOT NULL THEN 1 ELSE 0 END) AS vanEllenorzott
      FROM nyfej`);
    // Ugyanez, de kifejezetten a "hol van ellenőrzött adat" kérdésre —
    // enélkül a fenti, TELJES idősávra vonatkozó összesítő félrevezető
    // lehet: lehet, hogy VAN 56000+ ellenőrzött sor összesen, de egyik
    // sem esik a ténylegesen kiválasztott időszakba, és emiatt tűnik úgy,
    // mintha "nem lenne adat", holott csak a dátumszűrő túl szűk.
    diag.nyfejEllenorzottInRange = get(k,
      `SELECT MIN(keltdat) AS minDate, MAX(keltdat) AS maxDate, COUNT(*) AS total
       FROM nyfej WHERE ellenorzott IS NOT NULL`);
  } catch (e) { diag.error = `nyfej: ${e.message}`; }
  try {
    diag.ntakrms = get(k, `SELECT COUNT(*) AS total, MIN(date(kulddate)) AS minDate, MAX(date(kulddate)) AS maxDate FROM ntakrms`);
  } catch (e) { diag.error = (diag.error ? diag.error + ' | ' : '') + `ntakrms: ${e.message}`; }
  try {
    diag.ntaknapzaras = get(k, `SELECT COUNT(*) AS total, MIN(targynap) AS minDate, MAX(targynap) AS maxDate FROM ntaknapzaras`);
  } catch (e) { diag.error = (diag.error ? diag.error + ' | ' : '') + `ntaknapzaras: ${e.message}`; }

  let napzarasok = [];
  try {
    const napzarasokRaw = all(k,
      `SELECT n.id, n.targynap, n.nyitas, n.zaras, n.borravalo, n.naptipus, n.uuid
       FROM ntaknapzaras n WHERE n.targynap BETWEEN ? AND ? ORDER BY n.targynap DESC`,
      [from, to]
    );
    // A napzárás tényleges NTAK-küldési állapotát az nyfej táblából, a hozzá
    // tartozó nyugták (nyfej.ntakzarasid = ntaknapzaras.id) állapotainak
    // összesítéséből számoljuk — ez a megbízható, elsődleges forrás.
    napzarasok = napzarasokRaw.map((n) => {
      let stats = [];
      try {
        stats = all(k,
          `SELECT IFNULL(ellenorzott,'NULL') AS ellenorzott, COUNT(*) AS cnt
           FROM nyfej WHERE ntakzarasid = ? GROUP BY ellenorzott`,
          [n.id]
        );
      } catch (e) { diag.error = (diag.error ? diag.error + ' | ' : '') + `napzárás-státusz (${n.targynap}): ${e.message}`; }
      let zarasStatusz = null;
      let zarasNyugtaSzam = 0;
      if (stats.length) {
        const byStatus = new Map(stats.map((s) => [s.ellenorzott, s.cnt]));
        zarasNyugtaSzam = stats.reduce((sum, s) => sum + s.cnt, 0);
        const sikeres = byStatus.get('TELJESEN_SIKERES') || 0;
        const hibas = byStatus.get('TELJESEN_HIBAS') || 0;
        const reszben = byStatus.get('RESZBEN_SIKERES') || byStatus.get('RÉSZBEN_SIKERES') || 0;
        const ismeretlenVagyNull = byStatus.get('NULL') || 0;
        if (hibas > 0 || reszben > 0) zarasStatusz = 'RESZBEN_SIKERES';
        else if (sikeres > 0 && sikeres === zarasNyugtaSzam) zarasStatusz = 'TELJESEN_SIKERES';
        else if (ismeretlenVagyNull === zarasNyugtaSzam) zarasStatusz = null; // még nincs elküldve
        else zarasStatusz = 'ISMERETLEN';
      }
      const { id, ...rest } = n;
      return { ...rest, zarasStatusz, zarasNyugtaSzam };
    });
  } catch (e) { diag.error = (diag.error ? diag.error + ' | ' : '') + `napzárás lekérdezés: ${e.message}`; }

  let submissionsByStatus = [], submissionsByType = [], recent = [];
  let usedNyfejFallback = false;
  try {
    submissionsByStatus = all(k,
      `SELECT IFNULL(ellenorzott,'ISMERETLEN') AS ellenorzott, COUNT(*) AS cnt
       FROM ntakrms WHERE date(kulddate) BETWEEN ? AND ? GROUP BY ellenorzott ORDER BY cnt DESC`,
      [from, to]
    );
    submissionsByType = all(k,
      `SELECT url, COUNT(*) AS cnt
       FROM ntakrms WHERE date(kulddate) BETWEEN ? AND ? GROUP BY url ORDER BY cnt DESC`,
      [from, to]
    );
    recent = all(k,
      `SELECT url, sikeres, uuid, kulddate, elldate, ellenorzott
       FROM ntakrms WHERE date(kulddate) BETWEEN ? AND ? ORDER BY kulddate DESC LIMIT 100`,
      [from, to]
    );
  } catch (e) {
    diag.error = (diag.error ? diag.error + ' | ' : '') + `ntakrms lekérdezés: ${e.message}`;
  }

  // Ha az ntakrms tábla nem létezik (régebbi androidos alkalmazás-verzió),
  // vagy egyszerűen nincs benne adat a kiválasztott időszakra, a NYUGTÁK
  // SAJÁT, beépített NTAK-küldési mezőiből (nyfej.kuldstat/ellenorzott)
  // számoljuk ki ugyanezt — ez ugyanolyan valódi, megbízható forrás,
  // csak nyugta-szinten, nem egy külön küldési naplóban van.
  if (!submissionsByStatus.length && !recent.length) {
    try {
      submissionsByStatus = all(k,
        `SELECT IFNULL(ellenorzott,'ISMERETLEN') AS ellenorzott, COUNT(*) AS cnt
         FROM nyfej WHERE keltdat BETWEEN ? AND ? AND ellenorzott IS NOT NULL GROUP BY ellenorzott ORDER BY cnt DESC`,
        [from, to]
      );
      const nyfejTotal = get(k, `SELECT COUNT(*) AS cnt FROM nyfej WHERE keltdat BETWEEN ? AND ? AND kuldstat IS NOT NULL`, [from, to]);
      submissionsByType = nyfejTotal.cnt ? [{ url: 'nyugta-kuldes', cnt: nyfejTotal.cnt }] : [];
      // A "rmsfelduuid" oszlop NEM létezik minden pénztárgép-szoftver
      // változat nyfej sémájában (pl. néhány LSZAMLA-variánsnál hiányzik)
      // — ha rá hivatkoznánk, a teljes lekérdezés hibával elszállna, és
      // ez csendben megakadályozná, hogy a fenti, MÁR SIKERESEN lekért
      // "submissionsByStatus" összesítő mellett a részletes lista is
      // megjelenjen. Ezért előbb ellenőrizzük, hogy egyáltalán létezik-e.
      const nyfejColumns = all(k, `PRAGMA table_info(nyfej)`);
      const hasRmsFelduuid = nyfejColumns.some((c) => c.name === 'rmsfelduuid');
      const uuidExpr = hasRmsFelduuid ? 'IFNULL(rmsfelduuid, uuid)' : 'uuid';
      recent = all(k,
        `SELECT 'nyugta-kuldes' AS url, bsz, keltdat AS kulddate, NULL AS elldate, ellenorzott, ${uuidExpr} AS uuid
         FROM nyfej WHERE keltdat BETWEEN ? AND ? AND kuldstat IS NOT NULL ORDER BY keltdat DESC, id DESC LIMIT 100`,
        [from, to]
      );
      usedNyfejFallback = submissionsByStatus.length > 0 || recent.length > 0;
    } catch (e) {
      diag.error = (diag.error ? diag.error + ' | ' : '') + `nyfej-alapú tartalék lekérdezés: ${e.message}`;
    }
  }

  sendJson(res, 200, { from, to, napzarasok, submissionsByStatus, submissionsByType, recent, usedNyfejFallback, diag });

});

route('GET', '/api/receipt', async (req, res, query) => {
  const session = requireAuth(req);
  if (!session) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const k = session.companyKey;
  const bsz = query.bsz;
  if (!bsz) return sendJson(res, 400, { error: 'bsz paraméter kötelező' });
  const header = get(k,
    `SELECT bsz, keltdat, umdate, fizmod, bruttokp, bruttoafr, bruttokartya, sznev, szadoszam, storno, stornozott
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
  const ip = getClientIp(req);
  const apiKey = req.headers['x-api-key'];
  if (!verifySyncApiKey(apiKey)) {
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

  // Eszköz-azonosítás — TELJESEN OPCIONÁLIS fejlécek. Ha egy régebbi app
  // nem küldi ezeket, egyszerűen nem történik semmi extra (lásd
  // recordDeviceSync megjegyzését). Ha egy telephelyen csak 1 eszköz
  // szinkronizál, ezt sosem kell megkövetelni — csak akkor számít, ha
  // ténylegesen több eszköz váltakozva ír ugyanoda.
  const eszkozUuid = req.headers['x-eszkoz-uuid'] || null;
  const progtip = req.headers['x-progtip'] || null;
  const verzio = req.headers['x-verzio'] || null;

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
  if (identity && eszkozUuid) recordDeviceSync(cegKulcs, eszkozUuid, telephelyKod, progtip, verzio);

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
  if (!verifySyncApiKey(apiKey)) return sendJson(res, 401, { error: 'Érvénytelen vagy hiányzó x-api-key.' });
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
// ---------------------------------------------------------------------------
// A korábbi, kizárólag teszteléshez létrehozott fix teszt-fiókokat innentől
// NEM hozzuk létre többé, és — mivel korábbi induláskor esetleg már
// létrejöttek egy élő adatbázisban — induláskor EGYSZERI, önműködő
// takarítással el is távolítjuk őket, ha még ott lennének. Az
// "invited_by = 'teszt-seed'" jelző pontosan ezeket azonosítja.
// ---------------------------------------------------------------------------
function removeLegacyTestUsers() {
  const removed = usersDb.prepare(`DELETE FROM users WHERE invited_by = 'teszt-seed'`).run();
  if (removed.changes > 0) {
    console.log(`[info] ${removed.changes} korábbi teszt-fiók eltávolítva az adatbázisból.`);
  }
}
removeLegacyTestUsers();

route('GET', '/api/sync/companies', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!verifySyncApiKey(apiKey)) return sendJson(res, 401, { error: 'Érvénytelen vagy hiányzó x-api-key.' });
  const meta = readSyncMeta();
  const list = [...companyIndex.entries()].map(([key, entry]) => ({
    key, nev: entry.nev, adoszam: entry.adoszam, varos: entry.varos,
    ...(meta[key] || { lastSync: null, source: null }),
  }));
  sendJson(res, 200, { count: list.length, companies: list });
});

// Élesedés előtt (kikapcsolt állapotban): minden aktív katalógus-funkció
// mindenkinek engedélyezett, a company_licenses tábla tartalmától
// függetlenül. Élesedéskor az admin a webről, egyetlen kapcsolóval
// bekapcsolhatja a tényleges érvényesítést — nincs szükség szerver-
// konfigurációhoz vagy újraindításhoz.
//
// Bekapcsolt érvényesítés esetén minden cég kap egy LICENSE_TRIAL_DAYS
// (alapértelmezetten 7) napos ingyenes próbaidőt, az első szinkronjától
// számítva — ezalatt ugyanúgy minden funkció engedélyezett, a `lejarat`
// mező pedig a próba végét mutatja. Nincs külön "próba" jelző vagy
// figyelmeztető mező: az app a meglévő lejarat-mezőt pontosan ugyanúgy
// kezeli, mint egy valódi, fizetett licencnél — a szerver oldalon a próba
// technikailag nem más, mint egy ideiglenes, mindenre kiterjedő "engedély".
// A próba lejárta UTÁN kizárólag a ténylegesen kiosztott (company_licenses)
// funkciók maradnak engedélyezve.
{
  const existing = licenseDb.prepare(`SELECT value FROM app_settings WHERE key = 'license_enforce'`).get();
  if (!existing) {
    const initial = process.env.LICENSE_ENFORCE === '1' ? '1' : '0';
    licenseDb.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('license_enforce', ?, ?)`)
      .run(initial, new Date().toISOString());
  }
}
function isLicenseEnforceOn() {
  const row = licenseDb.prepare(`SELECT value FROM app_settings WHERE key = 'license_enforce'`).get();
  return row ? row.value === '1' : false;
}
function isCompanyNtakActive(cegKulcs) {
  const row = licenseDb.prepare(`SELECT ntak_aktiv FROM company_settings WHERE ceg_kulcs = ?`).get(cegKulcs);
  return row ? !!row.ntak_aktiv : false;
}
const LICENSE_TRIAL_DAYS = parseInt(process.env.LICENSE_TRIAL_DAYS || '7', 10);

// ---------------------------------------------------------------------------
// myPOS Checkout API — bankkártyás fizetés előkészítése.
//
// FONTOS, ŐSZINTE MEGJEGYZÉS: ez az integráció a myPOS HIVATALOS
// dokumentációja (developers.mypos.com) alapján készült, de VALÓDI myPOS
// hozzáférés (kereskedői fiók, StoreID, RSA kulcspár, myPOS nyilvános
// tanúsítvány) NÉLKÜL nem tesztelhető végig élesben — ezeket a merchant
// portálon kell létrehoznod/letöltened, és az alábbi környezeti
// változókban megadnod, MIELŐTT élesbe állítanád. Amíg ezek nincsenek
// beállítva, a fizetés-indítás egyértelmű hibaüzenetet ad, nem próbál
// hibásan "úgy tenni", mintha működne.
//
// Szükséges környezeti változók:
//   MYPOS_SID              — StoreID (a myPOS kereskedői fiókodból)
//   MYPOS_WALLET           — Wallet/Client szám
//   MYPOS_KEY_INDEX        — a használt kulcs indexe (a merchant portálon adod meg)
//   MYPOS_PRIVATE_KEY_PATH — a TE saját RSA privát kulcsod (.pem fájl elérési útja)
//   MYPOS_PUBLIC_CERT_PATH — a myPOS nyilvános tanúsítványa (.pem, a merchant
//                            portálról letöltve) — ezzel ellenőrizzük, hogy a
//                            beérkező értesítés TÉNYLEG a myPOS-tól jött
//   MYPOS_SANDBOX           — "1" = teszt-környezet (alapértelmezett), "0" = éles
//   MYPOS_BASE_URL_OVERRIDE — opcionális, ha a myPOS URL-je változna
const MYPOS_SANDBOX = process.env.MYPOS_SANDBOX !== '0';
const MYPOS_CHECKOUT_URL = process.env.MYPOS_BASE_URL_OVERRIDE
  || (MYPOS_SANDBOX ? 'https://mypos.com/vmp/checkout-test/' : 'https://mypos.com/vmp/checkout/');

function myposConfigured() {
  return !!(process.env.MYPOS_SID && process.env.MYPOS_WALLET && process.env.MYPOS_PRIVATE_KEY_PATH);
}
function myposPrivateKey() {
  return fs.readFileSync(process.env.MYPOS_PRIVATE_KEY_PATH, 'utf8');
}
function myposPublicCert() {
  if (!process.env.MYPOS_PUBLIC_CERT_PATH) return null;
  return fs.readFileSync(process.env.MYPOS_PUBLIC_CERT_PATH, 'utf8');
}

// ---------------------------------------------------------------------------
// NAV ONLINE SZÁMLA — a magyar adóhatóság kötelező számla-adatszolgáltatási
// rendszeréhez való kapcsolódás (interfész specifikáció v3.0 alapján).
//
// Környezeti változók:
//   NAV_SANDBOX          — "1" = teszt-környezet (alapértelmezett), "0" = éles
//   NAV_BASE_URL_OVERRIDE — opcionális, ha a NAV API URL-je változna
//   NAV_TAXNUMBER         — az adatszolgáltatásra kötelezett cég adószámának
//                           első 8 számjegye (törzsszám)
//   NAV_TECH_USER         — a technikai felhasználó neve
//   NAV_TECH_PASSWORD     — a technikai felhasználó jelszava (literál)
//   NAV_SIGNING_KEY       — XML aláírókulcs
//   NAV_EXCHANGE_KEY      — XML cserekulcs
//   NAV_SOFTWARE_ID       — 18 karakteres szoftver-azonosító (opcionális,
//                           van ésszerű alapértelmezett)
// ---------------------------------------------------------------------------
const NAV_SANDBOX = process.env.NAV_SANDBOX !== '0';
const NAV_BASE_URL = process.env.NAV_BASE_URL_OVERRIDE
  || (NAV_SANDBOX ? 'https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3' : 'https://api.onlineszamla.nav.gov.hu/invoiceService/v3');

function navConfigured() {
  return !!(process.env.NAV_TAXNUMBER && process.env.NAV_TECH_USER && process.env.NAV_TECH_PASSWORD
    && process.env.NAV_SIGNING_KEY && process.env.NAV_EXCHANGE_KEY);
}
// Az üzemeltető (Leichter Irodatechnika) SAJÁT NAV-hitelesítő adatai,
// környezeti változókból — ezt használja a saját előfizetési
// számláinkhoz tartozó beküldés/lekérdezés (a mi, admin oldali NAV-
// integrációnk). Az ÜGYFELEK saját, cégenkénti hitelesítő adatai ettől
// FÜGGETLENEK, külön (titkosítva tárolt) adatbázis-táblából jönnek — lásd
// getCompanyNavCreds().
function navCredsFromEnv() {
  return {
    taxNumber: process.env.NAV_TAXNUMBER,
    techUser: process.env.NAV_TECH_USER,
    techPassword: process.env.NAV_TECH_PASSWORD,
    signingKey: process.env.NAV_SIGNING_KEY,
    exchangeKey: process.env.NAV_EXCHANGE_KEY,
    sandbox: NAV_SANDBOX,
  };
}
function navCredsComplete(creds) {
  return !!(creds && creds.taxNumber && creds.techUser && creds.techPassword && creds.signingKey && creds.exchangeKey);
}
function navBaseUrlFor(sandbox) {
  return sandbox ? 'https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3' : 'https://api.onlineszamla.nav.gov.hu/invoiceService/v3';
}
// Egy cég SAJÁT NAV-hitelesítő adatainak kiolvasása és visszafejtése — ha
// a cég nem állított be sajátot, null-t ad vissza (nincs mit lekérdezni).
function getCompanyNavCreds(cegKulcs) {
  const row = licenseDb.prepare(`SELECT * FROM company_nav_credentials WHERE ceg_kulcs = ?`).get(cegKulcs);
  if (!row) return null;
  return {
    taxNumber: row.nav_taxnumber,
    techUser: row.nav_tech_user,
    techPassword: decryptNavSecret(row.nav_tech_password_enc),
    signingKey: decryptNavSecret(row.nav_signing_key_enc),
    exchangeKey: decryptNavSecret(row.nav_exchange_key_enc),
    sandbox: !!row.nav_sandbox,
  };
}
// Best-effort 18 karakteres szoftver-azonosító: HU + a fejlesztő cég
// (Leichter Irodatechnika Kft.) adószám-törzsszáma + egy rögzített utótag,
// pontosan 18 karakterre kiegészítve. Ha a NAV másképp várná el, a
// NAV_SOFTWARE_ID env változóval felülírható kódmódosítás nélkül.
function navSoftwareId() {
  return process.env.NAV_SOFTWARE_ID || 'HU12491980ENYUGTA1';
}

// A NAV időbélyeg-formátuma: yyyyMMddHHmmss, UTC időben, elválasztójelek
// nélkül (a specifikáció ezt írja elő a requestSignature számításához is,
// és ugyanezt a maszkolt formát várja a timestamp XML-tag tartalmául is,
// UTC-ben kifejezve, 'Z' jelöléssel az xs:dateTime mezőben).
function navTimestampMasked(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
}
function navTimestampIso(date = new Date()) {
  return date.toISOString(); // pl. 2026-07-22T21:00:00.000Z — az ezredmásodperceket és a 'Z'-t MEG KELL TARTANI
}
function navRequestId() {
  // Előírás: max. 30 karakter, adózónként/technikai felhasználónként
  // egyedi kell legyen — az időbélyeg + véletlen rész biztosítja ezt.
  return `LNY${Date.now()}${crypto.randomBytes(4).toString('hex')}`.slice(0, 30);
}
function navPasswordHash(password) {
  return crypto.createHash('sha512').update(password, 'utf8').digest('hex').toUpperCase();
}
// requestSignature a LEGTÖBB operációhoz (tokenExchange, queryTransactionStatus,
// stb.) — a manageInvoice/manageAnnulment KIVÉTELÉVEL, azoknál külön,
// tételenkénti index-hash-eket is tartalmazó számítás kell (lásd lejjebb).
function navRequestSignatureSimple(requestId, timestampMasked, signingKey) {
  const concatenated = `${requestId}${timestampMasked}${signingKey}`;
  return crypto.createHash('sha3-512').update(concatenated, 'utf8').digest('hex').toUpperCase();
}
// requestSignature a manageInvoice operációhoz — EGY VALÓDI, VÉGIGSZÁMOLT
// NAV-példával megerősítve (nem találgatás):
// 1) "parciális hitelesítés" = a NYERS (MÉG NEM hash-elt!) requestId + timestamp + aláírókulcs string
// 2) minden egyes tételhez (1-100 index) egy "index hash" = kisbetűs
//    hex SHA3-512(operation + base64(számla-XML))
// 3) a végső requestSignature = nagybetűs SHA3-512(a nyers parciális string + az összes index hash, sorrendben összefűzve) — VAGYIS csak EGYSZER hash-elünk, a végén.
function navRequestSignatureManageInvoice(requestId, timestampMasked, signingKey, items) {
  const partialAuthRaw = `${requestId}${timestampMasked}${signingKey}`;
  // FONTOS: az index hash-ek ÖNMAGUKBAN kisbetűs hex stringet adnak
  // (.digest('hex') alapértelmezése), DE a hivatalos NAV-példa szerint a
  // VÉGSŐ konkatenációba NAGYBETŰSEN kerülnek be — ezt egy valódi,
  // végigszámolt NAV-dokumentációs példával közvetlenül megerősítettük.
  const indexHashes = items.map(({ operation, base64Content }) =>
    crypto.createHash('sha3-512').update(`${operation}${base64Content}`, 'utf8').digest('hex').toUpperCase()
  );
  const finalInput = partialAuthRaw + indexHashes.join('');
  const signature = crypto.createHash('sha3-512').update(finalInput, 'utf8').digest('hex').toUpperCase();
  return { signature, debug: { partialAuthRaw, indexHashes, finalInputLength: finalInput.length } };
}
// A /tokenExchange válaszban kapott token AES-128 ECB titkosítással van
// kódolva (a cserekulccsal, mint 16 bájtos kulccsal) — ezt kell nekünk,
// kliens oldalon visszafejtenünk, mielőtt a manageInvoice hívásban a
// nyílt (dekódolt) tokent elküldenénk.
function navDecryptExchangeToken(base64Token, exchangeKey) {
  const keyBuf = Buffer.alloc(16);
  Buffer.from(exchangeKey, 'utf8').copy(keyBuf, 0, 0, Math.min(16, Buffer.byteLength(exchangeKey, 'utf8')));
  const decipher = crypto.createDecipheriv('aes-128-ecb', keyBuf, null);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(base64Token, 'base64')), decipher.final()]);
  return decrypted.toString('utf8');
}

// Egyszerű, EGYSZINTŰ XML-mezőkinyerő (nem teljes XML-parser) — a NAV
// válaszok síkjában elég egy adott tag TARTALMÁT kiolvasni névvel, még ha
// az adott tag esetleg attribútumokat is hordoz. Beágyazott, azonos nevű
// tagek esetén az ELSŐ előfordulást adja vissza — ez a legtöbb NAV-válasz
// mezőnél elég (a válaszok nem mélyen egymásba ágyazottak).
function navXmlField(xml, tag) {
  const m = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'i').exec(xml);
  return m ? m[1].trim() : null;
}
function navXmlFieldAll(xml, tag) {
  const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1].trim());
  return out;
}

function navHeaderXml(requestId, timestampIso) {
  return `<common:header>
    <common:requestId>${requestId}</common:requestId>
    <common:timestamp>${timestampIso}</common:timestamp>
    <common:requestVersion>3.0</common:requestVersion>
    <common:headerVersion>1.0</common:headerVersion>
  </common:header>`;
}
function navUserXml(requestSignature, creds) {
  return `<common:user>
    <common:login>${escapeXml(creds.techUser)}</common:login>
    <common:passwordHash cryptoType="SHA-512">${navPasswordHash(creds.techPassword)}</common:passwordHash>
    <common:taxNumber>${escapeXml(creds.taxNumber)}</common:taxNumber>
    <common:requestSignature cryptoType="SHA3-512">${requestSignature}</common:requestSignature>
  </common:user>`;
}
function navSoftwareXml() {
  return `<software>
    <softwareId>${navSoftwareId()}</softwareId>
    <softwareName>L-NYUGTA</softwareName>
    <softwareOperation>LOCAL_SOFTWARE</softwareOperation>
    <softwareMainVersion>1.0</softwareMainVersion>
    <softwareDevName>${escapeXml(ELADO_NEV)}</softwareDevName>
    <softwareDevContact>info@lnyugta.hu</softwareDevContact>
    <softwareDevCountryCode>HU</softwareDevCountryCode>
    <softwareDevTaxNumber>${ELADO_ADOSZAM.slice(0, 8)}</softwareDevTaxNumber>
  </software>`;
}
function escapeXml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Magyar adószám ("12345678-1-42" formátum) szétbontása a NAV XML-hez
// szükséges 3 részre: törzsszám (8 jegy), ÁFA-kód (1 jegy), megyekód (2 jegy).
// A NAV séma (base:detailedAddress) kötelezővé teszi az irányítószámot,
// települést, közterület nevét és a házszámot — ha bármelyik hiányzik, a
// beküldés garantáltan elutasításra kerülne (ABORTED), ezért ezt előre
// leellenőrizzük, és inkább egyáltalán nem küldünk be hiányos adatot.
function navAddressComplete(cim) {
  return !!(cim && cim.iranyitoszam && cim.telepules && cim.kozteruletNev && cim.hazszam);
}
function parseHunTaxNumber(adoszam) {
  const digits = String(adoszam || '').replace(/[^0-9]/g, '');
  return { taxpayerId: digits.slice(0, 8), vatCode: digits.slice(8, 9) || '2', countyCode: digits.slice(9, 11) || '42' };
}
function navAddressXml(tagName, addr) {
  return `<${tagName}>
      <base:detailedAddress>
        <base:countryCode>HU</base:countryCode>
        <base:postalCode>${escapeXml(addr.iranyitoszam)}</base:postalCode>
        <base:city>${escapeXml(addr.telepules)}</base:city>
        <base:streetName>${escapeXml(addr.kozteruletNev)}</base:streetName>
        <base:publicPlaceCategory>${escapeXml(addr.kozteruletJelleg || 'egyéb')}</base:publicPlaceCategory>
        <base:number>${escapeXml(addr.hazszam)}</base:number>
      </base:detailedAddress>
    </${tagName}>`;
}

// A tényleges számla-XML felépítése — a NAV hivatalos, publikus mintaXML-je
// (nav-gov-hu/Online-Invoice GitHub-tárhely) alapján, telephely-előfizetési
// szolgáltatás-számlázásra igazítva (SERVICE jellegű tételek, nem termék).
// Az itt kapott árakat BRUTTÓnak tekintjük (lásd splitBruttoToNettoAfa).
function buildNavInvoiceDataXml({ invoiceNumber, invoiceIssueDate, buyerName, buyerTaxNumber, buyerAddress, tetelek, penznem }) {
  const eladoCim = { iranyitoszam: '2200', telepules: 'Monor', kozteruletNev: 'Virág', kozteruletJelleg: 'utca', hazszam: '39' };
  // FONTOS: az eladó adószámának a számla-XML-ben PONTOSAN egyeznie kell a
  // NAV technikai felhasználó hitelesítéséhez tartozó adószámmal
  // (NAV_TAXNUMBER) — ez NEM feltétlenül ugyanaz, mint a cég "hivatalos",
  // máshol megjelenített adószáma (ELADO_ADOSZAM), pl. teszt-környezetben
  // egy erre a célra regisztrált teszt-adószám tartozhat a technikai
  // felhasználóhoz. A NAV_TAXNUMBER_VATCODE / NAV_TAXNUMBER_COUNTY env
  // változókkal a törzsszám melletti két számjegy is felülírható, ha nem a
  // leggyakoribb "2" (belföldi, normál adóalany) és "42" (Budapest) illik.
  const eladoTax = {
    taxpayerId: (process.env.NAV_TAXNUMBER || '').padStart(8, '0'),
    vatCode: process.env.NAV_TAXNUMBER_VATCODE || '2',
    countyCode: process.env.NAV_TAXNUMBER_COUNTY || '42',
  };
  const vevoTax = parseHunTaxNumber(buyerTaxNumber);
  const tetelekBontva = tetelek.map((t) => ({ ...t, ...splitBruttoToNettoAfa(t.osszeg) }));
  const nettoOsszesen = tetelekBontva.reduce((s, t) => s + t.netto, 0);
  const afaOsszesen = tetelekBontva.reduce((s, t) => s + t.afa, 0);
  const bruttoOsszesen = tetelekBontva.reduce((s, t) => s + t.brutto, 0);
  const vatPercentageDecimal = (ELEKTRONIKUS_SZOLGALTATAS_AFA_KULCS).toFixed(2); // pl. 0.27

  const linesXml = tetelekBontva.map((t, i) => `<line>
        <lineNumber>${i + 1}</lineNumber>
        <lineExpressionIndicator>true</lineExpressionIndicator>
        <lineNatureIndicator>SERVICE</lineNatureIndicator>
        <lineDescription>${escapeXml(t.nev)}</lineDescription>
        <quantity>1.00</quantity>
        <unitOfMeasure>OWN</unitOfMeasure>
        <unitOfMeasureOwn>hónap</unitOfMeasureOwn>
        <unitPrice>${t.netto}</unitPrice>
        <unitPriceHUF>${t.netto}</unitPriceHUF>
        <lineAmountsNormal>
          <lineNetAmountData>
            <lineNetAmount>${t.netto}</lineNetAmount>
            <lineNetAmountHUF>${t.netto}</lineNetAmountHUF>
          </lineNetAmountData>
          <lineVatRate>
            <vatPercentage>${vatPercentageDecimal}</vatPercentage>
          </lineVatRate>
          <lineVatData>
            <lineVatAmount>${t.afa}</lineVatAmount>
            <lineVatAmountHUF>${t.afa}</lineVatAmountHUF>
          </lineVatData>
          <lineGrossAmountData>
            <lineGrossAmountNormal>${t.brutto}</lineGrossAmountNormal>
            <lineGrossAmountNormalHUF>${t.brutto}</lineGrossAmountNormalHUF>
          </lineGrossAmountData>
        </lineAmountsNormal>
      </line>`).join('\n      ');

  return `<InvoiceData xmlns="http://schemas.nav.gov.hu/OSA/3.0/data" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://schemas.nav.gov.hu/OSA/3.0/data invoiceData.xsd" xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common" xmlns:base="http://schemas.nav.gov.hu/OSA/3.0/base">
  <invoiceNumber>${escapeXml(invoiceNumber)}</invoiceNumber>
  <invoiceIssueDate>${invoiceIssueDate}</invoiceIssueDate>
  <completenessIndicator>false</completenessIndicator>
  <invoiceMain>
    <invoice>
      <invoiceHead>
        <supplierInfo>
          <supplierTaxNumber>
            <base:taxpayerId>${eladoTax.taxpayerId}</base:taxpayerId>
            <base:vatCode>${eladoTax.vatCode}</base:vatCode>
            <base:countyCode>${eladoTax.countyCode}</base:countyCode>
          </supplierTaxNumber>
          <supplierName>${escapeXml(ELADO_NEV)}</supplierName>
          <supplierAddress>
            <base:detailedAddress>
              <base:countryCode>HU</base:countryCode>
              <base:postalCode>${eladoCim.iranyitoszam}</base:postalCode>
              <base:city>${eladoCim.telepules}</base:city>
              <base:streetName>${eladoCim.kozteruletNev}</base:streetName>
              <base:publicPlaceCategory>${eladoCim.kozteruletJelleg}</base:publicPlaceCategory>
              <base:number>${eladoCim.hazszam}</base:number>
            </base:detailedAddress>
          </supplierAddress>
        </supplierInfo>
        <customerInfo>
          <customerVatStatus>DOMESTIC</customerVatStatus>
          <customerVatData>
            <customerTaxNumber>
              <base:taxpayerId>${vevoTax.taxpayerId}</base:taxpayerId>
              <base:vatCode>${vevoTax.vatCode}</base:vatCode>
              <base:countyCode>${vevoTax.countyCode}</base:countyCode>
            </customerTaxNumber>
          </customerVatData>
          <customerName>${escapeXml(buyerName)}</customerName>
          ${navAddressXml('customerAddress', buyerAddress || {})}
        </customerInfo>
        <invoiceDetail>
          <invoiceCategory>NORMAL</invoiceCategory>
          <invoiceDeliveryDate>${invoiceIssueDate}</invoiceDeliveryDate>
          <currencyCode>${penznem}</currencyCode>
          <exchangeRate>1</exchangeRate>
          <paymentMethod>CARD</paymentMethod>
          <paymentDate>${invoiceIssueDate}</paymentDate>
          <invoiceAppearance>ELECTRONIC</invoiceAppearance>
        </invoiceDetail>
      </invoiceHead>
      <invoiceLines>
        <mergedItemIndicator>false</mergedItemIndicator>
        ${linesXml}
      </invoiceLines>
      <invoiceSummary>
        <summaryNormal>
          <summaryByVatRate>
            <vatRate>
              <vatPercentage>${vatPercentageDecimal}</vatPercentage>
            </vatRate>
            <vatRateNetData>
              <vatRateNetAmount>${nettoOsszesen}</vatRateNetAmount>
              <vatRateNetAmountHUF>${nettoOsszesen}</vatRateNetAmountHUF>
            </vatRateNetData>
            <vatRateVatData>
              <vatRateVatAmount>${afaOsszesen}</vatRateVatAmount>
              <vatRateVatAmountHUF>${afaOsszesen}</vatRateVatAmountHUF>
            </vatRateVatData>
          </summaryByVatRate>
          <invoiceNetAmount>${nettoOsszesen}</invoiceNetAmount>
          <invoiceNetAmountHUF>${nettoOsszesen}</invoiceNetAmountHUF>
          <invoiceVatAmount>${afaOsszesen}</invoiceVatAmount>
          <invoiceVatAmountHUF>${afaOsszesen}</invoiceVatAmountHUF>
        </summaryNormal>
        <summaryGrossData>
          <invoiceGrossAmount>${bruttoOsszesen}</invoiceGrossAmount>
          <invoiceGrossAmountHUF>${bruttoOsszesen}</invoiceGrossAmountHUF>
        </summaryGrossData>
      </invoiceSummary>
    </invoice>
  </invoiceMain>
</InvoiceData>`;
}

// ============================================================================
// NAGYKER B2B SZÁMLÁZÁS (2026-07-24 hozzáadva)
// ============================================================================
// A buildNavInvoiceDataXml-től eltérően itt az ELADÓ (kibocsátó) NEM
// hardkódolt (paraméterként jön), és a tételek VALÓDI mennyiséget /
// mértékegységet kapnak (PRODUCT jellegű tétel, nem "1 hónap SERVICE").
// A Nagyker modul (lnyugta.hu/nagyker) hívja meg ezt egy internal route-on
// keresztül, rendelés-jóváhagyáskor.

// --- Nagyker-számlák saját, cégenkénti sorszám-sorozata ---------------------
function nextNagykerInvoiceNumber(cegKulcs) {
  licenseDb.exec(`
    CREATE TABLE IF NOT EXISTS nagyker_invoice_counter (
      ceg_kulcs TEXT NOT NULL,
      ev INTEGER NOT NULL,
      utolso_sorszam INTEGER NOT NULL,
      PRIMARY KEY (ceg_kulcs, ev)
    );
  `);
  const ev = new Date().getFullYear();
  const row = licenseDb.prepare(`SELECT utolso_sorszam FROM nagyker_invoice_counter WHERE ceg_kulcs = ? AND ev = ?`).get(cegKulcs, ev);
  const sorszam = row ? row.utolso_sorszam + 1 : 1;
  licenseDb.prepare(`
    INSERT INTO nagyker_invoice_counter (ceg_kulcs, ev, utolso_sorszam) VALUES (?, ?, ?)
    ON CONFLICT(ceg_kulcs, ev) DO UPDATE SET utolso_sorszam = excluded.utolso_sorszam
  `).run(cegKulcs, ev, sorszam);
  return `NK-${cegKulcs}-${ev}/${String(sorszam).padStart(6, '0')}`;
}

function buildNagykerInvoiceDataXml({
  invoiceNumber, invoiceIssueDate,
  sellerName, sellerTaxNumber, sellerAddress,
  buyerName, buyerTaxNumber, buyerAddress,
  tetelek, penznem,
}) {
  const eladoTax = parseHunTaxNumber(sellerTaxNumber);
  const vevoTax = parseHunTaxNumber(buyerTaxNumber);
  const tetelekBontva = tetelek.map((t) => ({ ...t, ...splitBruttoToNettoAfa(t.osszeg) }));
  const vatPercentageDecimal = ELEKTRONIKUS_SZOLGALTATAS_AFA_KULCS.toFixed(2);

  const linesXml = tetelekBontva.map((t, i) => `<line>
        <lineNumber>${i + 1}</lineNumber>
        <lineExpressionIndicator>true</lineExpressionIndicator>
        <lineNatureIndicator>PRODUCT</lineNatureIndicator>
        <lineDescription>${escapeXml(t.nev)}</lineDescription>
        <quantity>${(t.mennyiseg ?? 1).toFixed(2)}</quantity>
        <unitOfMeasure>OWN</unitOfMeasure>
        <unitOfMeasureOwn>${escapeXml(t.mertekegyseg || 'db')}</unitOfMeasureOwn>
        <unitPrice>${(t.netto / (t.mennyiseg || 1)).toFixed(2)}</unitPrice>
        <unitPriceHUF>${(t.netto / (t.mennyiseg || 1)).toFixed(2)}</unitPriceHUF>
        <lineAmountsNormal>
          <lineNetAmountData>
            <lineNetAmount>${t.netto}</lineNetAmount>
            <lineNetAmountHUF>${t.netto}</lineNetAmountHUF>
          </lineNetAmountData>
          <lineVatRate>
            <vatPercentage>${vatPercentageDecimal}</vatPercentage>
          </lineVatRate>
          <lineVatData>
            <lineVatAmount>${t.afa}</lineVatAmount>
            <lineVatAmountHUF>${t.afa}</lineVatAmountHUF>
          </lineVatData>
          <lineGrossAmountData>
            <lineGrossAmountNormal>${t.brutto}</lineGrossAmountNormal>
            <lineGrossAmountNormalHUF>${t.brutto}</lineGrossAmountNormalHUF>
          </lineGrossAmountData>
        </lineAmountsNormal>
      </line>`).join('\n      ');

  return `<InvoiceData xmlns="http://schemas.nav.gov.hu/OSA/3.0/data" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://schemas.nav.gov.hu/OSA/3.0/data invoiceData.xsd" xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common" xmlns:base="http://schemas.nav.gov.hu/OSA/3.0/base">
  <invoiceNumber>${escapeXml(invoiceNumber)}</invoiceNumber>
  <invoiceIssueDate>${invoiceIssueDate}</invoiceIssueDate>
  <completenessIndicator>false</completenessIndicator>
  <invoiceMain>
    <invoice>
      <invoiceHead>
        <supplierInfo>
          <supplierTaxNumber>
            <base:taxpayerId>${eladoTax.taxpayerId}</base:taxpayerId>
            <base:vatCode>${eladoTax.vatCode}</base:vatCode>
            <base:countyCode>${eladoTax.countyCode}</base:countyCode>
          </supplierTaxNumber>
          <supplierName>${escapeXml(sellerName)}</supplierName>
          ${navAddressXml('supplierAddress', sellerAddress)}
        </supplierInfo>
        <customerInfo>
          <customerVatStatus>DOMESTIC</customerVatStatus>
          <customerVatData>
            <customerTaxNumber>
              <taxpayerId>${vevoTax.taxpayerId}</taxpayerId>
              <vatCode>${vevoTax.vatCode}</vatCode>
              <countyCode>${vevoTax.countyCode}</countyCode>
            </customerTaxNumber>
          </customerVatData>
          <customerName>${escapeXml(buyerName)}</customerName>
          ${navAddressXml('customerAddress', buyerAddress)}
        </customerInfo>
        <invoiceDetail>
          <invoiceCategory>NORMAL</invoiceCategory>
          <invoiceDeliveryDate>${invoiceIssueDate}</invoiceDeliveryDate>
          <invoiceAppearance>ELECTRONIC</invoiceAppearance>
          <currencyCode>${escapeXml(penznem || 'HUF')}</currencyCode>
          <exchangeRate>1.00</exchangeRate>
        </invoiceDetail>
      </invoiceHead>
      <invoiceLines>
        <mergedItemIndicator>false</mergedItemIndicator>
        ${linesXml}
      </invoiceLines>
    </invoice>
  </invoiceMain>
</InvoiceData>`;
}
// FONTOS, MIELŐTT ÉLESBEN HASZNÁLOD: ezt az XML-vázat a meglévő
// buildNavInvoiceDataXml mintájából származtattam, DE nem volt módunk élő
// NAV sandbox ellen tesztelni (nincs hozzáférés). Az ELSŐ néhány számlát
// MINDENKÉPP NAV teszt- (sandbox) környezetben küldd be, és nézd meg a NAV
// válaszát (navQueryTransactionStatus), mielőtt éles adószámmal élesítenéd.

function buildNagykerInvoicePdf({
  sellerName, sellerAddress, sellerTaxNumber,
  buyerName, buyerAddress, buyerTaxNumber,
  tetelek, penznem, datum, szamlaSorszam,
}) {
  const tetelekBontva = tetelek.map((t) => ({ ...t, ...splitBruttoToNettoAfa(t.osszeg) }));
  const bruttoOsszesen = tetelekBontva.reduce((s, t) => s + t.brutto, 0);
  const nettoOsszesen = tetelekBontva.reduce((s, t) => s + t.netto, 0);
  const afaOsszesen = tetelekBontva.reduce((s, t) => s + t.afa, 0);

  const JADE = [0.35, 0.58, 0.79]; const INK = [0.16, 0.2, 0.28]; const DIM = [0.45, 0.48, 0.53];
  const els = [];
  els.push({ type: 'rect', x: 0, y: 0, w: 595, h: 90, fill: JADE });
  els.push({ type: 'text', x: 50, y: 40, text: sellerName, size: 18, bold: true, color: [1, 1, 1] });
  els.push({ type: 'text', x: 50, y: 62, text: 'Szamla', size: 11, color: [1, 1, 1] });
  els.push({ type: 'text', x: 380, y: 32, text: 'Szamla sorszama:', size: 9, color: [1, 1, 1] });
  els.push({ type: 'text', x: 380, y: 46, text: szamlaSorszam, size: 12, bold: true, color: [1, 1, 1] });
  els.push({ type: 'text', x: 380, y: 62, text: `Kibocsatas kelte: ${datum}`, size: 9, color: [1, 1, 1] });
  els.push({ type: 'text', x: 380, y: 76, text: `Teljesites kelte: ${datum}`, size: 9, color: [1, 1, 1] });

  const infoTop = 130;
  els.push({ type: 'text', x: 50, y: infoTop, text: 'ELADO', size: 9, bold: true, color: DIM });
  els.push({ type: 'text', x: 50, y: infoTop + 16, text: sellerName, size: 11, bold: true, color: INK });
  els.push({ type: 'text', x: 50, y: infoTop + 31, text: sellerAddress?.szoveg || '-', size: 9, color: DIM });
  els.push({ type: 'text', x: 50, y: infoTop + 45, text: `Adoszam: ${sellerTaxNumber || '-'}`, size: 9, color: DIM });

  els.push({ type: 'text', x: 320, y: infoTop, text: 'VEVO', size: 9, bold: true, color: DIM });
  els.push({ type: 'text', x: 320, y: infoTop + 16, text: buyerName, size: 11, bold: true, color: INK });
  els.push({ type: 'text', x: 320, y: infoTop + 31, text: buyerAddress?.szoveg || '(nincs megadva szamlazasi cim)', size: 9, color: DIM });
  els.push({ type: 'text', x: 320, y: infoTop + 45, text: `Adoszam: ${buyerTaxNumber || '-'}`, size: 9, color: DIM });

  els.push({ type: 'line', x1: 50, y1: infoTop + 76, x2: 545, y2: infoTop + 76, color: [0.85, 0.85, 0.85], width: 1 });

  const tableTop = infoTop + 100;
  els.push({ type: 'rect', x: 50, y: tableTop - 16, w: 495, h: 22, fill: [0.95, 0.96, 0.97] });
  els.push({ type: 'text', x: 55, y: tableTop, text: 'Megnevezes', size: 8.5, bold: true, color: INK });
  els.push({ type: 'text', x: 230, y: tableTop, text: 'Menny.', size: 8.5, bold: true, color: INK });
  els.push({ type: 'text', x: 280, y: tableTop, text: 'Netto egys.ar', size: 8.5, bold: true, color: INK });
  els.push({ type: 'text', x: 345, y: tableTop, text: 'AFA%', size: 8.5, bold: true, color: INK });
  els.push({ type: 'text', x: 375, y: tableTop, text: 'AFA osszeg', size: 8.5, bold: true, color: INK });
  els.push({ type: 'text', x: 450, y: tableTop, text: 'Brutto', size: 8.5, bold: true, color: INK });
  let rowY = tableTop + 24;
  for (const t of tetelekBontva) {
    const nevRovidítve = t.nev.length > 28 ? `${t.nev.slice(0, 25)}...` : t.nev;
    const egysegNetto = Math.round(t.netto / (t.mennyiseg || 1));
    els.push({ type: 'text', x: 55, y: rowY, text: nevRovidítve, size: 8.5, color: INK });
    els.push({ type: 'text', x: 230, y: rowY, text: `${t.mennyiseg || 1} ${t.mertekegyseg || 'db'}`, size: 8.5, color: INK });
    els.push({ type: 'text', x: 280, y: rowY, text: `${egysegNetto.toLocaleString('hu-HU')}`, size: 8.5, color: INK });
    els.push({ type: 'text', x: 345, y: rowY, text: `${t.afaSzazalek}%`, size: 8.5, color: INK });
    els.push({ type: 'text', x: 375, y: rowY, text: `${t.afa.toLocaleString('hu-HU')}`, size: 8.5, color: INK });
    els.push({ type: 'text', x: 450, y: rowY, text: `${t.brutto.toLocaleString('hu-HU')} ${penznem}`, size: 8.5, color: INK });
    els.push({ type: 'line', x1: 50, y1: rowY + 9, x2: 545, y2: rowY + 9, color: [0.92, 0.92, 0.92], width: 0.5 });
    rowY += 22;
  }
  rowY += 8;
  els.push({ type: 'line', x1: 50, y1: rowY, x2: 545, y2: rowY, color: INK, width: 1.2 });
  rowY += 18;
  els.push({ type: 'text', x: 280, y: rowY, text: `Netto osszesen: ${nettoOsszesen.toLocaleString('hu-HU')} ${penznem}`, size: 9, color: DIM });
  rowY += 15;
  els.push({ type: 'text', x: 280, y: rowY, text: `AFA osszesen: ${afaOsszesen.toLocaleString('hu-HU')} ${penznem}`, size: 9, color: DIM });
  rowY += 20;
  els.push({ type: 'text', x: 280, y: rowY, text: 'Fizetendo (brutto)', size: 12, bold: true, color: INK });
  els.push({ type: 'text', x: 450, y: rowY, text: `${bruttoOsszesen.toLocaleString('hu-HU')} ${penznem}`, size: 13, bold: true, color: JADE });

  return buildSimplePdf(els);
}

// --- Orchestrátor: NAV-kapcsolat lekérdezése + XML + beküldés + PDF + email -
async function submitNagykerInvoice({ cegKulcs, sellerName, buyerName, buyerTaxNumber, buyerAddress, buyerEmail, tetelek, penznem = 'HUF' }) {
  const creds = getCompanyNavCreds(cegKulcs);
  if (!creds || !navCredsComplete(creds)) {
    throw new Error(`A(z) "${cegKulcs}" cégnek nincs beállítva saját NAV-kapcsolata (Profil > NAV Online Számla).`);
  }
  const settings = licenseDb.prepare('SELECT * FROM company_settings WHERE ceg_kulcs = ?').get(cegKulcs);
  const sellerAddress = settings ? {
    iranyitoszam: settings.szamlazasi_iranyitoszam, telepules: settings.szamlazasi_telepules,
    kozteruletNev: settings.szamlazasi_kozterulet_nev, kozteruletJelleg: settings.szamlazasi_kozterulet_jelleg,
    hazszam: settings.szamlazasi_hazszam,
    szoveg: `${settings.szamlazasi_iranyitoszam || ''} ${settings.szamlazasi_telepules || ''}, ${settings.szamlazasi_kozterulet_nev || ''} ${settings.szamlazasi_kozterulet_jelleg || ''} ${settings.szamlazasi_hazszam || ''}`.trim(),
  } : null;
  if (!sellerAddress || !navAddressComplete(sellerAddress)) {
    throw new Error(`A(z) "${cegKulcs}" cég számlázási címe hiányos vagy nincs beállítva (Profil > Cégadatok).`);
  }

  const datum = todayIsoServer();
  const szamlaSorszam = nextNagykerInvoiceNumber(cegKulcs);
  const sellerTaxNumber = creds.taxNumber;

  const invoiceDataXml = buildNagykerInvoiceDataXml({
    invoiceNumber: szamlaSorszam, invoiceIssueDate: datum,
    sellerName, sellerTaxNumber, sellerAddress,
    buyerName, buyerTaxNumber, buyerAddress,
    tetelek, penznem,
  });

  const { transactionId } = await navSubmitInvoice(invoiceDataXml, creds);

  const pdf = buildNagykerInvoicePdf({
    sellerName, sellerAddress, sellerTaxNumber,
    buyerName, buyerAddress, buyerTaxNumber,
    tetelek, penznem, datum, szamlaSorszam,
  });
  const fajlnev = `${szamlaSorszam.replace(/\//g, '-')}.pdf`;
  fs.writeFileSync(path.join(INVOICES_DIR, fajlnev), pdf);

  if (buyerEmail) {
    try {
      await sendBrevoEmail({
        toEmail: buyerEmail, toName: buyerName,
        subject: `Számla — ${szamlaSorszam}`,
        html: `<p>Tisztelt ${escapeXml(buyerName)}!</p><p>Csatoltan küldjük a(z) <b>${escapeXml(szamlaSorszam)}</b> számú számlát.</p><p>Üdvözlettel,<br>${escapeXml(sellerName)}</p>`,
        attachments: [{ name: `${fajlnev}`, content: pdf }],
      });
    } catch (emailErr) {
      // A számla EKKORRA már beküldésre került a NAV-nak — az email-küldés
      // hibája nem vonhatja vissza ezt. A hívó (Nagyker modul) felelőssége
      // eldönteni, mit tesz, ha emailHiba nem null (pl. figyelmezteti a nagykert).
      return { szamlaSorszam, transactionId, fajlnev, emailHiba: emailErr.message };
    }
  }

  logActivity({ type: 'nagyker_invoice_created', ok: true, companyKey: cegKulcs, nev: null, detail: `Nagyker számla beküldve: ${szamlaSorszam} (NAV tranzakció: ${transactionId})` });

  return { szamlaSorszam, transactionId, fajlnev, emailHiba: null };
}

// POST /internal/nagyker/create-invoice — a Nagyker modul hívja meg,
// szerver-szerver kérésként (nem böngészőből), rendelés-jóváhagyáskor.
// Védelem: közös titok fejlécben (NEM böngésző-elérhető route).
route('POST', '/api/internal/nagyker/create-invoice', async (req, res) => {
  if (!NAGYKER_BRIDGE_SECRET || req.headers['x-internal-secret'] !== NAGYKER_BRIDGE_SECRET) {
    return sendJson(res, 401, { error: 'UNAUTHORIZED' });
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: 'INVALID_JSON' });
  }
  const { cegKulcs, sellerName, buyerName, buyerTaxNumber, buyerAddress, buyerEmail, tetelek, penznem } = body || {};
  if (!cegKulcs || !sellerName || !buyerName || !buyerTaxNumber || !Array.isArray(tetelek) || tetelek.length === 0) {
    return sendJson(res, 400, { error: 'MISSING_FIELDS' });
  }
  try {
    const eredmeny = await submitNagykerInvoice({ cegKulcs, sellerName, buyerName, buyerTaxNumber, buyerAddress, buyerEmail, tetelek, penznem });
    return sendJson(res, 200, eredmeny);
  } catch (err) {
    console.error('[nagyker-szamlazas] hiba:', err.message);
    return sendJson(res, 500, { error: err.message });
  }
});

async function navApiCall(operation, bodyXml, baseUrl) {
  const resp = await fetch(`${baseUrl || NAV_BASE_URL}/${operation}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml; charset=UTF-8', 'Accept': 'application/xml' },
    body: `<?xml version="1.0" encoding="UTF-8"?>\n${bodyXml}`,
  });
  const text = await resp.text();
  return { status: resp.status, text };
}

// Az adatszolgáltatási munkamenethez szükséges, DEKÓDOLT token lekérése.
// FONTOS, ŐSZINTE MEGJEGYZÉS: ez a NAV hivatalos interfész-specifikációja
// (v3.0) és több független, technikai forrás alapján legjobb tudásunk
// szerint készült — a pontos XML-elemsorrendet/névteret valódi NAV
// teszt-környezet elleni éles próbával kell megerősíteni (erre a
// sandboxunkban nincs kimenő hálózati hozzáférés).
async function navTokenExchange(creds = navCredsFromEnv()) {
  if (!navCredsComplete(creds)) throw new Error('A NAV-kapcsolat nincs beállítva (hiányzó hitelesítő adatok).');
  const requestId = navRequestId();
  const now = new Date();
  const timestampMasked = navTimestampMasked(now);
  const timestampIso = navTimestampIso(now);
  const requestSignature = navRequestSignatureSimple(requestId, timestampMasked, creds.signingKey);

  const bodyXml = `<TokenExchangeRequest xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common" xmlns="http://schemas.nav.gov.hu/OSA/3.0/api">
${navHeaderXml(requestId, timestampIso)}
${navUserXml(requestSignature, creds)}
${navSoftwareXml()}
</TokenExchangeRequest>`;

  const { status, text } = await navApiCall('tokenExchange', bodyXml, navBaseUrlFor(creds.sandbox));
  if (status !== 200) {
    const errorMsg = navXmlField(text, 'message') || navXmlField(text, 'errorCode') || `HTTP ${status}`;
    throw new Error(`NAV tokenExchange hiba: ${errorMsg}`);
  }
  const encodedToken = navXmlField(text, 'encodedExchangeToken');
  if (!encodedToken) throw new Error(`A NAV válaszában nem található token. Nyers válasz: ${text.slice(0, 500)}`);
  const decodedToken = navDecryptExchangeToken(encodedToken, creds.exchangeKey);
  return { token: decodedToken, validFrom: navXmlField(text, 'tokenValidityFrom'), validTo: navXmlField(text, 'tokenValidityTo') };
}

// Belföldi adószám érvényességének ellenőrzése a NAV nyilvántartásában —
// a NAV saját ajánlása (23. pont) is javasolja ezt fizetés/számlázás
// előtt elvégezni, hogy elkerüljük a garantáltan elutasított
// (ABORTED) beküldéseket. Egy VALÓDI, hivatalos NAV mintapélda
// (nav-gov-hu/Online-Invoice GitHub-tárhely) szerkezete alapján készült.
async function navQueryTaxpayer(taxNumberFull, creds = navCredsFromEnv()) {
  const { taxpayerId } = parseHunTaxNumber(taxNumberFull);
  const requestId = navRequestId();
  const now = new Date();
  const timestampMasked = navTimestampMasked(now);
  const timestampIso = navTimestampIso(now);
  const requestSignature = navRequestSignatureSimple(requestId, timestampMasked, creds.signingKey);

  const bodyXml = `<QueryTaxpayerRequest xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common" xmlns="http://schemas.nav.gov.hu/OSA/3.0/api">
${navHeaderXml(requestId, timestampIso)}
${navUserXml(requestSignature, creds)}
${navSoftwareXml()}
<taxNumber>${escapeXml(taxpayerId)}</taxNumber>
</QueryTaxpayerRequest>`;

  const { status, text } = await navApiCall('queryTaxpayer', bodyXml, navBaseUrlFor(creds.sandbox));
  if (status !== 200) {
    const errorMsg = navXmlField(text, 'message') || navXmlField(text, 'errorCode') || `HTTP ${status}`;
    throw new Error(`NAV queryTaxpayer hiba: ${errorMsg}`);
  }
  const validity = navXmlField(text, 'taxpayerValidity');
  return { valid: validity === 'true', taxpayerName: navXmlField(text, 'taxpayerName') };
}

// Ismétlődő, azonos szerkezetű blokkok (pl. egyenként egy-egy számla a
// kivonat-listában) kinyerése — az egyes blokkokon BELÜL a navXmlField()
// segítségével már helyesen, egymáshoz párosítva olvashatók ki a mezők
// (a sima navXmlFieldAll ezt nem tudná, mivel az globálisan, blokkoktól
// függetlenül gyűjtené össze az egyes mezőket).
function navXmlBlocks(xml, tag) {
  const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

// A hitelesített adószámhoz (a mi cégünk, mint eladó VAGY vevő) tartozó
// számlák kivonatának lekérdezése a NAV-tól — a NAV hivatalos, publikus
// mintapéldája (nav-gov-hu/Online-Invoice GitHub-tárhely) alapján.
// direction: 'OUTBOUND' (kimenő, mi állítottuk ki) vagy 'INBOUND' (bejövő,
// mást állította ki, de a mi adószámunkra vonatkozik).
async function navQueryInvoiceDigest({ direction, dateFrom, dateTo, page = 1, creds = navCredsFromEnv() }) {
  const requestId = navRequestId();
  const now = new Date();
  const timestampMasked = navTimestampMasked(now);
  const timestampIso = navTimestampIso(now);
  const requestSignature = navRequestSignatureSimple(requestId, timestampMasked, creds.signingKey);

  const bodyXml = `<QueryInvoiceDigestRequest xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common" xmlns="http://schemas.nav.gov.hu/OSA/3.0/api">
${navHeaderXml(requestId, timestampIso)}
${navUserXml(requestSignature, creds)}
${navSoftwareXml()}
<page>${page}</page>
<invoiceDirection>${direction}</invoiceDirection>
<invoiceQueryParams>
  <mandatoryQueryParams>
    <invoiceIssueDate>
      <dateFrom>${dateFrom}</dateFrom>
      <dateTo>${dateTo}</dateTo>
    </invoiceIssueDate>
  </mandatoryQueryParams>
</invoiceQueryParams>
</QueryInvoiceDigestRequest>`;

  const { status, text } = await navApiCall('queryInvoiceDigest', bodyXml, navBaseUrlFor(creds.sandbox));
  if (status !== 200) {
    const errorMsg = navXmlField(text, 'message') || navXmlField(text, 'errorCode') || `HTTP ${status}`;
    throw new Error(`NAV queryInvoiceDigest hiba: ${errorMsg} | Nyers válasz: ${text.slice(0, 1200)}`);
  }
  const availablePage = navXmlField(text, 'availablePage');
  const invoiceCountAll = navXmlField(text, 'invoiceCountAll');
  const blocks = navXmlBlocks(text, 'invoiceDigest');
  const invoices = blocks.map((b) => ({
    invoiceNumber: navXmlField(b, 'invoiceNumber'),
    invoiceIssueDate: navXmlField(b, 'invoiceIssueDate'),
    supplierName: navXmlField(b, 'supplierName'),
    customerName: navXmlField(b, 'customerName'),
    invoiceNetAmountHUF: navXmlField(b, 'invoiceNetAmountHUF') || navXmlField(b, 'invoiceNetAmount'),
    invoiceVatAmountHUF: navXmlField(b, 'invoiceVatAmountHUF') || navXmlField(b, 'invoiceVatAmount'),
    invoiceOperation: navXmlField(b, 'invoiceOperation'),
    completenessIndicator: navXmlField(b, 'completenessIndicator'),
  }));
  return { invoices, availablePage: availablePage ? parseInt(availablePage, 10) : 1, invoiceCountAll: invoiceCountAll ? parseInt(invoiceCountAll, 10) : invoices.length };
}

// Egy KONKRÉT számla TELJES tartalmának lekérdezése (nem csak a kivonat) —
// ez teszi lehetővé a tételes (termék/szolgáltatás-szintű) elemzést. A NAV
// egy valódi, hivatalos hibajegyben megjelent kérés-példája alapján
// (nav-gov-hu/Online-Invoice issue #1005), a hivatalos XSD-vel
// megerősítve: a lekérdező mező neve "taxNumber", NEM "supplierTaxNumber"
// (ez utóbbi egy elavult, hibás elnevezés volt egy másik forrásban).
async function navQueryInvoiceData({ invoiceNumber, direction, taxNumber, creds }) {
  const requestId = navRequestId();
  const now = new Date();
  const timestampMasked = navTimestampMasked(now);
  const timestampIso = navTimestampIso(now);
  const requestSignature = navRequestSignatureSimple(requestId, timestampMasked, creds.signingKey);

  // FONTOS: a "taxNumber" mező OPCIONÁLIS a hivatalos XSD szerint
  // (minOccurs="0") — élesben "Helytelen kérés!" (séma-hiba) jelentkezett
  // vele, ezért itt SZÁNDÉKOSAN kihagyjuk. A technikai felhasználó saját
  // adószáma (a hitelesítésből) önmagában is elég a NAV-nak ahhoz, hogy
  // beazonosítsa, kinek a számláit keressük.
  const bodyXml = `<QueryInvoiceDataRequest xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common" xmlns="http://schemas.nav.gov.hu/OSA/3.0/api">
${navHeaderXml(requestId, timestampIso)}
${navUserXml(requestSignature, creds)}
${navSoftwareXml()}
<invoiceNumberQuery>
  <invoiceNumber>${escapeXml(invoiceNumber)}</invoiceNumber>
  <invoiceDirection>${direction}</invoiceDirection>
</invoiceNumberQuery>
</QueryInvoiceDataRequest>`;

  const { status, text } = await navApiCall('queryInvoiceData', bodyXml, navBaseUrlFor(creds.sandbox));
  if (status !== 200) {
    const errorMsg = navXmlField(text, 'message') || navXmlField(text, 'errorCode') || `HTTP ${status}`;
    throw new Error(`NAV queryInvoiceData hiba: ${errorMsg} | Nyers válasz: ${text.slice(0, 1000)}`);
  }
  const base64Content = navXmlField(text, 'invoiceData');
  if (!base64Content) throw new Error(`A NAV válaszában nem található számla-tartalom. Nyers válasz: ${text.slice(0, 500)}`);
  const compressed = navXmlField(text, 'compressedContentIndicator') === 'true';
  let xmlBuffer = Buffer.from(base64Content, 'base64');
  if (compressed) xmlBuffer = zlib.gunzipSync(xmlBuffer);
  return xmlBuffer.toString('utf8');
}

// A teljes számla-XML-ből a tételsorok (termékek/szolgáltatások)
// kinyerése — ugyanazt a struktúrát követve, amit a saját
// buildNavInvoiceDataXml()-ünk is generál (lineDescription, quantity,
// unitPrice, lineNetAmount, stb.), mivel ez a NAV hivatalos sémája.
function extractInvoiceLines(invoiceXml) {
  const lineBlocks = navXmlBlocks(invoiceXml, 'line');
  return lineBlocks.map((b) => ({
    description: navXmlField(b, 'lineDescription') || '(nincs megnevezés)',
    quantity: parseFloat(navXmlField(b, 'quantity') || '1') || 1,
    unitOfMeasure: navXmlField(b, 'unitOfMeasure') || '',
    netAmount: parseFloat(navXmlField(b, 'lineNetAmountHUF') || navXmlField(b, 'lineNetAmount') || '0') || 0,
    vatAmount: parseFloat(navXmlField(b, 'lineVatAmountHUF') || navXmlField(b, 'lineVatAmount') || '0') || 0,
    grossAmount: parseFloat(navXmlField(b, 'lineGrossAmountNormalHUF') || navXmlField(b, 'lineGrossAmountNormal') || '0') || 0,
  })).filter((l) => l.description !== '(nincs megnevezés)' || l.netAmount > 0);
}

// Egyetlen számla-XML beküldése a NAV-nak (manageInvoice, CREATE operáció).
// Visszaadja a NAV tranzakció-azonosítóját, amivel a feldolgozás állapota
// később lekérdezhető (a NAV 2-30 másodperc alatt dolgozza fel).
// Egyetlen számla-XML beküldése a NAV-nak (manageInvoice, CREATE operáció).
// FONTOS: a belső <invoiceOperation>CREATE</invoiceOperation> mezőnév a
// NAV saját sémavalidátorának hibaüzenetével közvetlenül megerősítve —
// igen, ez ugyanaz a név, mint a körülötte lévő szülő elemé, ami
// szokatlan, de a v3.0 séma pontosan ezt várja (a korábbi v2.0
// dokumentáció "operation"/"invoice" neveket használt, de ezek a v3.0-ban
// már NEM érvényesek).
async function navSubmitInvoice(invoiceDataXml, creds = navCredsFromEnv()) {
  const { token } = await navTokenExchange(creds);
  const requestId = navRequestId();
  const now = new Date();
  const timestampMasked = navTimestampMasked(now);
  const timestampIso = navTimestampIso(now);
  const base64Content = Buffer.from(invoiceDataXml, 'utf8').toString('base64');
  // JAVÍTVA (2026-07-24): korábban process.env.NAV_SIGNING_KEY-t használt
  // fixen — most a creds paraméterből jön, hogy cégenkénti (nem csak a
  // platform saját) NAV-kapcsolattal is működjön (lásd Nagyker-számlázás).
  const { signature: requestSignature, debug: sigDebug } = navRequestSignatureManageInvoice(requestId, timestampMasked, creds.signingKey, [
    { operation: 'CREATE', base64Content },
  ]);

  const bodyXml = `<ManageInvoiceRequest xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common" xmlns="http://schemas.nav.gov.hu/OSA/3.0/api">
${navHeaderXml(requestId, timestampIso)}
${navUserXml(requestSignature, creds)}
${navSoftwareXml()}
<exchangeToken>${escapeXml(token)}</exchangeToken>
<invoiceOperations>
  <compressedContent>false</compressedContent>
  <invoiceOperation>
    <index>1</index>
    <invoiceOperation>CREATE</invoiceOperation>
    <invoiceData>${base64Content}</invoiceData>
  </invoiceOperation>
</invoiceOperations>
</ManageInvoiceRequest>`;

  const { status, text } = await navApiCall('manageInvoice', bodyXml, navBaseUrlFor(creds.sandbox));
  if (status !== 200) {
    const errorMsg = navXmlField(text, 'message') || navXmlField(text, 'errorCode') || `HTTP ${status}`;
    const err = new Error(`NAV manageInvoice hiba: ${errorMsg} | requestId: ${requestId} | timestampMasked: ${timestampMasked} | partialAuthRaw: ${sigDebug.partialAuthRaw} | indexHash: ${sigDebug.indexHashes[0]} | requestSignature: ${requestSignature} | Nyers válasz: ${text.slice(0, 1200)}`);
    err.navRawResponse = text;
    throw err;
  }
  const transactionId = navXmlField(text, 'transactionId');
  if (!transactionId) {
    const err = new Error(`A NAV válaszában nem található tranzakció-azonosító. Nyers válasz: ${text.slice(0, 500)}`);
    err.navRawResponse = text;
    throw err;
  }
  return { transactionId, raw: text };
}

// A feldolgozás állapotának lekérdezése — a NAV aszinkron dolgozza fel a
// beküldött számlákat, ezért a tranzakció-azonosítóval később kell
// rákérdezni az eredményre (elfogadva / figyelmeztetéssel / elutasítva).
async function navQueryTransactionStatus(transactionId, creds = navCredsFromEnv()) {
  const requestId = navRequestId();
  const now = new Date();
  const timestampMasked = navTimestampMasked(now);
  const timestampIso = navTimestampIso(now);
  // JAVÍTVA (2026-07-24): creds.signingKey a fix env-változó helyett.
  const requestSignature = navRequestSignatureSimple(requestId, timestampMasked, creds.signingKey);

  // FONTOS: a QueryTransactionStatusRequestType XSD-je szerint (NAV saját
  // sémavalidátorának hibaüzenetével is megerősítve) ennek a kérésnek NINCS
  // exchangeToken mezője — csak transactionId és returnOriginalRequest —,
  // ezért itt (a manageInvoice-tól eltérően) nincs is szükség előzetes
  // tokenExchange hívásra.
  const bodyXml = `<QueryTransactionStatusRequest xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common" xmlns="http://schemas.nav.gov.hu/OSA/3.0/api">
${navHeaderXml(requestId, timestampIso)}
${navUserXml(requestSignature, creds)}
${navSoftwareXml()}
<transactionId>${escapeXml(transactionId)}</transactionId>
<returnOriginalRequest>false</returnOriginalRequest>
</QueryTransactionStatusRequest>`;

  const { status, text } = await navApiCall('queryTransactionStatus', bodyXml, navBaseUrlFor(creds.sandbox));
  if (status !== 200) {
    const errorMsg = navXmlField(text, 'message') || navXmlField(text, 'errorCode') || `HTTP ${status}`;
    throw new Error(`NAV queryTransactionStatus hiba: ${errorMsg} | Nyers válasz: ${text.slice(0, 1500)}`);
  }
  return {
    processingResult: navXmlField(text, 'invoiceStatus'),
    businessValidationMessages: navXmlFieldAll(text, 'message'),
    raw: text,
  };
}

// Egy meglévő, eltárolt demo-számla NAV felé történő beküldése — a teljes
// L-NYUGTA-oldali adatból felépíti a NAV-kompatibilis XML-t, beküldi, és
// visszaadja a tranzakció-azonosítót (ezt hívjuk a fizetés jóváírásakor,
// ha a NAV-kapcsolat be van állítva).
async function navSubmitDemoInvoice({ szamlaSorszam, datum, cegNev, adoszam, cimReszletek, tetelek, penznem }) {
  const invoiceDataXml = buildNavInvoiceDataXml({
    invoiceNumber: szamlaSorszam,
    invoiceIssueDate: datum,
    buyerName: cegNev,
    buyerTaxNumber: adoszam,
    buyerAddress: cimReszletek || {},
    tetelek,
    penznem,
  });
  return navSubmitInvoice(invoiceDataXml);
}

// A myPOS aláírás-algoritmusa (a hivatalos dokumentáció szerint):
// 1) az összes POST mező ÉRTÉKÉT (a Signature mezőt kivéve), a küldés
//    sorrendjében, kötőjellel ("-") összefűzzük,
// 2) az eredményt Base64-kódoljuk,
// 3) a Base64-kódolt sztringet SHA-256 + RSA algoritmussal aláírjuk a
//    privát kulccsal,
// 4) az aláírást is Base64-kódoljuk — ez kerül a "Signature" mezőbe.
function myposSign(orderedFields, privateKeyPem) {
  const concatenated = orderedFields.map(([, v]) => String(v)).join('-');
  const base64Input = Buffer.from(concatenated, 'utf8').toString('base64');
  const signature = crypto.sign('RSA-SHA256', Buffer.from(base64Input, 'utf8'), privateKeyPem);
  return signature.toString('base64');
}
// Beérkező (myPOS-tól kapott) adat aláírásának ellenőrzése — ugyanaz a
// módszer, csak a myPOS NYILVÁNOS tanúsítványával ellenőrizve, nem a mi
// privát kulcsunkkal aláírva.
function myposVerify(orderedFields, signatureBase64, publicCertPem) {
  const concatenated = orderedFields.map(([, v]) => String(v)).join('-');
  const base64Input = Buffer.from(concatenated, 'utf8').toString('base64');
  try {
    return crypto.verify('RSA-SHA256', Buffer.from(base64Input, 'utf8'), publicCertPem, Buffer.from(signatureBase64, 'base64'));
  } catch (e) {
    return false;
  }
}

// A próbaidő kezdete: az adott cég legkorábban létrehozott telephelye —
// gyakorlatilag az első regisztráció/szinkron időpontja. Nincs hozzá külön
// tábla/mező, a telephelyek.json már meglévő "letrehozva" mezőjét
// használjuk fel erre.
function companyFirstSeen(cegKulcs) {
  const sites = listTelephelyek(cegKulcs);
  if (!sites.length) return null;
  return sites.reduce((min, t) => (!min || t.letrehozva < min ? t.letrehozva : min), null);
}
function companyTrialEnd(cegKulcs) {
  // Ha az admin KÉZZEL beállított próbaidőt ennél a cégnél (akár 0 napra,
  // vagyis "nincs próbaidő"), az FELÜLÍRJA az automatikus számítást —
  // ez a magasabb prioritású forrás. Ha soha nem nyúlt hozzá, marad a
  // régi, automatikus (első szinkrontól számított) viselkedés.
  const sub = licenseDb.prepare('SELECT proba_vege, proba_kezi FROM company_subscription WHERE ceg_kulcs = ?').get(cegKulcs);
  if (sub && sub.proba_kezi) {
    return sub.proba_vege ? new Date(sub.proba_vege + 'T23:59:59') : null;
  }
  const firstSeen = companyFirstSeen(cegKulcs);
  if (!firstSeen) return null;
  return new Date(new Date(firstSeen).getTime() + LICENSE_TRIAL_DAYS * 86400000);
}

// Eszköz-regisztráció ellenőrzése/nyilvántartása egy licenc-lekérdezéskor.
// Ha az adott eszköz ennél a cégnél már ismert, csak frissítjük az
// "utoljára látott" időbélyeget és true-val térünk vissza. Ha ismeretlen
// eszköz, és van még szabad hely a cég eszközkorlátján belül (vagy a
// cégre egyáltalán nincs korlát beállítva — ez az alapállapot), akkor
// magától regisztrálódik, nincs hozzá admin-beavatkozás. Ha a korlát már
// betelt, false-t ad vissza — a hívó ekkor mindent letilt a válaszban.
// Egy szinkron-feltöltéskor érkező eszköz-adatok (UUID, melyik
// telephelyről, milyen programtípus/verzió) rögzítése — TELJESEN
// OPCIONÁLIS: ha egy régebbi androidos verzió ezt nem küldi, egyszerűen
// nem hívjuk meg, semmi nem változik a viselkedésben. Ha új programtípus
// érkezik, amit még nem ismerünk, automatikusan felvesszük a
// katalógusba — nem kell előre regisztrálni.
function recordDeviceSync(cegKulcs, eszkozAzonosito, telephelyKod, progtip, verzio) {
  if (!eszkozAzonosito) return;
  const now = new Date().toISOString();
  const existing = licenseDb.prepare(
    'SELECT id FROM company_devices WHERE ceg_kulcs = ? AND eszkoz_azonosito = ?'
  ).get(cegKulcs, eszkozAzonosito);
  if (existing) {
    licenseDb.prepare(
      'UPDATE company_devices SET utolso_latott = ?, telephely_kod = COALESCE(?, telephely_kod), progtip = COALESCE(?, progtip), verzio = COALESCE(?, verzio) WHERE id = ?'
    ).run(now, telephelyKod || null, progtip || null, verzio || null, existing.id);
  } else {
    licenseDb.prepare(
      'INSERT INTO company_devices (ceg_kulcs, eszkoz_azonosito, telephely_kod, progtip, verzio, elso_latott, utolso_latott) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(cegKulcs, eszkozAzonosito, telephelyKod || null, progtip || null, verzio || null, now, now);
  }
  if (progtip) {
    const known = licenseDb.prepare('SELECT 1 FROM program_tipusok WHERE kulcs = ?').get(progtip);
    if (!known) {
      licenseDb.prepare('INSERT INTO program_tipusok (kulcs, nev, elso_latott) VALUES (?, ?, ?)').run(progtip, progtip, now);
    }
  }
}

function registerOrCheckDevice(cegKulcs, eszkozAzonosito) {
  const now = new Date().toISOString();
  const existing = licenseDb.prepare(
    'SELECT id FROM company_devices WHERE ceg_kulcs = ? AND eszkoz_azonosito = ?'
  ).get(cegKulcs, eszkozAzonosito);
  if (existing) {
    licenseDb.prepare('UPDATE company_devices SET utolso_latott = ? WHERE id = ?').run(now, existing.id);
    return true;
  }
  const limitRow = licenseDb.prepare('SELECT eszkoz_limit FROM company_device_limits WHERE ceg_kulcs = ?').get(cegKulcs);
  if (limitRow) {
    const used = licenseDb.prepare('SELECT COUNT(*) AS c FROM company_devices WHERE ceg_kulcs = ?').get(cegKulcs).c;
    if (used >= limitRow.eszkoz_limit) return false;
  }
  licenseDb.prepare(
    'INSERT INTO company_devices (ceg_kulcs, eszkoz_azonosito, elso_latott, utolso_latott) VALUES (?, ?, ?, ?)'
  ).run(cegKulcs, eszkozAzonosito, now, now);
  return true;
}

// Licenc-állapot lekérdezése az androidos app számára — ugyanúgy
// x-api-key-jel hitelesít, mint a többi szinkron végpont (NEM böngésző-
// session). Ez váltja ki a korábbi lszamla-alapú licenc-lekérdezést: az
// app mostantól a saját szerverünktől kérdezi le, melyik funkciókhoz fér
// hozzá az adott cég, és meddig érvényesen.
// A ténylegesen érvényes (effektív) funkció-lista kiszámítása egy cégre —
// EZ a közös, egyetlen forrás, amit MIND az androidos /api/license/status,
// MIND az admin felület "tényleges állapot" lekérdezése használ, hogy a
// kettő SOHA ne térhessen el egymástól.
// Igaz, ha ennek a cégnek VALÓBAN van már adata a szerveren (tehát
// legalább egyszer ténylegesen feltöltött egy adatbázist) — ez különbözik
// attól, hogy csak LÉTEZIK-e egy adószám, amit valaki lekérdezett.
function companyHasAnyData(cegKulcs) {
  for (const entry of companyIndex.values()) {
    if (entry.cegKulcs === cegKulcs) return true;
  }
  return false;
}

// A cég kiosztott funkcióit adja vissza, a helyes ELSŐBBSÉGGEL: ha egy
// adott telephelyre KÜLÖN van beállítva egy funkció, az felülírja a régi,
// cégszintű (telephely_kod = NULL) beállítást — de ha a telephelyre nincs
// külön sor, a cégszintű még mindig érvényes (visszamenőleges kompatibilitás
// a telephely-specifikus kiosztás bevezetése előtti adatokkal).
function getCompanyLicenseGrants(cegKulcs, telephelyKod) {
  const rows = telephelyKod
    ? licenseDb.prepare(`SELECT * FROM company_licenses WHERE ceg_kulcs = ? AND (telephely_kod = ? OR telephely_kod = '')`).all(cegKulcs, telephelyKod)
    : licenseDb.prepare(`SELECT * FROM company_licenses WHERE ceg_kulcs = ? AND telephely_kod = ''`).all(cegKulcs);
  const grants = new Map();
  for (const r of rows.filter((r) => r.telephely_kod === '')) grants.set(r.feature_key, r);
  for (const r of rows.filter((r) => r.telephely_kod !== '')) grants.set(r.feature_key, r); // telephely-specifikus felülír
  return grants;
}

function computeEffectiveLicense(cegKulcs, eszkoz, telephelyKod) {
  // Ha ennek a cégnek MÉG SOHA nem érkezett feltöltése (csak lekérdezték
  // a regisztrációját/licenc-állapotát), sem az alap-előfizetést, sem az
  // eszköz-regisztrációt nem szabad "aktívnak" mutatni — korábban ez a
  // két mező hibásan `true`-ra állt egy ilyen, valójában nem is létező
  // cégnél, és egy puszta lekérdezés (mellékhatásként) automatikusan
  // regisztrálta volna is az eszközt, ami szintén nem helyes egy csak-
  // olvasó művelet során.
  if (!companyHasAnyData(cegKulcs)) {
    return { alapElofizetesAktiv: false, funkciok: [], eszkozRegisztralva: eszkoz ? false : null, inTrial: false };
  }
  const eszkozRegisztralva = eszkoz ? registerOrCheckDevice(cegKulcs, eszkoz) : null;
  const alapElofizetesAktiv = isBaseSubscriptionActive(cegKulcs);
  const catalog = licenseDb.prepare('SELECT key, aktiv FROM license_features WHERE aktiv = 1 ORDER BY sorrend, nev').all();
  const trialEnd = isLicenseEnforceOn() ? companyTrialEnd(cegKulcs) : null;
  const inTrial = isLicenseEnforceOn() ? !!(trialEnd && Date.now() < trialEnd.getTime()) : true;

  let funkciok = [];
  if (!alapElofizetesAktiv) {
    funkciok = [];
  } else if (eszkozRegisztralva === false) {
    funkciok = [];
  } else if (inTrial) {
    funkciok = catalog.map((f) => f.key);
  } else {
    const grants = getCompanyLicenseGrants(cegKulcs, telephelyKod);
    funkciok = catalog.filter((f) => {
      const row = grants.get(f.key);
      const status = licenseRowStatus(row);
      return !!row && !!row.aktiv && status.allapot !== 'expired';
    }).map((f) => f.key);
  }
  return { alapElofizetesAktiv, funkciok, eszkozRegisztralva, inTrial };
}

route('GET', '/api/license/status', async (req, res, query) => {
  const apiKey = req.headers['x-api-key'];
  if (!verifySyncApiKey(apiKey)) return sendJson(res, 401, { error: 'Érvénytelen vagy hiányzó x-api-key.' });
  const cegKulcs = companyKeyFromAdoszam(query.adoszam || '');
  if (cegKulcs.length < 8) return sendJson(res, 400, { error: 'Érvénytelen adószám.' });

  // Eszközazonosító — opcionális, hogy a régebbi app-verziók (amik még
  // nem küldik) ne törjenek el. Ha nincs megadva, a régi, eszközfüggetlen
  // viselkedés marad (nincs korlát-ellenőrzés, nincs eszkozRegisztralva
  // mező a válaszban). A telephelyKod is opcionális, ugyanezen okból —
  // amíg az androidos oldal nem küldi, a cégszintű (visszamenőleges)
  // kiosztás érvényesül.
  const eszkoz = String(query.eszkoz || '').trim();
  const telephelyKod = query.telephelyKod ? String(query.telephelyKod).trim() : null;
  const effective = computeEffectiveLicense(cegKulcs, eszkoz, telephelyKod);
  const payload = { adoszam: query.adoszam || '', alapElofizetesAktiv: effective.alapElofizetesAktiv, funkciok: effective.funkciok };
  if (eszkoz) payload.eszkozRegisztralva = effective.eszkozRegisztralva;
  sendJson(res, 200, payload);
});

// Admin-oldali lekérdezés: mit látna PONTOSAN az androidos app, ha MOST
// kérdezné le a licenc-állapotot ehhez a céghez? Eddig az admin felület
// csak a kiosztott (grant) rekordokat mutatta — ez viszont eltérhet a
// TÉNYLEGES állapottól (pl. próbaidőszakban minden funkció engedélyezett,
// kiosztástól függetlenül). Ez a végpont pontosan ugyanazt a logikát
// futtatja le, mint az androidos végpont — csak admin-hitelesítéssel, nem
// a szinkron API-kulccsal.
route('GET', '/api/admin/license/effective', async (req, res, query) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const cegKulcs = String(query.cegKulcs || '').trim();
  if (!cegKulcs) return sendJson(res, 400, { error: 'Hiányzó cégkulcs.' });
  const telephelyKod = query.telephelyKod ? String(query.telephelyKod).trim() : null;
  const effective = computeEffectiveLicense(cegKulcs, null, telephelyKod);
  sendJson(res, 200, {
    cegKulcs,
    alapElofizetesAktiv: effective.alapElofizetesAktiv,
    inTrial: effective.inTrial,
    funkciok: effective.funkciok,
  });
});

// A licenc-kikényszerítés webről kapcsolható be/ki — amíg ki van kapcsolva
// (alapállapot), mindenki mindent lát, az admin által kiosztott funkcióktól
// függetlenül. Bekapcsolás után a valóban kiosztott funkciók számítanak
// (a próbaidőszak lejárta után).
route('GET', '/api/admin/settings/license-enforce', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  sendJson(res, 200, { enforce: isLicenseEnforceOn() });
});

route('POST', '/api/admin/settings/license-enforce', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { enforce } = await readJsonBody(req);
  const value = enforce ? '1' : '0';
  licenseDb.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES ('license_enforce', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(value, new Date().toISOString());
  logActivity({
    type: 'license_enforce_toggle', ok: true, companyKey: null, nev: 'admin',
    detail: enforce ? 'Licenc-kikényszerítés BEKAPCSOLVA — mostantól a tényleges kiosztás számít.' : 'Licenc-kikényszerítés KIKAPCSOLVA — mindenki mindent lát.',
  });
  sendJson(res, 200, { ok: true, enforce: !!enforce });
});

// ---------------------------------------------------------------------------
// ADMIN — külön bejelentkezés (nem cégenkénti adószámos belépés), amivel
// az összes cég szinkron-naplója, NTAK állapota belátható, és bármelyik
// cég dashboardja megnyitható. Az admin jelszó a data/.secrets.json-ban
// (vagy ADMIN_PASSWORD env változóban) van.
// ---------------------------------------------------------------------------

route('POST', '/api/admin/login', async (req, res) => {
  const ip = getClientIp(req);
  const { password } = await readJsonBody(req);
  const rl = checkLoginRateLimit(ip, 'admin');
  if (!rl.allowed) return sendRateLimited(res, rl.retryAfterSeconds);
  if (!password || !timingSafeStringEqual(password, SECRETS.adminPassword)) {
    recordLoginAttempt(ip, 'admin', false);
    logActivity({ type: 'admin_login', ok: false, companyKey: null, nev: null, detail: 'Hibás admin jelszó.', ip });
    return sendJson(res, 401, { error: 'Hibás admin jelszó.' });
  }
  recordLoginAttempt(ip, 'admin', true);
  const payload = { isAdmin: true, exp: Date.now() + SESSION_MAX_AGE_MS };
  const token = signSession(payload);
  const cookie = `enyadmin=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax${COOKIE_SECURE ? '; Secure' : ''}`;
  logActivity({ type: 'admin_login', ok: true, companyKey: null, nev: null, detail: 'Sikeres admin bejelentkezés.', ip });
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie });
});

route('POST', '/api/admin/logout', async (req, res) => {
  const admin = requireAdmin(req);
  if (admin) logActivity({ type: 'admin_logout', ok: true, companyKey: null, nev: null, detail: 'Admin kijelentkezett.' });
  const cookies = parseCookies(req.headers.cookie);
  revokeSession(cookies.enyadmin);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': `enyadmin=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${COOKIE_SECURE ? '; Secure' : ''}` });
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
  const resellerRows = usersDb.prepare(`SELECT id, nev, email FROM users WHERE role = 'reseller' ORDER BY nev`).all();
  const resellerNevByld = new Map(resellerRows.map((r) => [r.id, r.nev]));
  const companies = [...companyIndex.entries()]
    .map(([key, entry]) => {
      const cegKulcs = entry.cegKulcs;
      let fallbackEmail = '';
      if (!codes[cegKulcs]?.email) {
        try { fallbackEmail = get(key, 'SELECT email FROM szallitot LIMIT 1')?.email || ''; } catch (_) {}
      }
      const telephelyInfo = listTelephelyek(cegKulcs).find((t) => t.kod === entry.telephelyKod);
      const resellerId = codes[cegKulcs]?.resellerId || null;
      return {
        key, cegKulcs, telephelyKod: entry.telephelyKod, telephelyNev: telephelyInfo?.nev || entry.telephelyKod,
        nev: entry.nev, adoszam: entry.adoszam, varos: entry.varos,
        code: codes[cegKulcs]?.code, email: codes[cegKulcs]?.email || fallbackEmail,
        resellerId, resellerNev: resellerId ? (resellerNevByld.get(resellerId) || null) : null,
        ...(meta[key] || { lastSync: null, source: null, bytes: null }),
      };
    })
    .sort((a, b) => (b.lastSync || '').localeCompare(a.lastSync || ''));
  const ntak = computeNtakOverview();

  // --- Bővebb, informatívabb statisztikák az Áttekintés oldalhoz ---
  const now = Date.now();
  const DAY_MS = 86400000;
  const syncedLast24h = companies.filter((c) => c.lastSync && now - new Date(c.lastSync).getTime() < DAY_MS).length;
  const syncedLast7d = companies.filter((c) => c.lastSync && now - new Date(c.lastSync).getTime() < 7 * DAY_MS).length;
  const neverSynced = companies.filter((c) => !c.lastSync).length;

  const userCounts = usersDb.prepare(`
    SELECT role, status, COUNT(*) AS c FROM users GROUP BY role, status
  `).all();
  const usersByRole = { owner: 0, manager: 0, reseller: 0 };
  const usersByStatus = { active: 0, pending: 0, disabled: 0 };
  let totalUsers = 0;
  userCounts.forEach((r) => {
    usersByRole[r.role] = (usersByRole[r.role] || 0) + r.c;
    usersByStatus[r.status] = (usersByStatus[r.status] || 0) + r.c;
    totalUsers += r.c;
  });

  const uniqueCegKulcs = [...new Set(companies.map((c) => c.cegKulcs))];
  const subRows = licenseDb.prepare('SELECT ceg_kulcs, aktiv FROM company_subscription').all();
  const subByCeg = new Map(subRows.map((r) => [r.ceg_kulcs, r.aktiv]));
  const pausedSubscriptions = uniqueCegKulcs.filter((ck) => subByCeg.has(ck) && !subByCeg.get(ck)).length;
  const activeSubscriptions = uniqueCegKulcs.length - pausedSubscriptions;

  const monthStart = todayIsoServer().slice(0, 7) + '-01';
  const paymentRow = licenseDb.prepare(
    `SELECT COUNT(*) AS cnt, IFNULL(SUM(osszeg),0) AS total FROM license_payments WHERE allapot = 'SIKERES' AND letrehozva >= ?`
  ).get(monthStart);

  const recentActivity = readActivityLog(500);
  const failedSyncCount = recentActivity.filter((e) => e.type === 'sync_upload' && !e.ok).length;

  const stats = {
    totalCompanies: uniqueCegKulcs.length,
    totalSites: companies.length,
    syncedLast24h, syncedLast7d, neverSynced,
    totalUsers, usersByRole, usersByStatus,
    activeSubscriptions, pausedSubscriptions,
    paymentsThisMonthCount: paymentRow.cnt, paymentsThisMonthTotal: paymentRow.total,
    failedSyncCount,
    ntakProblems: ntak.reduce((s, n) => s + n.warn + n.error, 0),
  };

  sendJson(res, 200, { companies, ntak, resellers: resellerRows, emailReady: !!(BREVO_API_KEY && BREVO_SENDER_EMAIL), stats });
});

// ---------------------------------------------------------------------------
// CÉG TELJES TÖRLÉSE — visszafordíthatatlan, ezért mindig előbb egy
// cégenkénti biztonsági mentést készítünk (a data/companies/ mappájáról +
// az összes kapcsolódó adatbázis-sor JSON-dumpjáról), és csak utána
// töröljük ténylegesen. A mentés a ~/lnyugta_backups/ mappába kerül,
// UGYANOTT, ahol a napi automatikus mentések is vannak — de KÜLÖN néven,
// hogy egy adott cég visszaállítása ne igényelje a teljes rendszer
// visszaállítását.
// ---------------------------------------------------------------------------
function backupCompanyBeforeDelete(cegKulcs) {
  const backupRoot = process.env.LNYUGTA_BACKUP_DIR
    ? path.resolve(process.env.LNYUGTA_BACKUP_DIR)
    : path.join(os.homedir(), 'lnyugta_backups');
  if (!fs.existsSync(backupRoot)) fs.mkdirSync(backupRoot, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(backupRoot, `torolt_ceg_${cegKulcs}_${ts}`);
  fs.mkdirSync(backupDir, { recursive: true });

  const companyDataDir = path.join(DATA_DIR, 'companies', cegKulcs);
  if (fs.existsSync(companyDataDir)) {
    fs.cpSync(companyDataDir, path.join(backupDir, 'companies_db'), { recursive: true });
  }
  const uploadsDir = path.join(UPLOADS_DIR, cegKulcs.replace(/[^a-zA-Z0-9_-]/g, '_'));
  if (fs.existsSync(uploadsDir)) {
    fs.cpSync(uploadsDir, path.join(backupDir, 'uploads'), { recursive: true });
  }

  const dump = {
    cegKulcs,
    torolve: new Date().toISOString(),
    users: usersDb.prepare(`SELECT * FROM users WHERE ceg_kulcs = ?`).all(cegKulcs),
    company_licenses: licenseDb.prepare(`SELECT * FROM company_licenses WHERE ceg_kulcs = ?`).all(cegKulcs),
    company_device_limits: licenseDb.prepare(`SELECT * FROM company_device_limits WHERE ceg_kulcs = ?`).all(cegKulcs),
    company_devices: licenseDb.prepare(`SELECT * FROM company_devices WHERE ceg_kulcs = ?`).all(cegKulcs),
    company_subscription: licenseDb.prepare(`SELECT * FROM company_subscription WHERE ceg_kulcs = ?`).all(cegKulcs),
    company_settings: licenseDb.prepare(`SELECT * FROM company_settings WHERE ceg_kulcs = ?`).all(cegKulcs),
    license_payments: licenseDb.prepare(`SELECT * FROM license_payments WHERE ceg_kulcs = ?`).all(cegKulcs),
    product_changes: productChangesDb.prepare(`SELECT * FROM product_changes WHERE company_key = ? OR company_key LIKE ?`).all(cegKulcs, `${cegKulcs}:%`),
    bevetelezesek: stockDb.prepare(`SELECT * FROM bevetelezesek WHERE company_key = ? OR company_key LIKE ?`).all(cegKulcs, `${cegKulcs}:%`),
    keszlet_riasztas: stockDb.prepare(`SELECT * FROM keszlet_riasztas WHERE company_key = ? OR company_key LIKE ?`).all(cegKulcs, `${cegKulcs}:%`),
    termek_kepek: stockDb.prepare(`SELECT * FROM termek_kepek WHERE company_key = ? OR company_key LIKE ?`).all(cegKulcs, `${cegKulcs}:%`),
    access_code: readAccessCodes()[cegKulcs] || null,
    telephelyek: readTelephelyek()[cegKulcs] || null,
  };
  try {
    const regRow = licenseDb.prepare(`SELECT * FROM reg_companies WHERE adoszam LIKE ?`).get(`${cegKulcs}%`);
    if (regRow) {
      dump.reg_companies = regRow;
      dump.reg_sites = licenseDb.prepare(`SELECT * FROM reg_sites WHERE company_id = ?`).all(regRow.id);
      dump.reg_devices = dump.reg_sites.flatMap((s) => licenseDb.prepare(`SELECT * FROM reg_devices WHERE site_id = ?`).all(s.id));
    }
  } catch (_) {}
  fs.writeFileSync(path.join(backupDir, 'adatbazis-sorok.json'), JSON.stringify(dump, null, 2));
  return backupDir;
}

function deleteCompanyCompletely(cegKulcs) {
  // Minden nyitva lévő adatbázis-kapcsolatot be kell zárni ehhez a
  // céghez, mielőtt a fájlokat töröljük — Windows/Linux alatt egyaránt
  // hibát adna a törlés, ha a fájl még nyitva van.
  for (const key of [...dbCache.keys()]) {
    if (key === cegKulcs || key.startsWith(`${cegKulcs}:`)) evictConnection(key);
  }

  const companyDataDir = path.join(DATA_DIR, 'companies', cegKulcs);
  if (fs.existsSync(companyDataDir)) fs.rmSync(companyDataDir, { recursive: true, force: true });
  const uploadsDir = path.join(UPLOADS_DIR, cegKulcs.replace(/[^a-zA-Z0-9_-]/g, '_'));
  if (fs.existsSync(uploadsDir)) fs.rmSync(uploadsDir, { recursive: true, force: true });

  usersDb.prepare(`DELETE FROM users WHERE ceg_kulcs = ?`).run(cegKulcs);
  licenseDb.prepare(`DELETE FROM company_licenses WHERE ceg_kulcs = ?`).run(cegKulcs);
  licenseDb.prepare(`DELETE FROM company_device_limits WHERE ceg_kulcs = ?`).run(cegKulcs);
  licenseDb.prepare(`DELETE FROM company_devices WHERE ceg_kulcs = ?`).run(cegKulcs);
  licenseDb.prepare(`DELETE FROM company_subscription WHERE ceg_kulcs = ?`).run(cegKulcs);
  licenseDb.prepare(`DELETE FROM company_settings WHERE ceg_kulcs = ?`).run(cegKulcs);
  licenseDb.prepare(`DELETE FROM license_payments WHERE ceg_kulcs = ?`).run(cegKulcs);
  productChangesDb.prepare(`DELETE FROM product_changes WHERE company_key = ? OR company_key LIKE ?`).run(cegKulcs, `${cegKulcs}:%`);
  stockDb.prepare(`DELETE FROM bevetelezesek WHERE company_key = ? OR company_key LIKE ?`).run(cegKulcs, `${cegKulcs}:%`);
  stockDb.prepare(`DELETE FROM keszlet_riasztas WHERE company_key = ? OR company_key LIKE ?`).run(cegKulcs, `${cegKulcs}:%`);
  stockDb.prepare(`DELETE FROM termek_kepek WHERE company_key = ? OR company_key LIKE ?`).run(cegKulcs, `${cegKulcs}:%`);
  try {
    const regRow = licenseDb.prepare(`SELECT id FROM reg_companies WHERE adoszam LIKE ?`).get(`${cegKulcs}%`);
    if (regRow) {
      const siteIds = licenseDb.prepare(`SELECT id FROM reg_sites WHERE company_id = ?`).all(regRow.id).map((s) => s.id);
      for (const sid of siteIds) licenseDb.prepare(`DELETE FROM reg_devices WHERE site_id = ?`).run(sid);
      licenseDb.prepare(`DELETE FROM reg_sites WHERE company_id = ?`).run(regRow.id);
      licenseDb.prepare(`DELETE FROM reg_companies WHERE id = ?`).run(regRow.id);
    }
  } catch (_) {}

  const codes = readAccessCodes();
  if (codes[cegKulcs]) { delete codes[cegKulcs]; writeAccessCodes(codes); }
  const telephelyek = readTelephelyek();
  if (telephelyek[cegKulcs]) { delete telephelyek[cegKulcs]; writeTelephelyek(telephelyek); }
  const meta = readSyncMeta();
  for (const key of Object.keys(meta)) { if (key === cegKulcs || key.startsWith(`${cegKulcs}:`)) delete meta[key]; }
  writeSyncMeta(meta);

  for (const key of [...companyIndex.keys()]) {
    if (key === cegKulcs || key.startsWith(`${cegKulcs}:`)) companyIndex.delete(key);
  }
}

route('POST', '/api/admin/company/delete', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { cegKulcs, megerositoNev } = await readJsonBody(req);
  const cleanKulcs = String(cegKulcs || '').trim();
  if (!cleanKulcs) return sendJson(res, 400, { error: 'Hiányzó cégkulcs.' });

  const anySite = [...companyIndex.values()].find((e) => e.cegKulcs === cleanKulcs);
  const cegNev = anySite?.nev || null;
  // Kötelező, egyértelmű megerősítés — a pontos cégnevet kell begépelni,
  // ez a végpont közvetlen hívással sem téveszthető össze véletlenül
  // egy másik, hasonló művelettel.
  if (!cegNev || megerositoNev !== cegNev) {
    return sendJson(res, 400, { error: 'A megerősítő cégnév nem egyezik — a törlés biztonsági okból nem történt meg.' });
  }

  const backupDir = backupCompanyBeforeDelete(cleanKulcs);
  deleteCompanyCompletely(cleanKulcs);
  logActivity({ type: 'company_deleted', ok: true, companyKey: null, nev: 'admin', detail: `Cég véglegesen törölve: ${cegNev} (${cleanKulcs}). Biztonsági mentés: ${backupDir}` });
  sendJson(res, 200, { ok: true, backupDir });
});

// Cég hozzárendelése (vagy leválasztása) egy viszonteladóhoz — admin
// bármikor módosíthatja, nemcsak a viszonteladó saját meghívásán keresztül
// jöhet létre a kapcsolat.
route('POST', '/api/admin/companies/assign-reseller', async (req, res) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const { cegKulcs, resellerId } = await readJsonBody(req);
  if (!cegKulcs) return sendJson(res, 400, { error: 'Hiányzó cégkulcs.' });
  const codes = readAccessCodes();
  if (!codes[cegKulcs]) return sendJson(res, 404, { error: 'Ismeretlen cég.' });
  if (resellerId) {
    const reseller = usersDb.prepare(`SELECT id, nev FROM users WHERE id = ? AND role = 'reseller'`).get(resellerId);
    if (!reseller) return sendJson(res, 404, { error: 'Ismeretlen viszonteladó.' });
    codes[cegKulcs].resellerId = reseller.id;
    writeAccessCodes(codes);
    logActivity({ type: 'company_reseller_assign', ok: true, companyKey: cegKulcs, nev: 'admin', detail: `Hozzárendelve: ${reseller.nev}` });
  } else {
    delete codes[cegKulcs].resellerId;
    writeAccessCodes(codes);
    logActivity({ type: 'company_reseller_assign', ok: true, companyKey: cegKulcs, nev: 'admin', detail: 'Viszonteladó-hozzárendelés törölve' });
  }
  sendJson(res, 200, { ok: true });
});

// Egy adott cég/telephely legutóbb szinkronizált .db fájljának letöltése —
// pontosan az van a lemezen, amit az androidos app legutóbb feltöltött.
route('GET', '/api/admin/companies/download-db', async (req, res, query) => {
  const admin = requireAdmin(req);
  if (!admin) return sendJson(res, 401, { error: 'NOT_AUTHENTICATED' });
  const key = String(query.key || '');
  if (!key || !companyIndex.has(key)) return sendJson(res, 404, { error: 'Ismeretlen cég/telephely.' });
  const filePath = dbFileForKey(key);
  if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'A fájl nem található a lemezen — még nem érkezett szinkron.' });
  const entry = companyIndex.get(key);
  const { telephelyKod } = splitSiteKey(key);
  const safeName = `${(entry.nev || 'ceg').replace(/[^a-zA-Z0-9_\-]/g, '_')}_${entry.adoszam || ''}_${telephelyKod || '01'}.db`;
  const data = fs.readFileSync(filePath);
  logActivity({ type: 'admin_db_download', ok: true, companyKey: key, nev: 'admin', detail: `Adatbázis letöltve: ${safeName}` });
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${safeName}"`,
    'Content-Length': data.length,
  });
  res.end(data);
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
  const cookie = `enysession=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax${COOKIE_SECURE ? '; Secure' : ''}`;
  const telephelyInfo = listTelephelyek(entry.cegKulcs).find((t) => t.kod === entry.telephelyKod);
  logActivity({ type: 'admin_impersonate', ok: true, companyKey, nev: entry.nev, detail: 'Admin megnyitotta a telephely nézetét.' });
  sendJson(res, 200, { ok: true, company: { nev: entry.nev, adoszam: entry.adoszam, varos: entry.varos, cim: entry.cim, telephelyNev: telephelyInfo?.nev || entry.telephelyKod } }, { 'Set-Cookie': cookie });
});

// ---------------------------------------------------------------------------
// Statikus fájlok kiszolgálása (public/)
// ---------------------------------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Nem található'); }
    const ext = path.extname(filePath);
    // no-cache = a böngésző tárolhatja, de MINDEN betöltéskor revalidál (ETag).
    // Ha a fájl nem változott → 304, nincs újraletöltés. Ha változott (deploy) →
    // azonnal az új verziót kapja. Így soha nem fordulhat elő, hogy régi
    // index.html új app.js-sel (vagy fordítva) fut együtt — ez okozta a
    // "Cannot access 'loggedIn' before initialization" hibát egyes eszközökön.
    const etag = `"${crypto.createHash('sha1').update(data).digest('hex')}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// HTTP szerver + útvonalválasztás
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const query = Object.fromEntries(u.searchParams.entries());

    if (u.pathname.startsWith('/api/')) {
      const found = routes.find((r) => r.method === req.method && r.pattern === u.pathname);
      if (!found) return sendJson(res, 404, { error: 'Ismeretlen végpont' });
      return await found.handler(req, res, query);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, u.pathname);
    res.writeHead(405); res.end('Method Not Allowed');
  } catch (err) {
    if (err && err.code === 'COMPANY_NOT_FOUND') return sendJson(res, 404, { error: 'A cég adatbázisa nem található.' });
    console.error(err);
    // A részletes hibaüzenetet (pl. SQL/fájlrendszer belső infó) csak a szerver
    // naplójába írjuk — a kliens felé kizárólag egy általános üzenet megy ki,
    // hogy ne szivárogjon ki belső implementációs részlet.
    sendJson(res, 500, { error: 'Szerverhiba történt. Próbáld újra, vagy jelezd az üzemeltetőnek.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`L-NYUGTA nézegető fut: http://${HOST}:${PORT}`);
});

// Rendezett leállás: minden nyitott céges adatbázis-kapcsolatot bezárunk.
function shutdown() {
  for (const key of [...dbCache.keys()]) evictConnection(key);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
