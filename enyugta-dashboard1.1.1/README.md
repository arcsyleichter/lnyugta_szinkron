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

## Hozzáférés-védelem — cégenkénti hozzáférési kód

Az adószám **önmagában nem titok** — Magyarországon bárki lekérdezheti egy
cég adószámát (NAV-os cégkereső, cégjegyzék). Ezért a bejelentkezéshez az
adószám mellé egy második, tényleg titkos, 6 jegyű **hozzáférési kódot** is
meg kell adni.

Minden cég automatikusan kap egy véletlen kódot, amint először megjelenik a
rendszerben (induláskor a meglévőknek, első szinkronkor az újaknak) —
`data/access-codes.json`-ban tárolva (ez a fájl `.gitignore`-olt, tehát
minden telepítés a saját, egyedi kódjait generálja, nem kerül semmi
kódszöveg a git repóba).

**A kódok megtekintése / kiadása a cégeknek:** az admin panelen (lásd lent)
minden cég sorában látszik a saját kódja, és egy ⟳ gombbal bármikor
újrageneráltatható (pl. ha kiszivárgott) — a régi kód ilyenkor azonnal
érvénytelenné válik. Ezt a kódot kell eljuttatni a cég képviselőjéhez
(telefonon, e-mailben, vagy akár az androidos appban is meg lehetne majd
jeleníteni — ez utóbbi már az androidos oldal bővítése lenne).

A **`data/companies/`** mappa (a tényleges forgalmi adatok) így önmagában
sosem elég valaki adataihoz — a kettő (adószám + kód) együtt szükséges.

## Cikktörzs kétirányú szinkron

A "Cikktörzs" menüpontban a cégek (vagy az admin, rájuk belépve) módosíthatják
a termékeik nevét, árát, ÁFA kulcsát, csoportját, vonalkódját — egyenként, egy
egész csoportra vonatkozó **tömeges árváltoztatással** (%-os vagy fix
összegű), vagy **CSV (Excel-kompatibilis) importtal**.

### Miért nem azonnal élesek a módosítások?

A cégek `.db` fájljait az androidos alkalmazás rendszeresen **teljes
egészében felülírja** egy friss szinkronnal — ha a weben tett módosítás
közvetlenül ebbe a fájlba írna, a következő szinkron egyszerűen eltüntetné.
Ezért minden módosítás egy külön, cégenkénti **"függő módosítás" sorba**
kerül (`data/product-changes.db`), ami sosem érintkezik közvetlenül a
szinkronizált adatbázissal.

**Ez azt jelenti, hogy ehhez a fejlesztéshez az androidos oldalt is bővíteni
kell** — enélkül a weben tett módosítás csak "függőben" marad, sosem jelenik
meg ténylegesen a pénztárgépen. A szerver oldali fele készen áll; az
androidos fejlesztőnek (vagy akinek hozzáfér az L-NYUGTA GO forráskódjához)
ezt a szerződést kell implementálnia, **minden szinkron ELŐTT**:

```
GET /api/sync/pending-changes?adoszam=<a cég adószáma>
Header: x-api-key: <ugyanaz a kulcs, mint a feltöltésnél>
```

Válasz:
```json
{ "items": [
  { "id": 1, "type": "cikk_upsert", "payload": { "megnevezes": "Espresso", "me": "Darab", "bruttoar": 700, "afakod": "5%", "csoportNev": "Kávézó kínálat", "vonalkod": null } }
] }
```

Az androidos appnak ezeket a `payload`-okat kell beírnia a saját `cikkt` /
`cikkcsop` tábláiba (upsert `megnevezes` szerint, mivel az egyedi), **mielőtt**
elküldi a saját friss adatbázisát a megszokott `/api/sync/upload` végpontra.

**Nincs szükség külön visszaigazoló hívásra** — a szerver a következő
feltöltésben automatikusan felismeri, hogy a kért ár/ÁFA-kód már megegyezik
a ténylegesen beérkezett adattal, és a módosítást "leszinkronizálva"
állapotba teszi. Ha egy módosítás egy még nem létező cikkre vonatkozik
(vadonatúj termék), a rendszer ezt is jelzi ("Új — függőben"), amíg az
androidos oldal ténylegesen létre nem hozza.

### Teszteléshez: `scripts/simulate_android_pull.py`

