'use strict';
// Automatizált tesztek — a beépített node:test futtatóval (nulla külső
// függőség, összhangban a projekt "zéró npm-függőség" elvével).
//
// Futtatás:
//   npm test
//   vagy közvetlenül: node --test tests/
//
// Minden teszt egy ÚJ, ELKÜLÖNÍTETT szerver-példányt indít (saját,
// ideiglenes adatkönyvtárral) — a tesztek egymást nem befolyásolják,
// és a valódi, éles data/ mappához nem nyúlnak.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers/test-server');

// Egyszerű cookie-jar segéd — a fetch natívan nem kezeli a sütiket
// kérések között, ezért kézzel adjuk tovább a Set-Cookie fejlécet.
function extractCookie(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  return raw.split(';')[0];
}

test('Auth és munkamenet', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  await t.test('hibás jelszóval a bejelentkezés 401-et ad, egyértelmű hibaüzenettel', async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/user-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nincs.ilyen@example.com', password: 'akarmi1234' }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error);
  });

  await t.test('admin bejelentkezés helyes jelszóval sikeres', async () => {
    const res = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: server.adminPassword }),
    });
    assert.equal(res.status, 200);
    const cookie = extractCookie(res);
    assert.ok(cookie, 'a szervernek session-sütit kell visszaadnia');
  });

  await t.test('kijelentkezés után a RÉGI süti már nem érvényes (szerver-oldali visszavonás)', async () => {
    const loginRes = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: server.adminPassword }),
    });
    const cookie = extractCookie(loginRes);

    const beforeLogout = await fetch(`${server.baseUrl}/api/admin/overview`, {
      headers: { Cookie: cookie },
    });
    assert.equal(beforeLogout.status, 200, 'kijelentkezés előtt a sütinek érvényesnek kell lennie');

    await fetch(`${server.baseUrl}/api/admin/logout`, { method: 'POST', headers: { Cookie: cookie } });

    const afterLogout = await fetch(`${server.baseUrl}/api/admin/overview`, {
      headers: { Cookie: cookie },
    });
    assert.equal(afterLogout.status, 401, 'kijelentkezés UTÁN a régi sütivel 401-et kell kapni');
  });
});

test('Sebesség-korlátozás (rate limit)', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  await t.test('a jelszó-visszaállítás 10 kérés után 429-et ad ugyanarról az IP-ről', async () => {
    let lastStatus = null;
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${server.baseUrl}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `teszt${i}@example.com` }),
      });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429, 'a 11. kérésnek már korlátozottnak kell lennie');
  });
});

test('Fájltípus-ellenőrzés feltöltésnél', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  await t.test('egy hamis (nem valódi kép-tartalmú) fájl elutasításra kerül', async () => {
    // Bejelentkezés + telephely-választás egy valódi teszt-fiókkal
    const bodyBuf = Buffer.from('ez nem egy valódi kép, csak sima szöveg');
    const fakeBase64 = `data:image/jpeg;base64,${bodyBuf.toString('base64')}`;

    // Az egyszerűség kedvéért közvetlenül egy admin-impersonate munkamenettel
    // teszteljük — a lényeg maga a tartalom-alapú ellenőrzés.
    const loginRes = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: server.adminPassword }),
    });
    const adminCookie = extractCookie(loginRes);
    const impersonateRes = await fetch(`${server.baseUrl}/api/admin/impersonate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ companyKey: '18774455:01' }),
    });
    assert.equal(impersonateRes.status, 200);
    const companyCookie = extractCookie(impersonateRes);

    const uploadRes = await fetch(`${server.baseUrl}/api/stock/receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: companyCookie },
      body: JSON.stringify({
        cikkNev: 'Espresso', mennyiseg: 5,
        fajlAdat: fakeBase64, fajlNev: 'kep.jpg',
      }),
    });
    assert.equal(uploadRes.status, 400, 'egy nem-valódi képtartalmat el kell utasítani, még ha .jpg-nek is nevezik');
  });
});

