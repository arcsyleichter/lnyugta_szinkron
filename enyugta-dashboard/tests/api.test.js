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

test('Cikktörzs — termékfotó és göngyöleg-kapcsolás', async (t) => {
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

  await t.test('valódi PNG-fotó feltöltése és megjelenése a Cikktörzsben', async () => {
    const cookie = await getCompanySession();
    // Legkisebb érvényes PNG (1x1 pixel), hogy a mágikus-bájtos ellenőrzés átengedje.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const uploadRes = await fetch(`${server.baseUrl}/api/products/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ megnevezes: 'Espresso', fajlAdat: `data:image/png;base64,${png}` }),
    });
    assert.equal(uploadRes.status, 200);

    const masterRes = await fetch(`${server.baseUrl}/api/products/master`, { headers: { Cookie: cookie } });
    const masterBody = await masterRes.json();
    const espresso = masterBody.items.find((it) => it.nev === 'Espresso');
    assert.ok(espresso.kepFajlnev, 'a feltöltött fotónak meg kell jelennie a cikk adatai közt');

    const imgRes = await fetch(`${server.baseUrl}/api/products/image?fajlnev=${espresso.kepFajlnev}`, { headers: { Cookie: cookie } });
    assert.equal(imgRes.status, 200);
    assert.match(imgRes.headers.get('content-type'), /^image\//);
  });

  await t.test('göngyöleg-kapcsolás egy meglévő termékre sikeres, ismeretlenre elutasított', async () => {
    const cookie = await getCompanySession();
    const masterRes = await fetch(`${server.baseUrl}/api/products/master`, { headers: { Cookie: cookie } });
    const masterBody = await masterRes.json();
    assert.ok(masterBody.packagingOptions.length > 0, 'a göngyöleg-választónak fel kell ajánlania a meglévő cikkeket');
    const espressoAzon = masterBody.items.find((it) => it.nev === 'Espresso').azon;

    const okRes = await fetch(`${server.baseUrl}/api/products/change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ megnevezes: 'Cappuccino', originalMegnevezes: 'Cappuccino', bruttoar: 950, afakod: '27%', gongyolegAzon: espressoAzon }),
    });
    assert.equal(okRes.status, 200);

    const badRes = await fetch(`${server.baseUrl}/api/products/change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ megnevezes: 'Latte Macchiato', originalMegnevezes: 'Latte Macchiato', bruttoar: 950, afakod: '27%', gongyolegAzon: 'nemletezo-azon-9999' }),
    });
    assert.equal(badRes.status, 400, 'nem létező göngyöleg-termékre hivatkozást el kell utasítani');
  });
});

