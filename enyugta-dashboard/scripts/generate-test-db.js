'use strict';
// Ideiglenes segédszkript: egy meglévő ENYUGTA SQLite adatbázis sémáját lemásolva
// generál egy új, teszt-céges, kitalált adatokkal feltöltött adatbázist.
// Nem kerül be a végleges projektbe, csak egyszeri generáláshoz kell.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SRC_PATH = path.join(__dirname, 'current.db');

function pad(n, len) { return String(n).padStart(len, '0'); }

function buildDb(outPath, company, products, opts) {
  const src = new DatabaseSync(SRC_PATH, { readOnly: true });
  const schemaObjs = src.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND type IN ('table','index')"
  ).all();
  src.close();

  const fs = require('fs');
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  const db = new DatabaseSync(outPath);
  db.exec('PRAGMA foreign_keys=OFF;');
  for (const o of schemaObjs) {
    try { db.exec(o.sql); } catch (e) { /* pl. sqlite_sequence-t nem lehet explicit létrehozni kétszer */ }
  }

  // --- cég (szallitot) ---
  db.prepare(`INSERT INTO szallitot
    (cegid, nev, adoszam, varos, irsz, cim, adoalany, orszag, foceg, rksh)
    VALUES (1, ?, ?, ?, ?, ?, 'I', 'HU', 'I', '10000')`)
    .run(company.nev, company.adoszam, company.varos, company.irsz, company.cim);

  // --- cikkcsop (termékcsoport) ---
  db.prepare(`INSERT INTO cikkcsop (azon, megnevezes, status) VALUES ('1', ?, 'A')`)
    .run(company.csoportNev);

  // --- cikkt (termékek) ---
  const insCikk = db.prepare(`INSERT INTO cikkt
    (csopazon, megnevezes, me, bruttoar, afakod, azon, status, vtszkodtip, vtsz, fokatjson, alkatjson, ntakszorzo, ntakme, autszervizdij, autszervizdijsz, repohar, repoharbrutto, gongyolegazon)
    VALUES ('1', ?, ?, ?, ?, ?, 'A', 'MAS', '000', ?, ?, 1, ?, 'N', 0, 0, 0, '')`);
  products.forEach((p, idx) => {
    insCikk.run(p.nev, p.me, p.ar, p.afakod, String(idx + 1), p.fokat, p.alkat, p.me);
  });

  // --- nyfej + nytet (nyugták) ---
  const insFej = db.prepare(`INSERT INTO nyfej
    (cegid, rksh, bsz, keltdat, nypeldsz, sznev, szadoszam, szorszag, szvaros, szirsz, szcim,
     vnev, vorszag, vvaros, virsz, vcim, umdate, fizmod, bsznr,
     bruttokp, bruttoafr, bruttokartya, storno, stornozott, helybenfogyasztott)
    VALUES (1, '10000', ?, ?, 1, ?, ?, 'HU', ?, ?, ?,
     '', 'HU', '', '', '', ?, ?, ?,
     ?, 0, ?, 'N', 'N', 'I')`);

  const insTet = db.prepare(`INSERT INTO nytet
    (rksh, keltdat, bsz, sor, cikkszam, megnevezes, vtszkodtip, vtsz, me, bruttoar, nettoar, afakod,
     menny, engedmeny, sornetto, sorafa, sorbrutto, umdate, azon, ntakszorzo, ntakme, elvitelin, status, fokatjson, alkatjson)
    VALUES ('10000', ?, ?, ?, '', ?, 'MAS', '000', ?, ?, ?, ?,
     ?, 0, ?, ?, ?, ?, ?, 1, ?, 'N', 'A', ?, ?)`);

  const fizmodok = ['bankkártya', 'kp', 'egyéb'];
  let bsznr = 1;
  const today = new Date(opts.today);
  for (let dayOffset = opts.days - 1; dayOffset >= 0; dayOffset--) {
    const d = new Date(today.getTime() - dayOffset * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    const receiptsToday = opts.minPerDay + Math.floor(Math.random() * (opts.maxPerDay - opts.minPerDay + 1));
    for (let r = 0; r < receiptsToday; r++) {
      const bsz = `${opts.prefix}/${d.getFullYear() % 100}/${pad(bsznr, 7)}`;
      const lineCount = 1 + Math.floor(Math.random() * 4);
      let grossTotal = 0;
      const lines = [];
      for (let li = 0; li < lineCount; li++) {
        const p = products[Math.floor(Math.random() * products.length)];
        const menny = 1 + Math.floor(Math.random() * 2);
        const sorbrutto = p.ar * menny;
        const afaRate = parseFloat(p.afakod) / 100;
        const sornetto = Math.round(sorbrutto / (1 + afaRate));
        const sorafa = sorbrutto - sornetto;
        grossTotal += sorbrutto;
        lines.push({ p, menny, sorbrutto, sornetto, sorafa });
      }
      const fizmod = fizmodok[Math.floor(Math.random() * fizmodok.length)];
      const bruttokp = fizmod === 'kp' ? grossTotal : 0;
      const bruttokartya = fizmod === 'bankkártya' ? grossTotal : 0;
      const bruttoegyeb = fizmod === 'egyéb' ? grossTotal : 0;
      const hh = pad(8 + Math.floor(Math.random() * 11), 2);
      const mm = pad(Math.floor(Math.random() * 60), 2);
      const umdate = `${dateStr} ${hh}:${mm}:00`;

      insFej.run(
        bsz, dateStr, company.nev, company.adoszam, company.varos, company.irsz, company.cim,
        umdate, fizmod, bsznr,
        bruttokp, bruttokartya
      );
      // bruttoafr (utalvány/egyéb) oszlopba írjuk az "egyéb" fizmódot, ha volt
      if (bruttoegyeb) {
        db.prepare(`UPDATE nyfej SET bruttoafr = ? WHERE bsz = ?`).run(bruttoegyeb, bsz);
      }

      lines.forEach((ln, i) => {
        insTet.run(
          dateStr, bsz, i + 1, ln.p.nev, ln.p.me, ln.p.ar, ln.sornetto, ln.p.afakod,
          ln.menny, ln.sornetto, ln.sorafa, ln.sorbrutto, umdate, String(bsznr * 100 + i),
          ln.p.me, ln.p.fokat, ln.p.alkat
        );
      });
      bsznr++;
    }
  }

  db.close();
  console.log(`Kész: ${outPath} (${bsznr - 1} nyugta)`);
}