test('Cikktörzs — átnevezés tiltása szerkesztéskor', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  async function getCompanySession() {
    const loginRes = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: server.adminPassword }),
    });
    const adminCookie = extractCookie(loginRes);
    const impersonateRes = await fetch(`${server.baseUrl}/api/admin/impersonate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ companyKey: '18774455:01' }),
    });
    return extractCookie(impersonateRes);
  }

  await t.test('a nevet megváltoztató "szerkesztés" (originalMegnevezes eltér) elutasításra kerül', async () => {
    const cookie = await getCompanySession();
    const res = await fetch(`${server.baseUrl}/api/products/change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ megnevezes: 'Új Név', originalMegnevezes: 'Espresso', bruttoar: 700, afakod: '27%' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /nem módosítható/);
  });

  await t.test('egy VALÓDI, új cikk létrehozása (nincs originalMegnevezes) sikeres', async () => {
    const cookie = await getCompanySession();
    const res = await fetch(`${server.baseUrl}/api/products/change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ megnevezes: 'Vadonatúj Cikk', bruttoar: 1200, afakod: '27%' }),
    });
    assert.equal(res.status, 200);
  });
});

test('Meghívás folyamata', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  await t.test('teljes kör: meghívás -> info -> GDPR nélkül elutasítva -> teljes elfogadás sikeres -> bejelentkezés működik', async () => {
    const loginRes = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: server.adminPassword }),
    });
    const adminCookie = extractCookie(loginRes);

    const inviteRes = await fetch(`${server.baseUrl}/api/admin/invite-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ role: 'owner', adoszam: '18774455', email: 'teszt.uj@example.com' }),
    });
    assert.equal(inviteRes.status, 200);
    const inviteBody = await inviteRes.json();
    const token = new URL(inviteBody.inviteLink).searchParams.get('meghivo');
    assert.ok(token);

    const infoRes = await fetch(`${server.baseUrl}/api/invite/info?token=${token}`);
    assert.equal(infoRes.status, 200);
    const info = await infoRes.json();
    assert.equal(info.adoszam, '18774455-1-42', 'a meghívó-infónak tartalmaznia kell az adószámot');

    const noGdprRes = await fetch(`${server.baseUrl}/api/invite/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, nev: 'Teszt Elek', telefon: '+36301234567', password: 'UjJelszo2026' }),
    });
    assert.equal(noGdprRes.status, 400, 'GDPR-elfogadás nélkül el kell utasítani');

    const acceptRes = await fetch(`${server.baseUrl}/api/invite/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token, nev: 'Teszt Elek', telefon: '+36301234567', password: 'UjJelszo2026',
        gdprAccepted: true, aszfAccepted: true,
      }),
    });
    assert.equal(acceptRes.status, 200);

    const finalLoginRes = await fetch(`${server.baseUrl}/api/auth/user-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'teszt.uj@example.com', password: 'UjJelszo2026' }),
    });
    assert.equal(finalLoginRes.status, 200);
  });
});

test('Alapvető adat-végpontok', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  async function getCompanySession() {
    const loginRes = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: server.adminPassword }),
    });
    const adminCookie = extractCookie(loginRes);
    const impersonateRes = await fetch(`${server.baseUrl}/api/admin/impersonate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ companyKey: '18774455:01' }),
    });
    return extractCookie(impersonateRes);
  }

  await t.test('a nyugták végpont a helyes rendezésben adja vissza az adatot', async () => {
    const cookie = await getCompanySession();
    const from = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const res = await fetch(
      `${server.baseUrl}/api/receipts?from=${from}&to=${to}&limit=15&offset=0&sort=osszeg&order=desc`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.items.length > 0, 'kell legyen legalább egy nyugta a teszt-adatban');
    for (let i = 1; i < body.items.length; i++) {
      assert.ok(body.items[i - 1].osszeg >= body.items[i].osszeg, 'csökkenő sorrendben kell lennie');
    }
  });

  await t.test('a szinkron API-kulcs nélküli licenc-lekérdezés elutasításra kerül', async () => {
    const res = await fetch(`${server.baseUrl}/api/license/status?adoszam=18774455-1-42`);
    assert.equal(res.status, 401);
  });

  await t.test('a helyes szinkron API-kulccsal a licenc-lekérdezés sikeres', async () => {
    const res = await fetch(`${server.baseUrl}/api/license/status?adoszam=18774455-1-42`, {
      headers: { 'x-api-key': server.syncApiKey },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.funkciok));
  });
});