test('Admin — funkció törlése a licenc-katalógusból', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  async function getAdminCookie() {
    const loginRes = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: server.adminPassword }),
    });
    return extractCookie(loginRes);
  }

  await t.test('egy csak LEJÁRT/LETILTOTT kiosztással rendelkező funkció akadálytalanul törölhető', async () => {
    const adminCookie = await getAdminCookie();
    const saveRes = await fetch(`${server.baseUrl}/api/admin/license/features/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ key: 'TESZT_FUNKCIO', nev: 'Teszt funkció' }),
    });
    assert.equal(saveRes.status, 200);

    // Egy MÁR LETILTOTT (aktiv:false) kiosztás — ez volt a bejelentett hiba
    // gyökér-oka: egy ilyen, valójában nem élő sor is blokkolta a törlést.
    const grantRes = await fetch(`${server.baseUrl}/api/admin/license/grant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ cegKulcs: '18774455', featureKey: 'TESZT_FUNKCIO', ar: 0, aktiv: false }),
    });
    assert.equal(grantRes.status, 200);

    const deleteRes = await fetch(`${server.baseUrl}/api/admin/license/features/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ key: 'TESZT_FUNKCIO' }),
    });
    assert.equal(deleteRes.status, 200, 'egy csak letiltott kiosztással rendelkező funkciónak akadálytalanul törölhetőnek kell lennie, force nélkül is');
  });

  await t.test('egy VALÓBAN aktív kiosztással rendelkező funkció force nélkül elutasításra kerül, force-szal törölhető', async () => {
    const adminCookie = await getAdminCookie();
    await fetch(`${server.baseUrl}/api/admin/license/features/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ key: 'TESZT_FUNKCIO2', nev: 'Teszt funkció 2' }),
    });
    await fetch(`${server.baseUrl}/api/admin/license/grant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ cegKulcs: '18774455', featureKey: 'TESZT_FUNKCIO2', ar: 500, aktiv: true }),
    });

    const blockedRes = await fetch(`${server.baseUrl}/api/admin/license/features/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ key: 'TESZT_FUNKCIO2' }),
    });
    assert.equal(blockedRes.status, 400);
    const blockedBody = await blockedRes.json();
    assert.equal(blockedBody.canForce, true, 'a válasznak jeleznie kell, hogy kényszerítéssel törölhető');
    assert.equal(blockedBody.activeCount, 1);

    const forcedRes = await fetch(`${server.baseUrl}/api/admin/license/features/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ key: 'TESZT_FUNKCIO2', force: true }),
    });
    assert.equal(forcedRes.status, 200, 'force:true esetén akkor is törlődnie kell, ha van aktív kiosztás');
  });
});

test('Licenc-lekérdezés — soha nem szinkronizált cég', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  await t.test('egy olyan adószámra, aminek MÉG SOSEM érkezett feltöltése, mindkét mezőnek false-nak kell lennie', async () => {
    const res = await fetch(
      `${server.baseUrl}/api/license/status?adoszam=99999999-1-42&eszkoz=ismeretlen-uuid-1234`,
      { headers: { 'x-api-key': server.syncApiKey } }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.alapElofizetesAktiv, false, 'egy soha nem szinkronizált cégnél az alap-előfizetés NEM lehet aktív');
    assert.equal(body.eszkozRegisztralva, false, 'egy soha nem szinkronizált cégnél az eszköz NEM lehet regisztrálva');
    assert.deepEqual(body.funkciok, []);
  });

  await t.test('egy MÁR ténylegesen szinkronizált cégnél a szokásos logika érvényesül továbbra is', async () => {
    const res = await fetch(
      `${server.baseUrl}/api/license/status?adoszam=18774455-1-42&eszkoz=uj-eszkoz-elso-lekerdezes`,
      { headers: { 'x-api-key': server.syncApiKey } }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.alapElofizetesAktiv, true, 'egy valóban létező, szinkronizált cégnél az alap-előfizetésnek alapból aktívnak kell lennie');
  });
});

test('NAV-formátumú cím — számlázási cím és telephely-cím', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  async function getCompanySession() {
    const loginRes = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: server.adminPassword }),
    });
    const adminCookie = extractCookie(loginRes);
    const impersonateRes = await fetch(`${server.baseUrl}/api/admin/impersonate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ companyKey: '18774455:01' }),
    });
    return extractCookie(impersonateRes);
  }

  await t.test('a számlázási cím elmenthető és pontosan visszaolvasható', async () => {
    const cookie = await getCompanySession();
    const saveRes = await fetch(`${server.baseUrl}/api/profile/billing-address`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ iranyitoszam: '1053', telepules: 'Budapest', kozteruletNev: 'Kossuth Lajos', kozteruletJelleg: 'utca', hazszam: '12', emelet: '2. em. 3. ajtó' }),
    });
    assert.equal(saveRes.status, 200);
    const getRes = await fetch(`${server.baseUrl}/api/profile/billing-address`, { headers: { Cookie: cookie } });
    const body = await getRes.json();
    assert.equal(body.telepules, 'Budapest');
    assert.equal(body.hazszam, '12');
    assert.ok(body.kozteruletJellegek.includes('utca'), 'a válasznak tartalmaznia kell a közterület-jelleg listát');
  });

  await t.test('érvénytelen irányítószám elutasításra kerül', async () => {
    const cookie = await getCompanySession();
    const res = await fetch(`${server.baseUrl}/api/profile/billing-address`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ iranyitoszam: 'ABC12', telepules: 'Budapest' }),
    });
    assert.equal(res.status, 400);
  });

  await t.test('új telephely strukturált címmel jön létre, és a megjelenített cím helyesen formázott', async () => {
    const cookie = await getCompanySession();
    const createRes = await fetch(`${server.baseUrl}/api/telephely/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ kod: '03', nev: 'Belvárosi bolt', iranyitoszam: '6000', telepules: 'Kecskemét', kozteruletNev: 'Fő', kozteruletJelleg: 'tér', hazszam: '3' }),
    });
    assert.equal(createRes.status, 200);

    const listRes = await fetch(`${server.baseUrl}/api/telephelyek`, { headers: { Cookie: cookie } });
    const listBody = await listRes.json();
    const site = listBody.telephelyek.find((t) => t.kod === '03');
    assert.equal(site.cim, '6000 Kecskemét, Fő tér 3.');
    assert.equal(site.cimReszletek.telepules, 'Kecskemét');
  });
});

test('Telephelyenkénti önkiszolgáló funkció-választás', async (t) => {
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
  async function getAdminCookie() {
    const loginRes = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: server.adminPassword }),
    });
    return extractCookie(loginRes);
  }

  await t.test('a cég maga bekapcsolhat egy funkciót a saját telephelyére, és ez azonnal látszik az adminnak is', async () => {
    const cookie = await getCompanySession();
    const beforeRes = await fetch(`${server.baseUrl}/api/profile/features`, { headers: { Cookie: cookie } });
    const beforeBody = await beforeRes.json();
    assert.equal(beforeBody.telephelyKod, '01');
    assert.ok(!beforeBody.features.find((f) => f.key === 'NTAK').kivalasztva, 'kezdetben nem szabad kiválasztva lennie');

    const toggleRes = await fetch(`${server.baseUrl}/api/profile/features/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ featureKey: 'NTAK', kivalasztva: true }),
    });
    assert.equal(toggleRes.status, 200);

    const afterRes = await fetch(`${server.baseUrl}/api/profile/features`, { headers: { Cookie: cookie } });
    const afterBody = await afterRes.json();
    assert.ok(afterBody.features.find((f) => f.key === 'NTAK').kivalasztva, 'a bekapcsolás után kiválasztottnak kell mutatkoznia');

    // Az adminnak telephely-bontásban, azonnal látnia kell.
    const adminCookie = await getAdminCookie();
    const adminRes = await fetch(`${server.baseUrl}/api/admin/license/companies`, { headers: { Cookie: adminCookie } });
    const adminBody = await adminRes.json();
    const company = adminBody.companies.find((c) => c.cegKulcs === '18774455');
    const site = company.telephelyek.find((t) => t.kod === '01');
    const ntakOnSite = site.licenses.find((f) => f.key === 'NTAK');
    assert.equal(ntakOnSite.kiosztva, true);
    assert.equal(ntakOnSite.aktiv, true);
    assert.equal(ntakOnSite.sajatTelephelySpecifikus, true, 'ennek telephely-specifikus kiosztásnak kell lennie, nem cégszintűnek');
  });

  await t.test('admin oldali, cégszintű kiosztás is helyesen érvényesül egy telephelyen, ha nincs saját, felülíró beállítása', async () => {
    const adminCookie = await getAdminCookie();
    // Cégszintű kiosztás (nincs telephelyKod megadva) egy MÁSIK funkcióra.
    const grantRes = await fetch(`${server.baseUrl}/api/admin/license/grant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ cegKulcs: '18774455', featureKey: 'SZAMLSZEM', ar: 500 }),
    });
    assert.equal(grantRes.status, 200);

    const cookie = await getCompanySession();
    const res = await fetch(`${server.baseUrl}/api/profile/features`, { headers: { Cookie: cookie } });
    const body = await res.json();
    const found = body.features.find((f) => f.key === 'SZAMLSZEM');
    assert.equal(found.kivalasztva, true, 'a cégszintű kiosztásnak érvényesülnie kell a telephelyen, ha nincs saját felülírás');
    assert.equal(found.sajatTelephelySpecifikus, false, 'ez a cégszintű öröklött kiosztás, nem a telephely saját beállítása');
  });
});

test('Funkció-katalógus inaktiválás — a cég és az admin nézete ne térjen el', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  async function getAdminCookie() {
    const loginRes = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: server.adminPassword }),
    });
    return extractCookie(loginRes);
  }
  async function getCompanySession() {
    const adminCookie = await getAdminCookie();
    const impersonateRes = await fetch(`${server.baseUrl}/api/admin/impersonate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ companyKey: '18774455:01' }),
    });
    return extractCookie(impersonateRes);
  }

  await t.test('ha a cégnek van aktív kiosztása egy azóta a katalógusból inaktivált funkcióra, az a saját nézetében is látszódjon', async () => {
    const cookie = await getCompanySession();
    await fetch(`${server.baseUrl}/api/profile/features/toggle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ featureKey: 'MERLEGELES', kivalasztva: true }),
    });

    const adminCookie = await getAdminCookie();
    // Admin inaktiválja a funkciót a KATALÓGUSBAN — a meglévő kiosztás
    // ettől függetlenül megmarad a company_licenses táblában.
    await fetch(`${server.baseUrl}/api/admin/license/features/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ key: 'MERLEGELES', nev: 'Mérlegelés', alapAr: 0, aktiv: false }),
    });

    const profileRes = await fetch(`${server.baseUrl}/api/profile/features`, { headers: { Cookie: cookie } });
    const profileBody = await profileRes.json();
    const found = profileBody.features.find((f) => f.key === 'MERLEGELES');
    assert.ok(found, 'a cégnek látnia kell ezt a funkciót, mivel ténylegesen aktívan ki van osztva neki, még ha a katalógusból törölték is');
    assert.equal(found.kivalasztva, true);

    const adminOverviewRes = await fetch(`${server.baseUrl}/api/admin/license/companies`, { headers: { Cookie: adminCookie } });
    const adminOverviewBody = await adminOverviewRes.json();
    const company = adminOverviewBody.companies.find((c) => c.cegKulcs === '18774455');
    const site = company.telephelyek.find((t) => t.kod === '01');
    const adminFound = site.licenses.find((f) => f.key === 'MERLEGELES');
    assert.equal(adminFound.aktiv, true, 'az adminnak is aktívnak kell mutatnia — ugyanaz a kiosztás, csak a katalógus-állapot változott');
    assert.equal(adminFound.katalogusAktiv, false, 'jeleznie kell, hogy a katalógusban már inaktív');
  });
});