Mielőtt az androidos oldal ténylegesen implementálja a fenti szerződést, ezzel
a szkripttel ki lehet próbálni a teljes kört — pontosan azt csinálja, amit
majd a telefonnak kell: lekérdezi a függő módosításokat, és ha megadsz egy
helyi `.db` fájlt, azokat ténylegesen alkalmazza is rá (upsert `cikkt` /
`cikkcsop` táblákba).

```bash
export SYNC_API_KEY="a szerver data/.secrets.json-jában lévő kulcs"

# csak megnézni, mi van függőben:
python3 scripts/simulate_android_pull.py --url https://lnyugta-szinkron-1.onrender.com --adoszam 18774455

# a teljes kör: lekérdezés + helyi alkalmazás egy .db másolatra
python3 scripts/simulate_android_pull.py --url https://lnyugta-szinkron-1.onrender.com \
  --adoszam 18774455 --apply-to teszt-masolat.db
```

Utána a módosított fájlt visszatöltve az `upload_sync.py`-jal, a szerver a
következő feltöltésben automatikusan "leszinkronizálva" állapotba teszi a
teljesült módosításokat — nincs szükség külön visszaigazoló hívásra.

### Excel (CSV) import/export

Igazi bináris `.xlsx` helyett **CSV-t** használ a rendszer (UTF-8 BOM-mal,
hogy Excelben az ékezetek is helyesen jelenjenek meg) — ez nulla
függőséggel, natívan megnyitható/menthető Excelben, gyakorlatilag ugyanaz a
felhasználói élmény. Oszlopok: `Cikknév, Csoport, Egység, Bruttó ár, ÁFA kód,
Vonalkód` (a `Cikknév`, `Bruttó ár` és `ÁFA kód` kötelező).

- **Minta letöltése** — pár példasorral induló sablon.
- **Jelenlegi törzs letöltése** — a cég most élő cikktörzse, szerkeszthető
  formában (pl. tömeges árfrissítéshez Excelben, majd visszatöltve).
- **Importálás** — a feltöltött CSV minden sorához létrehoz egy függő
  módosítást.

## Készlet-nyilvántartás (bevételezés alapú)

A "Készlet" menüpontban rögzíthető, mikor mennyi áru érkezett be (cikk,
mennyiség, opcionálisan beszerzési ár és szállító) — ebből és a már
szinkronizált eladási adatokból (`nytet`) számolódik ki a jelenlegi készlet:

```
készlet = összes eddig bevételezett mennyiség − összes eddig eladott mennyiség
```

**Fontos architekturális döntés:** a bevételezések **külön fájlban**
(`data/stock.db`) tárolódnak, NEM a cégek szinkronizált `.db` fájljaiban —
mert azokat az androidos app minden szinkronkor **teljesen felülírja**. Ha a
bevételezés a szinkronizált fájlban lenne, minden feltöltés törölné. Így a
`data/stock.db` sosem érintkezik az androidos szinkronnal, tisztán a webes
felület írja/olvassa, cégenként elkülönítve (`company_key` oszloppal).

Mivel ez egy vadonatúj nyilvántartás, kezdetben minden cégnél negatív
készletet fog mutatni, amíg nem rögzítitek az aktuális, tényleges
raktárkészletet egy kezdő ("nyitó") bevételezésként minden cikkre — ezután
már pontosan követi a valós állapotot.

### Mit NEM tud (egyelőre)

- Nincs kiadás/leltárkorrekció rögzítése, csak bevételezés — a fogyás
  kizárólag az eladásokból (nytet) számolódik. Ha kell selejtezés/leltár-
  korrekció is, ez egy hasonló, "negatív irányú" tábla/végpont hozzáadásával
  bővíthető.
- Nincs cikktörzs-szerkesztés (pl. új termék felvétele, ár módosítása) — a
  termékválasztó a meglévő `cikkt` törzsből dolgozik, csak olvasásra
  (`GET /api/products/master`). Ha ez is kell (különösen, hogy a
  pénztárgépen is érvényesüljön egy itt módosított ár), az egy külön,
  kétirányú szinkron-tervet igényel az androidos alkalmazással együtt.

## Admin panel

A bejelentkező oldal alján lévő "Admin belépés" linkkel egy külön, jelszavas
bejelentkezéssel érhető el egy admin nézet, ami **minden** regisztrált céget
átfog:

- **Cégek listája** — mindegyik utolsó szinkron időpontjával, forrásával,
  méretével, és egy **"Megnyitás"** gombbal, ami rögtön beléptet az adott cég
  normál dashboardjába (nem kell ismerni az adószámát). Innen egy "‹ Admin
  panel" linkkel bármikor vissza lehet lépni az admin nézetbe.
