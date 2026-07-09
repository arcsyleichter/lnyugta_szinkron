# L-NYUGTA élő értékesítési nézegető

Webes felület **több cég** L-NYUGTA GO androidos alkalmazásának adataihoz
egyszerre: napi árbevétel, cikkenkénti eladások, fizetési mód és ÁFA szerinti
bontás, kereshető nyugtalista — cégenként elkülönítve, ugyanazon a szerveren.

A szerver **nulla külső npm‑függőséggel** működik — a beépített `node:sqlite`
modult használja, ezért egyszerűen telepíthető bármilyen Node.js‑t futtatni
képes gépen vagy VPS‑en.

## Gyors indítás

```bash
node --version   # kell: 22.5.0 vagy újabb (ajánlott: 22 LTS / 24 LTS)
node server.js
```

Ezután a felület elérhető: `http://<szerver-cím>:3000`

Belépéskor a cég adószámát kell megadni (kötőjelekkel vagy anélkül is jó,
pl. `27129430-2-41` vagy `27129430241`) — elég az első 8 számjegy, ez
azonosítja egyértelműen a céget.

Az első induláskor a program generál egy `data/.secrets.json` fájlt, benne
egy munkamenet-titkosító kulccsal és egy **szinkron API-kulccsal**. A konzol
kiírja ez utóbbit induláskor — erre lesz szükség az androidos oldal
beállításához (lásd lent). Éles üzemben érdemes ezeket környezeti
változóként rögzíteni, hogy szerver-újraindításkor ne változzanak:

```bash
export SESSION_SECRET="egy-hosszú-véletlen-string"
export SYNC_API_KEY="egy-másik-hosszú-véletlen-string"
export PORT=3000
node server.js
```

## Több cég egyszerre — hogyan tárolja az adatokat

Minden cégnek **saját, önálló SQLite fájlja** van a `data/companies/`
mappában, az adószám első 8 számjegyével elnevezve:

```
data/companies/
  27129430.db     ← PACHIRA GROUP Kft. (27129430-2-41)
  18774455.db     ← Corvin Presszó Kft. (18774455-1-42)
  24681357.db     ← Zöld Kanál Vendéglő Kft. (24681357-2-09)
  ...              ← akár több száz további cég
```

A szerver induláskor beolvassa **mindegyik** fájl `szallitot` tábláját (csak
a cégnevet, adószámot, címet — nem a teljes forgalmi adatot), és ebből épít
egy gyors, memóriában tartott indexet. Bejelentkezéskor ebben az indexben
keres, nem kell minden fájlt megnyitnia — így akár több száz cég esetén is
gyors marad a belépés.

A tényleges lekérdezések (árbevétel, nyugták stb.) mindig a bejelentkezett
munkamenethez tartozó *egyetlen* cég `.db` fájljából jönnek — egy cég soha
nem lát rálátást egy másik cég adataira. A ténylegesen megnyitott adatbázis-
kapcsolatokat a szerver egy 40 elemű, "legrégebben használt" (LRU) gyorsí-
tótárban tartja, hogy több száz cég esetén se maradjon korlátlan sok fájl
egyszerre nyitva memóriában.

**Új cég hozzáadása** kétféleképp történhet, szerver-újraindítás nélkül:
1. **Automatikusan**, első szinkronizáláskor (lásd lent) — a szerver a
   feltöltött `.db` fájl `szallitot` tábla adószámát elmenti, és attól kezdve
   ismeri a céget.
2. **Kézzel**: egy `.db` fájl bemásolása a `data/companies/` mappába, a fájl
   nevét az adószám első 8 számjegyére állítva (pl. `12345678.db`) — a
   szerver csak induláskor szkenneli be a mappát automatikusan, futás közben
   berakott fájlt egy `POST /api/sync/upload` hívás (vagy egy egyszerű
   újraindítás) tud "felfedeztetni" vele.

## Hol futtasd?

Mivel a felület **élő, folyamatosan frissülő** adatot mutat és egy háttér-
folyamatnak (a szinkron végpontnak) mindig elérhetőnek kell lennie, statikus
tárhely (pl. GitHub Pages, megosztott PHP-hosting) nem alkalmas rá. Amire
szükség van: egy gép, amin a Node.js folyamatosan fut.

### Telepítés GitHubra + Renderre

**1. GitHub repó létrehozása és feltöltés**

```bash
cd enyugta-dashboard
git init
git add .
git commit -m "L-NYUGTA nézegető — kezdeti feltöltés"
```

