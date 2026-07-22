'use strict';
// Önálló, semmilyen meglévő fájltól nem függő teszt-adatbázis építő —
// az automatizált tesztekhez. Egy MINIMÁLIS, de érvényes cég-adatbázist
// hoz létre néhány mintasorral, hogy a végpontok (termékek, nyugták,
// készlet) valós adaton is tesztelhetők legyenek.

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');

function buildTestCompanyDb(outPath, { adoszam, nev, varos = 'Teszt Város', cim = 'Teszt utca 1.' }) {
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  const db = new DatabaseSync(outPath);
  db.exec(`
    CREATE TABLE szallitot (cegid TEXT, nev TEXT, adoszam TEXT, varos TEXT, cim TEXT);
    CREATE TABLE nyfej (
      id INTEGER PRIMARY KEY, cegid TEXT, bsz TEXT, keltdat TEXT,
      fizmod TEXT, bruttokp REAL, bruttoafr REAL, bruttokartya REAL,
      storno TEXT, stornozott TEXT, umdate TEXT, sznev TEXT,
      szadoszam TEXT, kuldstat TEXT, ellenorzott TEXT,
      rmsfelduuid TEXT, uuid TEXT, rendkezdatum TEXT, ntakzarasid INTEGER
    );
    CREATE TABLE nytet (
      bsz TEXT, sor INTEGER, cikkszam TEXT, megnevezes TEXT, me TEXT,
      menny REAL, bruttoar REAL, afakod TEXT, sorbrutto REAL
    );
    CREATE TABLE cikkt (
      azon TEXT, csopazon TEXT, megnevezes TEXT, me TEXT,
      bruttoar REAL, afakod TEXT, vonalkod TEXT, status TEXT, afakodelv TEXT,
      fokatjson TEXT, alkatjson TEXT, ntakszorzo REAL, ntakme TEXT, gongyolegazon TEXT
    );
    CREATE TABLE cikkcsop (azon TEXT, megnevezes TEXT, status TEXT);
    CREATE TABLE ntaknapzaras (
      id INTEGER PRIMARY KEY, targynap TEXT, nyitas TEXT, zaras TEXT,
      borravalo REAL, naptipus TEXT, uuid TEXT
    );
  `);

  db.prepare('INSERT INTO szallitot (cegid, nev, adoszam, varos, cim) VALUES (?, ?, ?, ?, ?)')
    .run(adoszam, nev, adoszam, varos, cim);

  db.prepare("INSERT INTO cikkcsop (azon, megnevezes, status) VALUES ('1', 'Italok', 'A')").run();

  const termekek = [
    ['Espresso', 700, '27%'],
    ['Cappuccino', 950, '27%'],
    ['Ásványvíz', 500, '27%'],
  ];
  const insCikk = db.prepare(
    'INSERT INTO cikkt (azon, csopazon, megnevezes, me, bruttoar, afakod, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  termekek.forEach(([nev2, ar, afa], i) => insCikk.run(String(i + 1), '1', nev2, 'db', ar, afa, 'A'));

  // Néhány nyugta, az elmúlt 5 napra elosztva, hogy a lekérdezések
  // (forgalom, termékek, nyugták listája) valós adatot lássanak.
  // Az ellenorzott/kuldstat/uuid mezők is fel vannak töltve, hogy az
  // NTAK-fallback (amikor nincs külön ntakrms tábla) is tesztelhető
  // legyen valós, ellenőrzött adaton.
  const insNyfej = db.prepare(`
    INSERT INTO nyfej (id, cegid, bsz, keltdat, fizmod, bruttokp, bruttoafr, bruttokartya, storno, rendkezdatum, ellenorzott, kuldstat, uuid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'N', ?, ?, ?, ?)
  `);
  const insNytet = db.prepare(`
    INSERT INTO nytet (bsz, sor, cikkszam, megnevezes, me, menny, bruttoar, afakod, sorbrutto)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let id = 1;
  for (let nap = 0; nap < 5; nap++) {
    const datum = new Date(Date.now() - nap * 86400000).toISOString().slice(0, 10);
    for (let sorsz = 0; sorsz < 3; sorsz++) {
      const bsz = `${datum.replace(/-/g, '')}-${sorsz + 1}`;
      const fizmod = sorsz % 2 === 0 ? 'kp' : 'bankkártya';
      const osszeg = 700 + sorsz * 250;
      insNyfej.run(
        id, '1', bsz, datum, fizmod,
        fizmod === 'kp' ? osszeg : 0, 0, fizmod === 'bankkártya' ? osszeg : 0,
        `${datum} ${10 + sorsz}:00:00`, 'TELJESEN_SIKERES', 'OK', `uuid-${id}`
      );
      insNytet.run(bsz, 1, '1', termekek[sorsz % termekek.length][0], 'db', 1, osszeg, '27%', osszeg);
      id++;
    }
  }

  db.close();
}

module.exports = { buildTestCompanyDb };
