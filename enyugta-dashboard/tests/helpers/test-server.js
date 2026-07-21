'use strict';
// Teszt-szerver indító/leállító segédmodul — a TÉNYLEGES server.js-t
// indítja el, egy ideiglenes, elkülönített adatkönyvtárral (LNYUGTA_DATA_DIR),
// fix, teszt-célú titkokkal, hogy a tesztek reprodukálhatóak legyenek.

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { buildTestCompanyDb } = require('./build-test-db');

const APP_ROOT = path.join(__dirname, '..', '..');

const TEST_SESSION_SECRET = 'teszt-session-secret-0123456789';
const TEST_SYNC_API_KEY = 'teszt-sync-api-kulcs-0123456789';
const TEST_ADMIN_PASSWORD = 'TesztAdminJelszo2026';

async function startTestServer({ port } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lnyugta-test-'));
  const dataDir = path.join(tmpDir, 'data');
  const companiesDir = path.join(dataDir, 'companies', '18774455');
  fs.mkdirSync(companiesDir, { recursive: true });

  buildTestCompanyDb(path.join(companiesDir, '01.db'), {
    adoszam: '18774455-1-42',
    nev: 'Teszt Kávézó Kft.',
  });

  const actualPort = port || 4000 + Math.floor(Math.random() * 5000);

  const child = spawn('node', ['server.js'], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PORT: String(actualPort),
      HOST: '127.0.0.1',
      LNYUGTA_DATA_DIR: dataDir,
      SESSION_SECRET: TEST_SESSION_SECRET,
      SYNC_API_KEY: TEST_SYNC_API_KEY,
      ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
      DISABLE_SECURE_COOKIES: '1', // a tesztek http-n, nem https-en futnak
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  const baseUrl = `http://127.0.0.1:${actualPort}`;

  // Várakozás, amíg a szerver ténylegesen válaszol — legfeljebb ~8 másodpercig.
  const deadline = Date.now() + 8000;
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
    await new Promise((r) => setTimeout(r, 100));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return { baseUrl, stop, syncApiKey: TEST_SYNC_API_KEY, adminPassword: TEST_ADMIN_PASSWORD, dataDir };
}

module.exports = { startTestServer, TEST_SESSION_SECRET, TEST_SYNC_API_KEY, TEST_ADMIN_PASSWORD };