Hozz létre egy új, üres repót a [github.com/new](https://github.com/new)
oldalon (README/.gitignore nélkül, mert azok már megvannak), majd:

```bash
git remote add origin https://github.com/<felhasznalonev>/<repo-nev>.git
git branch -M main
git push -u origin main
```

**2. Render szolgáltatás létrehozása**

A repóban van egy `render.yaml` Blueprint fájl, ami előre beállítja a
szolgáltatást (Node.js web service, ingyenes csomag, automatikusan generált
`SESSION_SECRET` és `SYNC_API_KEY` környezeti változók):

1. Jelentkezz be a [render.com](https://render.com)-ra (a GitHub-fiókoddal is lehet).
2. **New +** → **Blueprint** → válaszd ki a most feltöltött GitHub repót.
3. Render felismeri a `render.yaml`-t, és felkínálja a `l-nyugta-dashboard`
   nevű web service-t — kattints **Apply**-ra.
4. Néhány perc build után megkapod az élő URL-t (`https://l-nyugta-dashboard-xxxx.onrender.com`).

Ha nem akarsz Blueprint-et használni, kézzel is beállítható: **New +** →
**Web Service** → a repó kiválasztása → *Runtime: Node*, *Build Command:*
(üresen hagyható), *Start Command:* `node server.js`, majd a **Environment**
fülön vedd fel a `SESSION_SECRET` és `SYNC_API_KEY` változókat (bármilyen
hosszú, véletlenszerű string lehet).

**⚠️ Fontos korlátozás ingyenes Render csomagon:** a szerver a cégek
adatbázisait helyi fájlokban (`data/companies/*.db`) tárolja, az ingyenes
webszolgáltatáshoz viszont **nem lehet tartós lemezt csatolni** — a
fájlrendszer minden újraindításkor (15 perc tétlenség után automatikus
leállás, vagy egy új feltöltés) visszaáll a GitHub-repóban lévő állapotra.
Ez azt jelenti:

- a repóba feltöltött 3 kiinduló cég (a valódi + a 2 teszt cég) **mindig
  megmarad**, mert a git repóból töltődik be minden induláskor;
- de az androidos alkalmazásból időközben **beérkezett szinkronok** (új
  cégek regisztrálása, frissített forgalmi adatok) **elvesznek** a
  szolgáltatás leállásakor/újraindulásakor.

Ez demózáshoz és teszteléshez tökéletesen megfelelő. Ha később éles, folyamatosan
szinkronizáló rendszer lesz belőle,válts **Starter** (vagy magasabb) csomagra,
és vedd ki a kommentből a `render.yaml` alján lévő `disk:` blokkot — az így
csatolt tartós lemez megőrzi a `data/` mappa tartalmát újraindítások között is.
(A `SESSION_SECRET` / `SYNC_API_KEY` értékek a Render környezeti változóiban
tárolódnak, ezek — a lemeztől függetlenül — mindig megmaradnak újraindítás
után is, tehát a bejelentkezések és a szinkron-kulcs nem változik meg magától.)

### Egyéb lehetőségek

- **Kis VPS** (pl. Hetzner, DigitalOcean) — `node server.js`-t egy
  `systemd` service-ként vagy `pm2`-vel futtatva, Nginx reverse proxy-val
  és Let's Encrypt tanúsítvánnyal https-esítve. Ez ad igazán tartós,
  korlátlan helyi lemezt, ingyenes csomag nélküli kompromisszumok nélkül.
- Ha egyelőre csak a helyi hálózaton, egy géppel akarod tesztelni: bármely
  Windows/Mac/Linux gép, amin fut a Node és nyitva van a `3000`-es port a
  routeren, már működik.

## Adatmodell — amit a felület használ

Cégenként (tehát `.db` fájlonként) a nézegető ezekre a táblákra épül:

- **`szallitot`** — a cég saját adatai (`nev`, `adoszam`, `varos`, `cim`) —
  ez azonosítja a fájlt, és ez alapján lehet vele bejelentkezni.
- **`nyfej`** — nyugtafejek: dátum (`keltdat`), fizetési mód (`fizmod`),
  bruttó összegek fizetési módonként (`bruttokp`, `bruttoafr`,
  `bruttokartya`), sztornó jelzők.
- **`nytet`** — nyugtatételek: cikk megnevezése, mennyiség, ÁFA kulcs
  (`afakod`), nettó/ÁFA/bruttó soronkénti összegek, a hozzá tartozó nyugta
  száma (`bsz`).

### API végpontok

| Végpont | Leírás |
|---|---|
| `POST /api/auth/login` | belépés adószámmal (a hozzá tartozó cég `.db`-jét választja ki a munkamenethez) |
| `GET /api/summary` | árbevétel, nyugtaszám, átlagkosár + fizetési mód bontás — a bejelentkezett cégre |
| `GET /api/revenue-series` | napi/heti/havi árbevétel idősor |
| `GET /api/vat-breakdown` | árbevétel ÁFA kulcsok szerint |
| `GET /api/products` | cikkenkénti eladás (kereshető, lapozható) |
| `GET /api/receipts` | nyugtalista (kereshető, szűrhető, lapozható) |
| `GET /api/receipt?bsz=...` | egy nyugta tételes részletei |
| `GET /api/sync/status` | a bejelentkezett cég utolsó szinkron időpontja |
| `POST /api/sync/upload` | **ide küldi az android app a friss `.db` fájlt, cégenként** (lásd lent) |
| `GET /api/sync/companies` | admin-áttekintés: mely cégek vannak regisztrálva (x-api-key-jel védett) |

## Élő összeköttetés az androidos alkalmazással — több száz céggel folyamatosan

A telefonon lévő SQLite fájl önmagában nem érhető el a neten, ezért az
"élő" adat úgy valósul meg, hogy **minden cég androidos appja időnként
elküldi a saját adatbázisát** a szerver `/api/sync/upload` végpontjára. A
webes felület mindig az adott cég legutóbb kapott pillanatképéből dolgozik,
és percenként automatikusan újratölti a nézeteket, illetve a bal alsó
sarokban mutatja, mikor volt az utolsó szinkron.

**Ez a rész szerver oldalon készen áll, akár több száz cégre egyszerre** —
androidos oldalon még nincs implementálva, ahhoz az app kódjához kellene
hozzáférni. A szerződés, amit az androidos fejlesztőnek (vagy egy egyszerű
ütemezett scriptnek a telefonon/egy gatewayen) implementálnia kell **minden
egyes cég eszközén**:

```
POST /api/sync/upload?adoszam=<a cég adószáma>
Header: x-api-key: <a data/.secrets.json-ban generált vagy SYNC_API_KEY-ként beállított kulcs>
Header: x-adoszam: <a cég adószáma>   (alternatíva a query paraméter helyett)
Content-Type: application/octet-stream
Body: az L-NYUGTA GO .db fájl teljes, nyers tartalma
```

Az `x-adoszam` (vagy `adoszam` query paraméter) mondja meg a szervernek,
**melyik** cég adatbázisát cseréli le a feltöltés — csak annak a cégnek a
fájlját írja felül, a többi cég adatait nem érinti. Ha ez egy eddig ismeretlen
adószám, a cég **automatikusan regisztrálódik**, szerver-újraindítás nélkül —
ez teszi lehetővé, hogy akár több száz különböző cég eszköze szinkronizáljon
folyamatosan, előzetes admin-beavatkozás nélkül, amíg mindegyik ismeri a közös
`x-api-key`-t.

Sikeres válasz: `200 OK`,
`{"ok":true,"companyKey":"...","newCompany":false,"lastSync":"...","bytes":...}`.

Ezt hívhatja:
- egy Android WorkManager-feladat az appban (pl. 5–15 percenként, wifin),
  minden telepítésen a saját cég adószámával paraméterezve,
- vagy egy egyszerű háttérszkript, ha a telefonon fut valamilyen
  automatizálás (pl. Tasker HTTP Request akció), ami elküldi a helyi
  adatbázis-fájlt.

### Teszteléshez: `scripts/upload_sync.py`

Mielőtt az androidos oldal bekötésre kerül, a `scripts/upload_sync.py`
szkripttel kézzel / szkriptből is ki lehet próbálni a feltöltést — pontosan
azt csinálja, amit majd a telefon fog. Nincs függősége, csak Python 3.8+:

```bash
export SYNC_API_KEY="a szerver data/.secrets.json-jában lévő kulcs"
python3 scripts/upload_sync.py \
  --url https://l-nyugta-dashboard.onrender.com \
  --db data/companies/18774455.db \
  --adoszam 18774455
```

Folyamatos, időzített szinkron szimulálásához (pl. hogy lásd élőben
frissülni a dashboardot): add hozzá a `--interval 60` kapcsolót — ekkor a
szkript percenként újraküldi ugyanazt a fájlt, Ctrl+C-ig.

Amíg ez nincs bekötve, a felület **"Szinkronizáció" menüpontjában** lévő
"Szinkron lekérdezése most" gomb csak visszajelzi, hogy nincs élő
kapcsolat, és a jelenleg feltöltött pillanatkép aktív — így a demó
teljes egészében a most kapott adatbázisokkal működik, de a bővítéshez
semmit nem kell átírni, csak az androidos oldalt kell rákötni a fenti
végpontra, minden cégnél a saját adószámával.

### Biztonsági megjegyzés a szinkron-kulcshoz

Jelenleg **egyetlen, közös `x-api-key`** hitelesíti az összes cég
feltöltését (ezt kell minden androidos telepítésnek ismernie). Ez
egyszerű és jól skálázódik több száz eszközre, de azt jelenti, hogy ha ez a
kulcs kiszivárog, bárki bármelyik cég adatbázisát felül tudja írni. Ha ez
éles, sok külső ügyfelet kiszolgáló rendszer lesz, érdemes később
**cégenkénti egyedi szinkron-kulcsra** áttérni (pl. a `data/sync-meta.json`-ban
tárolva céges kulcsokat, és az upload-endpointban a globális kulcs helyett
azt ellenőrizni) — a jelenlegi kód szerkezete ezt könnyen befogadja, csak
a kulcsellenőrzés egy sorát kell lecserélni.

## Teszteléshez: két kitalált cég, élesben viselkedve

A `data/companies/` mappában két kitalált (fiktív) céges teszt-adatbázis is
ott van a valódi mellett, **pontosan úgy működnek, mint egy éles cég** —
nincs szükség fájl-cserére, egyszerűen csak be kell jelentkezni az
adószámukkal:

- **Corvin Presszó Kft.** — adószám: `18774455-1-42` (kávézó, ~900 nyugta, kb. 45 napnyi forgalom)
- **Zöld Kanál Vendéglő Kft.** — adószám: `24681357-2-09` (étterem, ~600 nyugta, kb. 45 napnyi forgalom)

Mivel mindhárom cég (a valódi + a két teszt) egyszerre, párhuzamosan él a
szerveren, bármikor ki- és bejelentkezhetsz köztük anélkül, hogy bármit
kicserélnél a lemezen — pont úgy, ahogy egy valódi több-céges éles
rendszeren történne.

A teszt-adatbázisokat a `scripts/generate-test-db.js` szkript generálta —
ha még több / más teszt cég kell, ez a szkript szabadon módosítható és
újra lefuttatható (`node scripts/generate-test-db.js`), az eredmény
`.db` fájlokat pedig a `data/companies/` mappába kell másolni
(adószám-alapú néven, pl. `data/companies/12345678.db`).

## Adatbázis-méret (git / GitHub miatt)

A `data/companies/*.db` fájlokat szándékosan **20 MB alatt** tartjuk, hogy
kényelmesen elférjenek egy GitHub repóban (GitHub soft-limitje 50 MB/fájl
körül kezd figyelmeztetni, keményen 100 MB-nál tilt). A valódi PACHIRA
GROUP adatbázis eredetileg ~26,7 MB volt — ezt letisztítottuk: kivettük
belőle az `ntakrms` tábla NTAK-diagnosztikai nyers JSON-naplóit és a
`nyfej.rmsjson` mezőt, mert ezeket a szerver egyik lekérdezése sem
használja, majd `VACUUM`-mal tömörítettük a fájlt. Ez ~7,9 MB-ra csökkentette
a méretet, a nyugták, tételek, cikkek és az árbevétel-összegek bit-pontosan
ugyanazok maradtak.

Ha egy jövőbeli szinkron (androidos feltöltés) ismét nagyra hízna egy cég
adatbázisát, ugyanezt a tisztítást bármikor le lehet futtatni rajta:

```js
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/companies/<kulcs>.db', { readOnly: false });
db.exec('DELETE FROM ntakrms');
db.exec("UPDATE nyfej SET rmsjson = NULL WHERE rmsjson IS NOT NULL AND rmsjson != ''");
db.exec('VACUUM');
db.close();
```

## Biztonsági megjegyzések

- A bejelentkezés kizárólag az adószámra épül — ez megfelel a kérésnek
  ("adja meg az adószámot és látja az adatokat"), de nem jelent erős
  hitelesítést. Ha ez éles, nyilvánosan elérhető szolgáltatás lesz, érdemes
  HTTPS mögé tenni (kötelező, mert a session-cookie különben lehallgatható)
  és megfontolni egy második tényezőt (pl. e-mailben küldött kód).
- A `/api/sync/upload` és `/api/sync/companies` végpontokat **csak** a
  titkos `x-api-key` védi — ezt tartsd titokban, és HTTPS-en keresztül
  küldd, különben a kulcs lehallgatható. Lásd fentebb a cégenkénti kulcsra
  vonatkozó megjegyzést is.
- A `data/companies/*.db` fájlok az éles pillanatképek — érdemes
  időszakosan biztonsági mentést készíteni a teljes `data/companies/`
  mappáról.