- **NTAK állapot — minden cégre** — azoknál a cégeknél, akiknek van NTAK
  adata, összesítve látszik, hány adatküldés volt sikeres / részben sikeres /
  hibás / befogadva, plusz a legutóbbi probléma időpontja és típusa. (Ez a
  nézet szándékosan cégek közötti — az admin mindenkinek a NTAK-státuszába
  belelát, hogy gyorsan ki lehessen szűrni, kinél van gond a küldéssel.)
- **Tevékenység-napló** — minden esemény cégenként és típusonként
  csoportosítva, nem ömlesztve: céges bejelentkezés, admin bejelentkezés,
  admin műveletek (cég megnyitása, kód újragenerálás/kiküldés), szinkron
  feltöltés, bevételezés rögzítése/törlése — sikeres *és* sikertelen
  próbálkozás is (pl. rossz jelszó/kód, hibás fájl). Felül egy cégenkénti
  összesítő táblázat mutatja, hány esemény volt kinél és mikor történt az
  utolsó; egy cégre kattintva rögtön rá is szűr. Alul cég és típus szerint
  tovább szűrhető, részletes, időrendi lista.

### Hozzáférési kód kiküldése emailben (Brevo)

A Cégek táblázat minden sorában van egy Email mező és egy **Küldés** gomb —
erre kattintva a rendszer a Brevo tranzakciós email API-ján keresztül
elküldi a cég adószámát és aktuális hozzáférési kódját a megadott címre.
Az email mező alapból megpróbálja kitölteni a cég saját androidos
adatbázisában tárolt email címet (`szallitot.email`), ha van ilyen — ezt
felül lehet írni, és amit egyszer elküldtél, azt a rendszer megjegyzi
legközelebbre is.

Ehhez egy [Brevo](https://www.brevo.com) fiók és API-kulcs szükséges,
környezeti változóként beállítva (Render Environment fülön, vagy helyben
`export`-tal):

```bash
BREVO_API_KEY=xkeysib-...          # Brevo fiók → Settings → API Keys
BREVO_SENDER_EMAIL=info@ceged.hu   # Brevo-ban ELLENŐRZÖTT (verified) feladó cím
BREVO_SENDER_NAME="L-NYUGTA rendszer"   # opcionális, ez lesz a feladó neve
```

**Fontos:** a `BREVO_SENDER_EMAIL`-nek egy a Brevo fiókodban **ellenőrzött
(verified) feladó email címnek** kell lennie (Brevo → Settings → Senders &
IP) — enélkül a Brevo API elutasítja a küldést. Amíg ezek a változók
nincsenek beállítva, az admin panel egy sárga figyelmeztető sávot mutat, és
a "Küldés" gombok inaktívak — ezt nem kell külön lekezelni, a rendszer
magától felismeri.

Az admin jelszó ugyanúgy generálódik és tárolódik, mint a `SESSION_SECRET` /
`SYNC_API_KEY` — első induláskor a konzol kiírja, és a `data/.secrets.json`-ban
van, vagy env változóként (`ADMIN_PASSWORD`) is rögzíthető, hogy újraindítás
után se változzon.

**Fontos:** ez egy jelszóval védett, de egyetlen, közös admin-fiók — nincsenek
külön admin-felhasználók/naplózott admin-nevek. Ha többen kezelik majd a
rendszert, és nyomon kell követni, *ki* nyitott meg egy céget, ez a rész
bővítésre szorul (pl. named admin accounts).

## Biztonsági megjegyzések

- A bejelentkezés adószám + hozzáférési kód párossal történik (lásd fent) —
  ez már nem sebezhető pusztán azzal, hogy valaki ismeri egy cég adószámát.
  Ha ez éles, nyilvánosan elérhető szolgáltatás lesz, HTTPS mögé tétele
  továbbra is kötelező (különben a session-cookie és a bejelentkezéskor
  küldött kód is lehallgatható).
- A `/api/sync/upload` és `/api/sync/companies` végpontokat **csak** a
  titkos `x-api-key` védi — ezt tartsd titokban, és HTTPS-en keresztül
  küldd, különben a kulcs lehallgatható. Lásd fentebb a cégenkénti kulcsra
  vonatkozó megjegyzést is.
- A `data/companies/*.db` fájlok az éles pillanatképek — érdemes
  időszakosan biztonsági mentést készíteni a teljes `data/companies/`
  mappáról.