// ---------------------------------------------------------------------------
// Cég A: Corvin Presszó Kft. — kávézó / cukrászda
// ---------------------------------------------------------------------------
buildDb(path.join(__dirname, 'test-corvin-presszo.db'), {
  nev: 'Corvin Presszó Kft.',
  adoszam: '18774455-1-42',
  varos: 'SZEGED',
  irsz: '6720',
  cim: 'KÁRÁSZ UTCA 14.',
  csoportNev: 'Kávézó kínálat',
}, [
  { nev: 'Espresso', me: 'Darab', ar: 650, afakod: '5%', fokat: 'ALKMENTESITAL_HELYBEN', alkat: 'KAVE' },
  { nev: 'Cappuccino', me: 'Darab', ar: 850, afakod: '5%', fokat: 'ALKMENTESITAL_HELYBEN', alkat: 'KAVE' },
  { nev: 'Latte Macchiato', me: 'Darab', ar: 950, afakod: '5%', fokat: 'ALKMENTESITAL_HELYBEN', alkat: 'KAVE' },
  { nev: 'Forró csokoládé', me: 'Darab', ar: 990, afakod: '5%', fokat: 'ALKMENTESITAL_HELYBEN', alkat: 'TEA_FORROCSOKOLADE' },
  { nev: 'Tea (válogatott)', me: 'Darab', ar: 650, afakod: '5%', fokat: 'ALKMENTESITAL_HELYBEN', alkat: 'TEA_FORROCSOKOLADE' },
  { nev: 'Croissant', me: 'Darab', ar: 790, afakod: '27%', fokat: 'ETEL', alkat: 'PEKARU' },
  { nev: 'Csokis muffin', me: 'Darab', ar: 720, afakod: '27%', fokat: 'ETEL', alkat: 'DESSZERT' },
  { nev: 'Sajttorta szelet', me: 'Darab', ar: 1050, afakod: '27%', fokat: 'ETEL', alkat: 'DESSZERT' },
  { nev: 'Ásványvíz 0.33', me: 'Darab', ar: 500, afakod: '27%', fokat: 'ALKMENTESITAL_HELYBEN', alkat: 'UDITO' },
  { nev: 'Limonádé', me: 'Darab', ar: 890, afakod: '27%', fokat: 'ALKMENTESITAL_HELYBEN', alkat: 'UDITO' },
], { days: 45, minPerDay: 10, maxPerDay: 28, prefix: 'CPY', today: '2026-07-08' });

// ---------------------------------------------------------------------------
// Cég B: Zöld Kanál Vendéglő Kft. — étterem
// ---------------------------------------------------------------------------
buildDb(path.join(__dirname, 'test-zold-kanal.db'), {
  nev: 'Zöld Kanál Vendéglő Kft.',
  adoszam: '24681357-2-09',
  varos: 'DEBRECEN',
  irsz: '4024',
  cim: 'PIAC UTCA 22.',
  csoportNev: 'Étlap',
}, [
  { nev: 'Gulyásleves', me: 'Adag', ar: 1890, afakod: '5%', fokat: 'ETEL', alkat: 'LEVES' },
  { nev: 'Sertéspörkölt galuskával', me: 'Adag', ar: 2790, afakod: '5%', fokat: 'ETEL', alkat: 'FOETEL' },
  { nev: 'Rántott sertésszelet', me: 'Adag', ar: 2590, afakod: '5%', fokat: 'ETEL', alkat: 'FOETEL' },
  { nev: 'Csirkemell saláta', me: 'Adag', ar: 2350, afakod: '5%', fokat: 'ETEL', alkat: 'FOETEL' },
  { nev: 'Palacsinta (túrós)', me: 'Adag', ar: 1290, afakod: '5%', fokat: 'ETEL', alkat: 'DESSZERT' },
  { nev: 'Korsó sör 0.5', me: 'Darab', ar: 890, afakod: '27%', fokat: 'ALKOHOLOSITAL_HELYBEN', alkat: 'SOR' },
  { nev: 'Pohár bor 1dl', me: 'Darab', ar: 950, afakod: '27%', fokat: 'ALKOHOLOSITAL_HELYBEN', alkat: 'BOR' },
  { nev: 'Üdítő 0.3', me: 'Darab', ar: 690, afakod: '27%', fokat: 'ALKMENTESITAL_HELYBEN', alkat: 'UDITO' },
  { nev: 'Ásványvíz 0.33', me: 'Darab', ar: 550, afakod: '27%', fokat: 'ALKMENTESITAL_HELYBEN', alkat: 'UDITO' },
  { nev: 'Espresso', me: 'Darab', ar: 650, afakod: '5%', fokat: 'ALKMENTESITAL_HELYBEN', alkat: 'KAVE' },
], { days: 45, minPerDay: 8, maxPerDay: 20, prefix: 'ZKY', today: '2026-07-08' });