test('Admin — Pénzügyek: bevétel-áttekintés és számla-PDF letöltés', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  async function getAdminCookie() {
    const loginRes = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: server.adminPassword }),
    });
    return extractCookie(loginRes);
  }
  async function getCompanySession() {
    const adminCookie = await getAdminCookie();
    const impersonateRes = await fetch(`${server.baseUrl}/api/admin/impersonate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ companyKey: '18774455:01' }),
    });
    const cookie = extractCookie(impersonateRes);
    // A fizetés mostantól megköveteli a kitöltött, NAV-formátumú
    // számlázási címet — minden teszt-cégnél ezt itt, egy helyen állítjuk be.
    await fetch(`${server.baseUrl}/api/profile/billing-address`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ iranyitoszam: '1053', telepules: 'Budapest', kozteruletNev: 'Kossuth Lajos', kozteruletJelleg: 'utca', hazszam: '12' }),
    });
    return cookie;
  }

  await t.test('sikeres fizetés után a bevétel megjelenik a cégenkénti/funkciónkénti/havi bontásban, és a PDF ténylegesen letölthető', async () => {
    const adminCookie = await getAdminCookie();
    await fetch(`${server.baseUrl}/api/admin/license/features/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ key: 'NTAK', nev: 'NTAK', alapAr: 2500 }),
    });
    const cookie = await getCompanySession();
    await fetch(`${server.baseUrl}/api/profile/email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email: 'penzugyi-teszt@example.com' }),
    });
    const payRes = await fetch(`${server.baseUrl}/api/payment/demo-pay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ featureKeys: ['NTAK'] }),
    });
    assert.equal(payRes.status, 200);

    const overviewRes = await fetch(`${server.baseUrl}/api/admin/finance/overview`, { headers: { Cookie: adminCookie } });
    const overview = await overviewRes.json();
    assert.equal(overview.osszesenMindenIdok, 2500);
    assert.equal(overview.cegenkent[0].osszeg, 2500);
    assert.equal(overview.funkciononkent[0].featureKey, 'NTAK');
    assert.equal(overview.havonta[0].osszeg, 2500);

    const invoicesRes = await fetch(`${server.baseUrl}/api/admin/finance/invoices`, { headers: { Cookie: adminCookie } });
    const invoicesBody = await invoicesRes.json();
    const invoice = invoicesBody.invoices[0];
    assert.match(invoice.szamlaSorszam, /^\d{4}\/\d{6}$/);
    assert.equal(invoice.pdfElerheto, true);
    assert.ok(invoice.pdfFajlnev);

    const pdfRes = await fetch(`${server.baseUrl}/api/admin/finance/invoice-pdf?fajlnev=${encodeURIComponent(invoice.pdfFajlnev)}`, { headers: { Cookie: adminCookie } });
    assert.equal(pdfRes.status, 200);
    assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
    const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
    assert.ok(pdfBuffer.slice(0, 5).toString() === '%PDF-', 'a letöltött fájlnak valódi PDF-nek kell lennie');
  });

  await t.test('a számla akkor is elkészül és letölthető, ha a cégnek nincs beállított email címe (a fizetés jóváírása nem múlhat az emailen)', async () => {
    const adminCookie = await getAdminCookie();
    const cookie = await getCompanySession();
    // Ennek a cégnek NINCS beállítva email cím ebben a sub-teszben.
    await fetch(`${server.baseUrl}/api/admin/license/features/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ key: 'VONALKOD', nev: 'Vonalkód generálás', alapAr: 800 }),
    });
    await fetch(`${server.baseUrl}/api/profile/email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email: '' }),
    });
    const payRes = await fetch(`${server.baseUrl}/api/payment/demo-pay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ featureKeys: ['VONALKOD'] }),
    });
    const payBody = await payRes.json();
    assert.ok(payBody.emailWarning, 'email nélkül figyelmeztetést kell adnia');

    const invoicesRes = await fetch(`${server.baseUrl}/api/admin/finance/invoices`, { headers: { Cookie: adminCookie } });
    const invoicesBody = await invoicesRes.json();
    const invoice = invoicesBody.invoices.find((i) => i.tetelek.some((t) => t.nev === 'Vonalkód generálás'));
    assert.ok(invoice, 'a számlának EL KELL KÉSZÜLNIE akkor is, ha az email küldése nem sikerült');
    assert.equal(invoice.pdfElerheto, true);
  });
});

test('Egyszerű demo-fizetés (myPOS nélkül)', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  async function getCompanySession() {
    const loginRes = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: server.adminPassword }),
    });
    const adminCookie = extractCookie(loginRes);
    const impersonateRes = await fetch(`${server.baseUrl}/api/admin/impersonate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ companyKey: '18774455:01' }),
    });
    const cookie = extractCookie(impersonateRes);
    await fetch(`${server.baseUrl}/api/profile/billing-address`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ iranyitoszam: '1053', telepules: 'Budapest', kozteruletNev: 'Kossuth Lajos', kozteruletJelleg: 'utca', hazszam: '12' }),
    });
    return cookie;
  }
  async function getAdminCookie() {
    const loginRes = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: server.adminPassword }),
    });
    return extractCookie(loginRes);
  }

  await t.test('fizetés nem indítható, ha a cég számlázási címe nincs kitöltve', async () => {
    const adminCookie = await getAdminCookie();
    await fetch(`${server.baseUrl}/api/admin/license/features/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ key: 'CIMTESZT', nev: 'Cím teszt funkció', alapAr: 900 }),
    });
    // Ez a cookie SZÁNDÉKOSAN nyers (nincs számlázási cím beállítva rajta,
    // ellentétben a getCompanySession() segédfüggvénnyel).
    const loginRes = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: server.adminPassword }),
    });
    const impersonateRes = await fetch(`${server.baseUrl}/api/admin/impersonate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: extractCookie(loginRes) },
      body: JSON.stringify({ companyKey: '18774455:01' }),
    });
    const cookieCimNelkul = extractCookie(impersonateRes);
    const res = await fetch(`${server.baseUrl}/api/payment/demo-pay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieCimNelkul },
      body: JSON.stringify({ featureKeys: ['CIMTESZT'] }),
    });
    assert.equal(res.status, 400, 'a fizetésnek el kell utasításra kerülnie hiányos számlázási cím esetén');
    const body = await res.json();
    assert.equal(body.error, 'MISSING_BILLING_ADDRESS');

    const profileRes = await fetch(`${server.baseUrl}/api/profile/features`, { headers: { Cookie: cookieCimNelkul } });
    const profileBody = await profileRes.json();
    assert.equal(profileBody.features.find((f) => f.key === 'CIMTESZT').kivalasztva, false, 'a funkció NEM aktiválódhatott');
  });

  await t.test('a demo-fizetés azonnal aktiválja a funkciót, valódi fizetési átjáró nélkül', async () => {
    const adminCookie = await getAdminCookie();
    await fetch(`${server.baseUrl}/api/admin/license/features/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ key: 'MERLEGELES', nev: 'Mérlegelés', alapAr: 1500 }),
    });
    const cookie = await getCompanySession();
    const res = await fetch(`${server.baseUrl}/api/payment/demo-pay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ featureKeys: ['MERLEGELES'] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.orderId);
    assert.ok(body.lejarat);
    // A teszt-környezetben nincs Brevo (email) beállítva — ez pontosan azt
    // a hibát reprodukálja, amit a fejlesztő élesben jelzett ("nem kaptam
    // emailt a számlával"): a fizetés sikeres, de a válasznak jeleznie
    // kell, hogy a számla-email küldése meghiúsult, ne csendben nyeljük el.
    assert.ok(body.emailWarning, 'a válasznak jeleznie kell, ha a demo-számla emailt nem sikerült kiküldeni');

    const profileRes = await fetch(`${server.baseUrl}/api/profile/features`, { headers: { Cookie: cookie } });
    const profileBody = await profileRes.json();
    assert.equal(profileBody.features.find((f) => f.key === 'MERLEGELES').kivalasztva, true);
  });

  await t.test('a fizetéshez folyamatos, helyes formátumú számlasorszám rendelődik, még sikertelen email-küldés esetén is', async () => {
    const adminCookie = await getAdminCookie();
    await fetch(`${server.baseUrl}/api/admin/license/features/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ key: 'PINTEGRACIO', nev: 'PIN integráció', alapAr: 1000 }),
    });
    const cookie = await getCompanySession();
    await fetch(`${server.baseUrl}/api/profile/email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email: 'teszt-cegvezeto@example.com' }),
    });
    const res1 = await fetch(`${server.baseUrl}/api/payment/demo-pay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ featureKeys: ['PINTEGRACIO'] }),
    });
    const body1 = await res1.json();
    await fetch(`${server.baseUrl}/api/profile/features/toggle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ featureKey: 'PINTEGRACIO', kivalasztva: false }),
    });
    const res2 = await fetch(`${server.baseUrl}/api/payment/demo-pay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ featureKeys: ['PINTEGRACIO'] }),
    });
    const body2 = await res2.json();

    const paymentsRes = await fetch(`${server.baseUrl}/api/admin/payments`, { headers: { Cookie: adminCookie } });
    const paymentsBody = await paymentsRes.json();
    const p1 = paymentsBody.payments.find((p) => p.orderId === `${body1.orderId}-PINTEGRACIO`);
    const p2 = paymentsBody.payments.find((p) => p.orderId === `${body2.orderId}-PINTEGRACIO`);
    assert.ok(p1.szamlaSorszam, 'a számlasorszámnak akkor is meg kell lennie, ha az email küldése meghiúsult');
    assert.match(p1.szamlaSorszam, /^\d{4}\/\d{6}$/, 'a formátumnak "ÉV/000000" alakúnak kell lennie');
    const [, sorszam1] = p1.szamlaSorszam.split('/');
    const [, sorszam2] = p2.szamlaSorszam.split('/');
    assert.equal(Number(sorszam2), Number(sorszam1) + 1, 'a második számlának eggyel nagyobb, folyamatos sorszámot kell kapnia');
  });

  await t.test('kosárszerűen, több funkció egyszerre is fizethető, egy közös összesítővel', async () => {
    const adminCookie = await getAdminCookie();
    await fetch(`${server.baseUrl}/api/admin/license/features/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ key: 'NTAK', nev: 'NTAK', alapAr: 2500 }),
    });
    await fetch(`${server.baseUrl}/api/admin/license/features/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ key: 'VONALKOD', nev: 'Vonalkód generálás', alapAr: 800 }),
    });
    const cookie = await getCompanySession();
    const res = await fetch(`${server.baseUrl}/api/payment/demo-pay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ featureKeys: ['NTAK', 'VONALKOD'] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.osszesen, 2500 + 800, 'az összesítőnek a két tétel együttes árát kell mutatnia');

    const profileRes = await fetch(`${server.baseUrl}/api/profile/features`, { headers: { Cookie: cookie } });
    const profileBody = await profileRes.json();
    assert.ok(profileBody.features.find((f) => f.key === 'NTAK').kivalasztva);
    assert.ok(profileBody.features.find((f) => f.key === 'VONALKOD').kivalasztva);
  });

  await t.test('a demo-előfizetés is havonta automatikusan megújul, myPOS-konfiguráció nélkül is, valódi terhelési kísérlet nélkül', async () => {
    const adminCookie = await getAdminCookie();
    // A lejáratot mesterségesen a múltba állítjuk.
    await fetch(`${server.baseUrl}/api/admin/license/grant`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ cegKulcs: '18774455', telephelyKod: '01', featureKey: 'MERLEGELES', ar: 1500, lejarat: '2020-01-01' }),
    });
    const runRes = await fetch(`${server.baseUrl}/api/admin/license/run-recurring-billing`, { method: 'POST', headers: { Cookie: adminCookie } });
    assert.equal(runRes.status, 200);

    const afterRes = await fetch(`${server.baseUrl}/api/admin/license/companies`, { headers: { Cookie: adminCookie } });
    const afterBody = await afterRes.json();
    const site = afterBody.companies.find((c) => c.cegKulcs === '18774455').telephelyek.find((t) => t.kod === '01');
    const merlegeles = site.licenses.find((f) => f.key === 'MERLEGELES');
    assert.equal(merlegeles.aktiv, true, 'a demo-tokennel rendelkező előfizetésnek MINDIG sikeresen meg kell újulnia, valódi terhelés nélkül');
    assert.ok(merlegeles.lejarat > '2020-01-01', 'a lejáratnak előre kellett kerülnie');
  });
});

test('myPOS-alapú fizetés — telephely-specifikus, ismétlődő funkció-előfizetés', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  const crypto = require('node:crypto');

  function signMyposFields(orderedFields) {
    const concatenated = orderedFields.map(([, v]) => String(v)).join('-');
    const base64Input = Buffer.from(concatenated, 'utf8').toString('base64');
    return crypto.sign('RSA-SHA256', Buffer.from(base64Input, 'utf8'), server.myposPrivateKey).toString('base64');
  }

  async function getCompanySession() {
    const loginRes = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: server.adminPassword }),
    });
    const adminCookie = extractCookie(loginRes);
    const impersonateRes = await fetch(`${server.baseUrl}/api/admin/impersonate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ companyKey: '18774455:01' }),
    });
    return extractCookie(impersonateRes);
  }
  async function getAdminCookie() {
    const loginRes = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: server.adminPassword }),
    });
    return extractCookie(loginRes);
  }

  await t.test('a fizetés indítása kártya-tokent kér az ismétlődő funkció-előfizetéshez', async () => {
    const adminCookie = await getAdminCookie();
    // Adjunk árat a funkciónak, hogy fizetőssé váljon.
    await fetch(`${server.baseUrl}/api/admin/license/features/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ key: 'NTAK', nev: 'NTAK', alapAr: 2500 }),
    });
    const cookie = await getCompanySession();
    const res = await fetch(`${server.baseUrl}/api/payment/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ cel: 'funkcio_telephely:01:NTAK' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.fields.CardTokenRequest, '1', 'ismétlődő előfizetésnél kártya-tokent kell kérni');
    assert.equal(body.osszeg, 2500);
  });

  await t.test('sikeres myPOS notify után a funkció aktiválódik a helyes telephelyen, kártya-tokennel elmentve', async () => {
    const cookie = await getCompanySession();
    const startRes = await fetch(`${server.baseUrl}/api/payment/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ cel: 'funkcio_telephely:01:NTAK' }),
    });
    const startBody = await startRes.json();
    const orderId = startBody.orderId;

    const notifyFields = [
      ['IPCmethod', 'IPCPurchaseNotify'], ['SID', 'teszt-sid-000000000010'],
      ['Amount', '2500.00'], ['Currency', 'HUF'], ['OrderID', orderId],
      ['IPC_Trnref', 'TESZT-TRN-001'], ['RequestSTAN', '1'], ['RequestDateTime', '20260722120000'],
    ];
    const signature = signMyposFields(notifyFields);
    const form = new URLSearchParams();
    for (const [k, v] of notifyFields) form.append(k, v);
    form.append('Signature', signature);
    form.append('CardToken', 'teszt-kartya-token-abc123');

    const notifyRes = await fetch(`${server.baseUrl}/api/payment/notify`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
    });
    assert.equal(notifyRes.status, 200);
    assert.equal(await notifyRes.text(), 'OK');

    const profileRes = await fetch(`${server.baseUrl}/api/profile/features`, { headers: { Cookie: cookie } });
    const profileBody = await profileRes.json();
    const ntak = profileBody.features.find((f) => f.key === 'NTAK');
    assert.equal(ntak.kivalasztva, true, 'a sikeres fizetés után a funkciónak aktívnak kell lennie');

    const adminCookie = await getAdminCookie();
    const adminRes = await fetch(`${server.baseUrl}/api/admin/license/companies`, { headers: { Cookie: adminCookie } });
    const adminBody = await adminRes.json();
    const site = adminBody.companies.find((c) => c.cegKulcs === '18774455').telephelyek.find((t) => t.kod === '01');
    const ntakAdmin = site.licenses.find((f) => f.key === 'NTAK');
    assert.equal(ntakAdmin.fizetosElofizetes, true, 'az adminnak jeleznie kell, hogy ez egy kártya-tokennel rendelkező, fizetett előfizetés');
  });

  await t.test('hibás aláírású notify hívás elutasításra kerül, semmi nem íródik jóvá', async () => {
    const notifyFields = [
      ['IPCmethod', 'IPCPurchaseNotify'], ['SID', 'teszt-sid-000000000010'],
      ['Amount', '2500.00'], ['Currency', 'HUF'], ['OrderID', 'HAMIS-ORDER-ID'],
      ['IPC_Trnref', 'HAMIS'], ['RequestSTAN', '1'], ['RequestDateTime', '20260722120000'],
    ];
    const form = new URLSearchParams();
    for (const [k, v] of notifyFields) form.append(k, v);
    form.append('Signature', 'ervenytelen-alairas-base64');
    const notifyRes = await fetch(`${server.baseUrl}/api/payment/notify`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
    });
    assert.equal(await notifyRes.text(), 'NOK');
  });

  await t.test('sikertelen havi újraterhelés esetén a funkció automatikusan letiltásra kerül', async () => {
    // Ebben a teszt-környezetben nincs valódi hálózati elérés a myPOS felé,
    // így a terhelési kísérlet garantáltan hibával elszáll — ez pontosan
    // a "sikertelen terhelés esetén letiltás" ágat gyakorolja be.
    const cookie = await getCompanySession();
    const beforeRes = await fetch(`${server.baseUrl}/api/profile/features`, { headers: { Cookie: cookie } });
    const beforeBody = await beforeRes.json();
    assert.ok(beforeBody.features.find((f) => f.key === 'NTAK').kivalasztva, 'az előző tesztből aktívnak kell lennie a kiindulási állapotban');

    const adminCookie = await getAdminCookie();
    // A lejáratot mesterségesen a múltba állítjuk, hogy a ciklus
    // "esedékesnek" lássa — ehhez visszavonjuk, majd újra kiosztjuk lejárt
    // dátummal (admin jogon, közvetlenül).
    await fetch(`${server.baseUrl}/api/admin/license/grant`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ cegKulcs: '18774455', telephelyKod: '01', featureKey: 'NTAK', ar: 2500, lejarat: '2020-01-01' }),
    });

    const runRes = await fetch(`${server.baseUrl}/api/admin/license/run-recurring-billing`, { method: 'POST', headers: { Cookie: adminCookie } });
    assert.equal(runRes.status, 200);

    const afterRes = await fetch(`${server.baseUrl}/api/admin/license/companies`, { headers: { Cookie: adminCookie } });
    const afterBody = await afterRes.json();
    const site = afterBody.companies.find((c) => c.cegKulcs === '18774455').telephelyek.find((t) => t.kod === '01');
    const ntak = site.licenses.find((f) => f.key === 'NTAK');
    assert.equal(ntak.aktiv, false, 'sikertelen (ez esetben hálózat nélküli) terhelés után a funkciónak le kell tiltódnia');

    const activityRes = await fetch(`${server.baseUrl}/api/admin/activity`, { headers: { Cookie: adminCookie } });
    const activityBody = await activityRes.json();
    assert.ok(activityBody.entries.some((e) => e.type === 'payment_recurring' && !e.ok), 'a sikertelen újraterhelésnek meg kell jelennie a tevékenység-naplóban');
  });
});

test('Admin — cég végleges törlése', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  async function getAdminCookie() {
    const loginRes = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: server.adminPassword }),
    });
    return extractCookie(loginRes);
  }

  await t.test('rossz megerősítő névvel a törlés elutasításra kerül, az adatok megmaradnak', async () => {
    const adminCookie = await getAdminCookie();
    const res = await fetch(`${server.baseUrl}/api/admin/company/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ cegKulcs: '18774455', megerositoNev: 'Rossz Név Kft.' }),
    });
    assert.equal(res.status, 400);

    // Az adatoknak érintetlennek kell maradniuk — az admin áttekintésben továbbra is szerepelnie kell.
    const overviewRes = await fetch(`${server.baseUrl}/api/admin/overview`, { headers: { Cookie: adminCookie } });
    const overviewBody = await overviewRes.json();
    assert.ok(overviewBody.companies.some((c) => c.cegKulcs === '18774455'), 'a cégnek továbbra is léteznie kell a rossz megerősítés után');
  });

  await t.test('helyes megerősítő névvel a törlés sikeres, és az adatok valóban eltűnnek', async () => {
    const adminCookie = await getAdminCookie();
    const res = await fetch(`${server.baseUrl}/api/admin/company/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ cegKulcs: '18774455', megerositoNev: 'Teszt Kávézó Kft.' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.backupDir, 'a válasznak tartalmaznia kell a biztonsági mentés helyét');

    const overviewRes = await fetch(`${server.baseUrl}/api/admin/overview`, { headers: { Cookie: adminCookie } });
    const overviewBody = await overviewRes.json();
    assert.ok(!overviewBody.companies.some((c) => c.cegKulcs === '18774455'), 'törlés után a cégnek már nem szabad szerepelnie az admin listában');

    // A törlés MAGA (mint admin-tevékenység) nyomon követhető kell maradjon.
    const activityRes = await fetch(`${server.baseUrl}/api/admin/activity`, { headers: { Cookie: adminCookie } });
    assert.equal(activityRes.status, 200);
    const activityBody = await activityRes.json();
    const deleteLogEntry = activityBody.entries.find((e) => e.type === 'company_deleted');
    assert.ok(deleteLogEntry, 'a törlésnek meg kell jelennie a tevékenység-naplóban');
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