test('NTAK — cégenkénti kapcsoló és a Cikktörzs kötelező mezői', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  async function getCompanySession() {
    const loginRes = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: server.adminPassword }),
    });
    const adminCookie = extractCookie(loginRes);
    const impersonateRes = await fetch(`${server.baseUrl}/api/admin/impersonate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ companyKey: '18774455:01' }),
    });
    return extractCookie(impersonateRes);
  }

  await t.test('alapból ki van kapcsolva, és a mezők nem kötelezők', async () => {
    const cookie = await getCompanySession();
    const settingRes = await fetch(`${server.baseUrl}/api/profile/ntak-setting`, { headers: { Cookie: cookie } });
    assert.equal((await settingRes.json()).ntakAktiv, false);

    const res = await fetch(`${server.baseUrl}/api/products/change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ megnevezes: 'NTAK teszt cikk 1', bruttoar: 500, afakod: '27%' }),
    });
    assert.equal(res.status, 200, 'NTAK-mezők nélkül is sikeresnek kell lennie, amíg a cég nincs NTAK-os módban');
  });

  await t.test('bekapcsolás után a fő- és alkategória kötelezővé válik', async () => {
    const cookie = await getCompanySession();
    const toggleRes = await fetch(`${server.baseUrl}/api/profile/ntak-setting`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ntakAktiv: true }),
    });
    assert.equal(toggleRes.status, 200);

    const withoutCategories = await fetch(`${server.baseUrl}/api/products/change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ megnevezes: 'NTAK teszt cikk 2', bruttoar: 500, afakod: '27%' }),
    });
    assert.equal(withoutCategories.status, 400, 'kategóriák nélkül el kell utasítani, ha a cég NTAK-os módban van');

    const withCategories = await fetch(`${server.baseUrl}/api/products/change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ megnevezes: 'NTAK teszt cikk 3', bruttoar: 500, afakod: '27%', fokat: 'ETEL', alkat: 'FOETEL' }),
    });
    assert.equal(withCategories.status, 200, 'megadott kategóriákkal sikeresnek kell lennie');

    const masterRes = await fetch(`${server.baseUrl}/api/products/master`, { headers: { Cookie: cookie } });
    const masterBody = await masterRes.json();
    assert.equal(masterBody.ntakAktiv, true);
    const created = masterBody.items.find((it) => it.nev === 'NTAK teszt cikk 3');
    assert.ok(created, 'az új cikknek meg kell jelennie függőben lévő tételként');
    assert.equal(created.pendingChange.fokatjson, 'ETEL', 'a payload-nak a valódi cikkt oszlopnevet (fokatjson) kell használnia');
    assert.equal(created.pendingChange.alkatjson, 'FOETEL');
  });
});

test('NTAK — tartalék-lekérdezés, amikor nincs külön ntakrms tábla', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  async function getCompanySession() {
    const loginRes = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: server.adminPassword }),
    });
    const adminCookie = extractCookie(loginRes);
    const impersonateRes = await fetch(`${server.baseUrl}/api/admin/impersonate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ companyKey: '18774455:01' }),
    });
    return extractCookie(impersonateRes);
  }

  await t.test('a nyfej-alapú tartalék akkor is helyesen működik, ha a séma nem tartalmaz "rmsfelduuid" oszlopot', async () => {
    // A teszt-adatbázisban SZÁNDÉKOSAN nincs sem ntakrms tábla, sem
    // rmsfelduuid oszlop — pontosan úgy, ahogy egyes valós LSZAMLA-
    // változatoknál sem — ez volt a gyökér-oka egy korábbi, éles hibának:
    // a tartalék-lekérdezés ezen a hiányzó oszlopon elszállt, és emiatt a
    // "legutóbbi küldések" lista sosem töltődött fel, még akkor sem, ha
    // az összesítő adat (submissionsByStatus) átjött.
    const cookie = await getCompanySession();
    const from = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const res = await fetch(`${server.baseUrl}/api/ntak/summary?from=${from}&to=${to}`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.usedNyfejFallback, true, 'a tartaléknak be kell kapcsolnia, mivel nincs ntakrms tábla');
    assert.ok(body.submissionsByStatus.length > 0, 'az összesítőnek tartalmaznia kell adatot');
    assert.ok(body.recent.length > 0, 'a részletes listának IS tartalmaznia kell adatot — ez volt a hiba, ami korábban üresen maradt');
    assert.ok(!body.diag.error.includes('no such column'), 'nem szabad "no such column" hibának maradnia a diagnosztikában');
  });
});
