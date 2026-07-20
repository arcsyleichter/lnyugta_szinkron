// Valósághű tesztadatok az admin áttekintés vizuális teszteléséhez.
// Futtatás: node scripts/seed-visual-test.js  (a projekt gyökeréből)
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'); const path = require('path');
const DATA = path.join(__dirname, '..', 'data');
const cegek = [
  { kulcs: '11111111-1-11', nev: 'Kék Lagúna Bisztró Kft.', varos: 'Budapest', sites: ['01', '02'] },
  { kulcs: '22222222-2-22', nev: 'Napraforgó Pékség Bt.', varos: 'Szeged', sites: ['01'] },
  { kulcs: '33333333-3-33', nev: 'Zöld Sarok ABC', varos: 'Pécs', sites: ['01'] },
  { kulcs: '44444444-4-44', nev: 'Móló Fagyizó Kft.', varos: 'Siófok', sites: ['01'] },
];
for (const c of cegek) {
  const dir = path.join(DATA, 'companies', c.kulcs);
  fs.mkdirSync(dir, { recursive: true });
  for (const s of c.sites) {
    const db = new DatabaseSync(path.join(dir, s + '.db'));
    db.exec('CREATE TABLE IF NOT EXISTS szallitot (cegid TEXT, nev TEXT, adoszam TEXT, varos TEXT, cim TEXT)');
    db.prepare('INSERT INTO szallitot VALUES (?,?,?,?,?)').run('1', c.nev, c.kulcs, c.varos, 'Fő u. 1.');
    db.close();
  }
}
const now = Date.now(); const H = 3600000;
const meta = {
  '11111111-1-11:01': { lastSync: new Date(now - 2 * H).toISOString(), source: 'android', bytes: 120000 },
  '11111111-1-11:02': { lastSync: new Date(now - 20 * H).toISOString(), source: 'android', bytes: 90000 },
  '22222222-2-22:01': { lastSync: new Date(now - 3 * 24 * H).toISOString(), source: 'android', bytes: 80000 },
  '33333333-3-33:01': { lastSync: new Date(now - 10 * 24 * H).toISOString(), source: 'android', bytes: 70000 },
};
fs.writeFileSync(path.join(DATA, 'sync-meta.json'), JSON.stringify(meta, null, 2));
const users = new DatabaseSync(path.join(DATA, 'users.db'));
const ins = users.prepare("INSERT OR IGNORE INTO users (email, role, ceg_kulcs, nev, status, created_at) VALUES (?,?,?,?,?,datetime('now'))");
ins.run('kata@keklaguna.hu', 'owner', '11111111-1-11', 'Kovács Kata', 'active');
ins.run('peti@napraforgo.hu', 'owner', '22222222-2-22', 'Nagy Péter', 'active');
ins.run('uzletvezeto@keklaguna.hu', 'manager', '11111111-1-11', 'Tóth Ubul', 'pending');
ins.run('viszont@elado.hu', 'reseller', null, 'Viszont Elek', 'active');
users.close();
const lic = new DatabaseSync(path.join(DATA, 'license.db'));
lic.prepare("INSERT OR REPLACE INTO company_subscription (ceg_kulcs, aktiv, updated_at) VALUES (?,?,datetime('now'))").run('33333333-3-33', 0);
const month = new Date().toISOString().slice(0, 7);
const pay = lic.prepare('INSERT OR IGNORE INTO license_payments (order_id, ceg_kulcs, cel, osszeg, allapot, letrehozva) VALUES (?,?,?,?,?,?)');
pay.run('T-001', '11111111-1-11', 'licenc', 14900, 'SIKERES', month + '-05T10:00:00');
pay.run('T-002', '22222222-2-22', 'licenc', 14900, 'SIKERES', month + '-11T09:30:00');
lic.close();
console.log('Tesztadatok kész.');
