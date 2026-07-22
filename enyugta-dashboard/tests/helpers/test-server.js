'use strict';
// Teszt-szerver indító/leállító segédmodul — a TÉNYLEGES server.js-t
// indítja el, egy ideiglenes, elkülönített adatkönyvtárral (LNYUGTA_DATA_DIR),
// fix, teszt-célú titkokkal, hogy a tesztek reprodukálhatóak legyenek.

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { buildTestCompanyDb } = require('./build-test-db');

const APP_ROOT = path.join(__dirname, '..', '..');

const TEST_SESSION_SECRET = 'teszt-session-secret-0123456789';
const TEST_SYNC_API_KEY = 'teszt-sync-api-kulcs-0123456789';
const TEST_ADMIN_PASSWORD = 'TesztAdminJelszo2026';

// Egyetlen RSA-kulcspár a fizetési tesztekhez — a szerver ezzel írja alá a
// KIMENŐ (myPOS felé induló) kéréseket, a teszt pedig UGYANEZZEL a
// kulcspárral szimulálja a myPOS BEÉRKEZŐ (notify) hívását, mintha ő lenne
// a myPOS — ez egy önmagában konzisztens, valós titkosítást használó
// teszt-környezet, valódi myPOS-fiók nélkül is.
let cachedTestKeys = null;
function getTestMyposKeys() {
  if (cachedTestKeys) return cachedTestKeys;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  cachedTestKeys = { privateKey, publicKey };
  return cachedTestKeys;
}

async function startTestServer({ port } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lnyugta-test-'));
  const dataDir = path.join(tmpDir, 'data');
  const companiesDir = path.join(dataDir, 'companies', '18774455');
  fs.mkdirSync(companiesDir, { recursive: true });

  buildTestCompanyDb(path.join(companiesDir, '01.db'), {
    adoszam: '18774455-1-42',
    nev: 'Teszt Kávézó Kft.',
  });

  const { privateKey, publicKey } = getTestMyposKeys();
  const privateKeyPath = path.join(tmpDir, 'mypos_private.pem');
  const publicCertPath = path.join(tmpDir, 'mypos_public.pem');
  fs.writeFileSync(privateKeyPath, privateKey);
  fs.writeFileSync(publicCertPath, publicKey);

  const actualPort = port || 10000 + (process.pid % 5000) + Math.floor(Math.random() * 5000);

  const child = spawn('node', ['server.js'], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PORT: String(actualPort),
      HOST: '127.0.0.1',
      LNYUGTA_DATA_DIR: dataDir,
      LNYUGTA_BACKUP_DIR: path.join(tmpDir, 'backups'),
      SESSION_SECRET: TEST_SESSION_SECRET,
      SYNC_API_KEY: TEST_SYNC_API_KEY,
      ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
      DISABLE_SECURE_COOKIES: '1', // a tesztek http-n, nem https-en futnak
      MYPOS_SID: 'teszt-sid-000000000010',
      MYPOS_WALLET: 'teszt-wallet-619381666',
      MYPOS_KEY_INDEX: '1',
      MYPOS_PRIVATE_KEY_PATH: privateKeyPath,
      MYPOS_PUBLIC_CERT_PATH: publicCertPath,
      MYPOS_SANDBOX: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  const baseUrl = `http://127.0.0.1:${actualPort}`;

  // Várakozás, amíg a szerver ténylegesen válaszol — legfeljebb ~8 másodpercig.
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl + '/');
      if (res.status) { ready = true; break; }
    } catch (_) { /* még nem fut, próbáljuk újra */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!ready) {
    child.kill();
    throw new Error(`A teszt-szerver nem indult el az elvárt időn belül. Kimenet:\n${output}`);
  }

  async function stop() {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return {
    baseUrl, stop, syncApiKey: TEST_SYNC_API_KEY, adminPassword: TEST_ADMIN_PASSWORD, dataDir,
    myposPrivateKey: privateKey, // a teszt ezzel írja alá a "myPOS-tól érkező" notify hívást
  };
}

module.exports = { startTestServer, TEST_SESSION_SECRET, TEST_SYNC_API_KEY, TEST_ADMIN_PASSWORD };
