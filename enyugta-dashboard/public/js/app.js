'use strict';

// Globális állapot-változók a fájl LEGELEJÉN — szándékosan itt, nem a
// felhasználási helyük közelében, hogy semmilyen jövőbeli szerkesztés
// se tudja véletlenül a deklaráció elé csúsztatni a felhasználást
// (ami "Cannot access before initialization" hibát okozna).
let stockProductsLoaded = false;
let loggedIn = false;
const stockFilter = { q: '', csoport: '' };

/* ============================================================
   Globális hibafogó — minden nem kezelt JS-hibát (beleértve a
   top-level szkripthibákat és az elkapatlan Promise-hibákat)
   elküld a szervernek (/api/client-error), hogy ne a felhasználó
   képernyőfotójából derüljön ki, ha valami eltört.
   Védelem: laponként max. 5 riport, azonos üzenet csak egyszer,
   és a riportolás saját hibája sosem dobódik tovább.
   ============================================================ */
const _errSent = new Set();
let _errCount = 0;
function reportClientError(message, source, line, stack) {
  try {
    const key = String(message).slice(0, 200);
    if (_errCount >= 5 || _errSent.has(key)) return;
    _errSent.add(key);
    _errCount += 1;
    fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        message: String(message).slice(0, 500),
        source: String(source || '').slice(0, 200),
        line: Number(line) || 0,
        stack: String(stack || '').slice(0, 1000),
        url: location.pathname + location.search,
      }),
    }).catch(() => {});
  } catch (_) { /* a hibariport sosem okozhat újabb hibát */ }
}
window.addEventListener('error', (e) => {
  reportClientError(e.message, e.filename, e.lineno, e.error && e.error.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason || {};
  reportClientError(r.message || String(e.reason), '', 0, r.stack);
});

/* Null-biztos eseménykezelő-regisztráció. Ha az elem hiányzik a DOM-ból
   (pl. régi cache-elt index.html új app.js-sel), NEM dobunk hibát — ami
   megölné az egész top-level szkriptet és minden utána következő
   regisztrációt —, hanem riportoljuk és megyünk tovább. */
function listen(id, event, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, fn);
  else reportClientError(`Hiányzó DOM elem: #${id} (${event} kezelő nem lett regisztrálva)`);
}

/* ============================================================
   Segédfüggvények
   ============================================================ */
const fmtHuf = (n) => new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 0 }).format(n || 0) + ' Ft';
const fmtDate = (d) => new Date(d).toLocaleDateString('hu-HU', { year: 'numeric', month: 'short', day: 'numeric' });
const fmtDateTime = (d) => new Date(d).toLocaleString('hu-HU');
const todayIso = () => new Date().toISOString().slice(0, 10);

/* ============================================================
   Paginator — újrahasznosítható lapozó minden lista-nézethez.
   Kliens-oldali (a teljes adathalmaz már úgyis be van töltve),
   csak a MEGJELENÍTETT sorokat vágja le oldalanként.
   ============================================================ */
class Paginator {
  constructor({ pageSize = 15 } = {}) {
    this.page = 1;
    this.pageSize = pageSize;
    this.total = 0;
  }
  setTotal(total) {
    this.total = total;
    const maxPage = Math.max(1, Math.ceil(total / this.pageSize));
    if (this.page > maxPage) this.page = maxPage;
  }
  slice(arr) {
    this.setTotal(arr.length);
    const start = (this.page - 1) * this.pageSize;
    return arr.slice(start, start + this.pageSize);
  }
  renderControls(containerEl, onChange) {
    const maxPage = Math.max(1, Math.ceil(this.total / this.pageSize));
    const start = this.total === 0 ? 0 : (this.page - 1) * this.pageSize + 1;
    const end = Math.min(this.total, this.page * this.pageSize);

    const pageButtons = [];
    const addBtn = (label, page, opts = {}) => {
      pageButtons.push(
        `<button data-page="${page}" ${opts.active ? 'class="is-active"' : ''} ${opts.disabled ? 'disabled' : ''}>${label}</button>`
      );
    };
    addBtn('‹', Math.max(1, this.page - 1), { disabled: this.page === 1 });
    const windowSize = 2;
    for (let p = 1; p <= maxPage; p++) {
      if (p === 1 || p === maxPage || Math.abs(p - this.page) <= windowSize) {
        addBtn(String(p), p, { active: p === this.page });
      } else if (Math.abs(p - this.page) === windowSize + 1) {
        pageButtons.push('<span style="padding:0 4px;">…</span>');
      }
    }
    addBtn('›', Math.min(maxPage, this.page + 1), { disabled: this.page === maxPage });

    containerEl.innerHTML = `
      <div class="pagination-bar">
        <span class="pagination-info">${this.total === 0 ? 'Nincs találat' : `${start}–${end} / ${this.total}`}</span>
        <div class="pagination-controls">${pageButtons.join('')}</div>
        <select class="pagination-size-select">
          ${[15, 25, 50, 100].map((n) => `<option value="${n}" ${n === this.pageSize ? 'selected' : ''}>${n} / oldal</option>`).join('')}
        </select>
      </div>`;

    containerEl.querySelectorAll('button[data-page]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.page = Number(btn.dataset.page);
        onChange();
      });
    });
    containerEl.querySelector('.pagination-size-select').addEventListener('change', (e) => {
      this.pageSize = Number(e.target.value);
      this.page = 1;
      onChange();
    });
  }
}
const stockPaginator = new Paginator();

const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/* Dátumtartomány-preset segédfüggvények — mindig helyi (nem UTC) dátumokkal
   számolnak, hogy ne csússzon el a nap a felhasználó időzónájában. */
const pad2 = (n) => String(n).padStart(2, '0');
const toIso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function startOfWeek(d) { const dt = new Date(d); const day = (dt.getDay() + 6) % 7; dt.setDate(dt.getDate() - day); return dt; }
function endOfWeek(d) { const dt = startOfWeek(d); dt.setDate(dt.getDate() + 6); return dt; }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function startOfYear(d) { return new Date(d.getFullYear(), 0, 1); }
function endOfYear(d) { return new Date(d.getFullYear(), 11, 31); }

/* Egy preset kulcsból ({from,to}) számol — a "mai nap" mindig a böngésző
   aktuális dátuma. Az aktuális hét/hónap/év mindig a mai napig tart
   (nincs értelme jövőbeli, üres napokat mutatni). */
function resolvePreset(key) {
  const now = new Date();
  switch (key) {
    case 'today': return { from: toIso(now), to: toIso(now) };
    case '7': return { from: isoDaysAgo(6), to: todayIso() };
    case '30': return { from: isoDaysAgo(29), to: todayIso() };
    case '90': return { from: isoDaysAgo(89), to: todayIso() };
    case 'week-td': return { from: toIso(startOfWeek(now)), to: toIso(now) };
    case 'month-td': return { from: toIso(startOfMonth(now)), to: toIso(now) };
    case 'year-td': return { from: toIso(startOfYear(now)), to: toIso(now) };
    case 'prev-week': { const p = new Date(now); p.setDate(p.getDate() - 7); return { from: toIso(startOfWeek(p)), to: toIso(endOfWeek(p)) }; }
    case 'prev-month': { const p = new Date(now.getFullYear(), now.getMonth() - 1, 1); return { from: toIso(startOfMonth(p)), to: toIso(endOfMonth(p)) }; }
    case 'prev-year': { const p = new Date(now.getFullYear() - 1, 0, 1); return { from: toIso(startOfYear(p)), to: toIso(endOfYear(p)) }; }
    default: return { from: isoDaysAgo(6), to: todayIso() };
  }
}

// A bejelentkező végpontok saját maguk kezelik a hibás jelszó (401) esetét —
// ott NEM szabad automatikusan a kezdőképernyőre visszaugrani, mert éppen
// AZON a képernyőn állunk, és a hibaüzenetet kellene megmutatnunk, nem
// eltüntetni a képernyőt alóla. A blanket-redirect csak az UTÁN hasznos,
// ha valaki már be volt jelentkezve, és a munkamenete időközben lejárt.
const LOGIN_ENDPOINTS = ['/api/auth/user-login', '/api/auth/reseller-login', '/api/admin/login'];
async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
  if (res.status === 401 && !LOGIN_ENDPOINTS.includes(path)) { showLandingScreen(); throw new Error('NOT_AUTHENTICATED'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Ismeretlen hiba');
    err.data = data;
    throw err;
  }
  return data;
}
// Csendes verzió a kezdeti "vajon be vagyok-e már jelentkezve?" ellenőrzéshez —
// ez NEM ránthatja vissza a felületet bejelentkező nézetre, mert ha lassan tér
// vissza, versenyhelyzetben felülírhatná egy közben sikeresen megtörtént
// bejelentkezés állapotát.
async function apiSilent(path) {
  const res = await fetch(path, { credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Ismeretlen hiba'); e.status = res.status; throw e; }
  return data;
}

/* ============================================================
   Állapot
   ============================================================ */
const state = {
  range: { from: todayIso(), to: todayIso(), preset: 'today' },
  group: 'hour',
  products: { offset: 0, limit: 15, q: '' },
  receipts: { offset: 0, limit: 15, q: '', fizmod: '', min: '', max: '' },
  pollTimer: null,
};

/* ============================================================
   Bejelentkezés
   ============================================================ */
const landingScreen = document.getElementById('landing-screen');
const loginScreen = landingScreen; // a kezdőképernyő és az ügyfél-bejelentkezés most már ugyanaz az elem
const telephelyScreen = document.getElementById('telephely-screen');
const telephelyWaitingScreen = document.getElementById('telephely-waiting-screen');
const resellerScreen = document.getElementById('reseller-screen');
const appScreen = document.getElementById('app-screen');
const adminLoginScreen = document.getElementById('admin-login-screen');
const adminScreen = document.getElementById('admin-screen');

// Jelszó megjelenítése/elrejtése gomb — minden .password-toggle-btn
// elemre egységesen vonatkozik, akárhány bejelentkező űrlapon szerepel.
document.querySelectorAll('.password-toggle-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? '👁' : '🙈';
    btn.setAttribute('aria-label', showing ? 'Jelszó megjelenítése' : 'Jelszó elrejtése');
  });
});

function hideAllScreens() {
  landingScreen.hidden = true;
  telephelyScreen.hidden = true;
  telephelyWaitingScreen.hidden = true;
  resellerScreen.hidden = true;
  appScreen.hidden = true;
  adminLoginScreen.hidden = true;
  adminScreen.hidden = true;
  document.getElementById('reseller-login-screen').hidden = true;
  document.getElementById('invite-accept-screen').hidden = true;
  if (state.pollTimer) clearInterval(state.pollTimer);
}
function showLogin() { hideAllScreens(); loginScreen.hidden = false; }
function showTelephelyScreen() { hideAllScreens(); telephelyScreen.hidden = false; }
function showTelephelyWaitingScreen() { hideAllScreens(); telephelyWaitingScreen.hidden = false; }
function showApp() { hideAllScreens(); appScreen.hidden = false; document.getElementById('back-to-admin-btn').hidden = !state.viaAdmin; }
function showAdminLogin() { hideAllScreens(); adminLoginScreen.hidden = false; }
function showAdmin() { hideAllScreens(); adminScreen.hidden = false; showAdminView('overview'); loadLicenseData(); }

/* ============================================================
   Admin — navigációs menü (blokkonként külön nézet)
   ============================================================ */
function showAdminView(view) {
  document.querySelectorAll('.admin-view').forEach((el) => { el.hidden = el.dataset.adminView !== view; });
  document.querySelectorAll('.admin-nav-item').forEach((btn) => { btn.classList.toggle('is-active', btn.dataset.adminView === view); });
  document.querySelectorAll('#admin-mobile-tabbar .mobile-tab-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.forwardAdminView === view);
  });
  closeAdminMobileSidebar(); // mobil nézetben a menü válaszottás után csukódjon be
}
document.querySelectorAll('.admin-nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    showAdminView(btn.dataset.adminView);
    if (btn.dataset.adminView === 'felhasznalok') loadAdminUsers();
    if (btn.dataset.adminView === 'licenc') loadLicenseData();
    if (btn.dataset.adminView === 'regisztraciok') loadAdminRegistrations();
    if (btn.dataset.adminView === 'penzugyek') loadFinanceView();
  });
});

/* ============================================================
   Admin — mobil alsó navigáció, ugyanaz a "továbbító" minta, mint a
   céges felületen.
   ============================================================ */
document.querySelectorAll('.mobile-tab-btn[data-forward-admin-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelector(`.admin-nav-item[data-admin-view="${btn.dataset.forwardAdminView}"]`).click();
  });
});
listen('admin-mobile-tab-more', 'click', () => {
  const sidebar = document.getElementById('admin-sidebar');
  if (sidebar.classList.contains('is-open')) closeAdminMobileSidebar(); else openAdminMobileSidebar();
});

/* ============================================================
   Admin — Licenc-kezelés (élő adatok: funkció-katalógus + cégenkénti
   licencek — az androidos app a /api/license/status végponton kérdezi
   le ugyanezt, a szinkron x-api-key-jel hitelesítve).
   ============================================================ */
let licenseFeaturesCache = [];
let licenseCompaniesCache = [];
let licensePackagesCache = [];

listen('nav-test-connection-btn', 'click', async (e) => {
  const btn = e.target;
  const result = document.getElementById('nav-test-result');
  btn.disabled = true; btn.textContent = 'Tesztelés…';
  result.textContent = '';
  try {
    const data = await api('/api/admin/nav/test-connection', { method: 'POST' });
    result.textContent = `✓ Sikeres kapcsolat! A token ${data.tokenValidTo} időpontig érvényes.`;
    result.style.color = 'var(--jade-deep)';
  } catch (err) {
    result.textContent = '✗ ' + err.message;
    result.style.color = 'var(--brick)';
  } finally {
    btn.disabled = false; btn.textContent = 'Kapcsolat tesztelése';
  }
});

async function loadFinanceView() {
  try {
    const navStatus = await api('/api/admin/nav/status');
    const navDesc = document.getElementById('nav-status-desc');
    if (!navStatus.configured) {
      navDesc.innerHTML = '<span class="muted">Nincs beállítva (hiányzó környezeti változók: NAV_TAXNUMBER, NAV_TECH_USER, NAV_TECH_PASSWORD, NAV_SIGNING_KEY, NAV_EXCHANGE_KEY).</span>';
    } else {
      navDesc.innerHTML = `<b>${navStatus.sandbox ? 'Teszt' : 'Éles'} környezet</b> — technikai felhasználó: ${escapeHtml(navStatus.techUser)}, adószám: ${escapeHtml(navStatus.taxNumber)}`;
    }
  } catch (e) { /* nem kritikus, ha ez nem töltődik be */ }

  try {
    const [overview, invoicesData] = await Promise.all([
      api('/api/admin/finance/overview'),
      api('/api/admin/finance/invoices'),
    ]);
    document.getElementById('finance-honap-osszeg').textContent = fmtHuf(overview.osszesenEHonap);
    document.getElementById('finance-ev-osszeg').textContent = fmtHuf(overview.osszesenIdeiEv);
    document.getElementById('finance-total-osszeg').textContent = fmtHuf(overview.osszesenMindenIdok);

    const monthNames = ['január', 'február', 'március', 'április', 'május', 'június', 'július', 'augusztus', 'szeptember', 'október', 'november', 'december'];
    const monthlyBody = document.querySelector('#finance-monthly-table tbody');
    monthlyBody.innerHTML = overview.havonta.length
      ? overview.havonta.map((h) => {
          const [ev, honap] = h.honap.split('-');
          return `<tr><td>${monthNames[parseInt(honap, 10) - 1]} ${ev}</td><td class="td-right">${h.darab}</td><td class="td-right">${fmtHuf(h.osszeg)}</td></tr>`;
        }).join('')
      : '<tr><td colspan="3" class="empty-state">Még nincs egyetlen sikeres fizetés sem.</td></tr>';

    const companyBody = document.querySelector('#finance-company-table tbody');
    companyBody.innerHTML = overview.cegenkent.length
      ? overview.cegenkent.map((c) => `<tr><td>${escapeHtml(c.cegNev)}</td><td class="td-right">${c.darab}</td><td class="td-right">${fmtHuf(c.osszeg)}</td></tr>`).join('')
      : '<tr><td colspan="3" class="empty-state">Még nincs egyetlen sikeres fizetés sem.</td></tr>';

    const featureBody = document.querySelector('#finance-feature-table tbody');
    featureBody.innerHTML = overview.funkciononkent.length
      ? overview.funkciononkent.map((f) => `<tr><td>${escapeHtml(f.featureNev)}</td><td class="td-right">${f.darab}</td><td class="td-right">${fmtHuf(f.osszeg)}</td></tr>`).join('')
      : '<tr><td colspan="3" class="empty-state">Még nincs egyetlen sikeres fizetés sem.</td></tr>';

    const invoicesBody = document.querySelector('#finance-invoices-table tbody');
    invoicesBody.innerHTML = invoicesData.invoices.length
      ? invoicesData.invoices.map((inv) => `
        <tr>
          <td class="ntak-uuid">${escapeHtml(inv.szamlaSorszam)}</td>
          <td>${escapeHtml(inv.cegNev)}</td>
          <td>${fmtDateTime(inv.letrehozva)}</td>
          <td>${inv.tetelek.map((t) => escapeHtml(t.nev)).join(', ')}</td>
          <td class="td-right">${fmtHuf(inv.osszeg)}</td>
          <td>${inv.pdfElerheto ? `<a class="btn-tiny" href="/api/admin/finance/invoice-pdf?fajlnev=${encodeURIComponent(inv.pdfFajlnev)}" target="_blank">⬇ PDF</a>` : '<span class="muted">nincs fájl</span>'}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="empty-state">Még nem készült egyetlen számla sem.</td></tr>';
  } catch (e) {
    alert('Nem sikerült betölteni a pénzügyi adatokat: ' + e.message);
  }
}

async function loadLicenseData() {
  await Promise.all([loadLicenseFeatures(), loadLicenseCompanies(), loadLicensePackages(), loadAdminPayments(), loadLicenseEnforceToggle()]);
}

async function loadLicenseEnforceToggle() {
  const checkbox = document.getElementById('license-enforce-toggle');
  const desc = document.getElementById('license-enforce-desc');
  try {
    const data = await api('/api/admin/settings/license-enforce');
    checkbox.checked = data.enforce;
    updateLicenseEnforceDesc(data.enforce);
  } catch (e) {
    desc.textContent = 'Nem sikerült betölteni: ' + e.message;
  }
}
function updateLicenseEnforceDesc(enforce) {
  const desc = document.getElementById('license-enforce-desc');
  desc.innerHTML = enforce
    ? '<b>Bekapcsolva</b> — a tényleges, kiosztott funkciók számítanak (a próbaidőszak lejárta után). Amit itt beállítasz, azt fogja látni az app.'
    : '<b>Kikapcsolva</b> — mindenki mindent lát, függetlenül attól, mit osztasz ki. A lenti beállítások NEM érvényesülnek, amíg ez ki van kapcsolva.';
}
listen('license-enforce-toggle', 'change', async (e) => {
  const checkbox = e.target;
  const newValue = checkbox.checked;
  checkbox.disabled = true;
  try {
    await api('/api/admin/settings/license-enforce', { method: 'POST', body: JSON.stringify({ enforce: newValue }) });
    updateLicenseEnforceDesc(newValue);
  } catch (err) {
    alert('Nem sikerült menteni: ' + err.message);
    checkbox.checked = !newValue;
  } finally {
    checkbox.disabled = false;
  }
});

async function loadAdminPayments() {
  const statusBox = document.getElementById('admin-payments-status');
  const tbody = document.querySelector('#admin-payments-table tbody');
  try {
    const data = await api('/api/admin/payments');
    statusBox.textContent = data.myposConfigured
      ? 'A myPOS bankkártyás fizetés be van állítva a szerveren.'
      : 'A myPOS bankkártyás fizetés MÉG NINCS beállítva a szerveren — a "Fizetés indítása" gomb az ügyfeleknél egyelőre hibaüzenetet ad.';
    if (!data.payments.length) { tbody.innerHTML = '<tr><td colspan="6" class="muted">Még nincs egyetlen fizetési kísérlet sem.</td></tr>'; return; }
    tbody.innerHTML = data.payments.map((p) => {
      const cegNev = (licenseCompaniesCache.find((c) => c.cegKulcs === p.cegKulcs) || {}).nev || p.cegKulcs;
      const allapotClass = p.allapot === 'SIKERES' ? 'ok' : p.allapot === 'SIKERTELEN' ? 'expired' : 'none';
      return `<tr>
        <td>${fmtDateTime(p.letrehozva)}</td>
        <td>${escapeHtml(cegNev)}</td>
        <td>${escapeHtml(p.cel)}</td>
        <td class="num">${fmtHuf(p.osszeg)}</td>
        <td><span class="licenc-badge licenc-badge--${allapotClass}">${escapeHtml(PAYMENT_STATUS_LABELS[p.allapot] || p.allapot)}</span></td>
        <td class="ntak-uuid">${escapeHtml(p.myposTrnref || '—')}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    statusBox.textContent = '';
    tbody.innerHTML = `<tr><td colspan="6" class="muted">Nem sikerült betölteni: ${escapeHtml(e.message)}</td></tr>`;
  }
}

async function loadLicensePackages() {
  try {
    const data = await api('/api/admin/license/packages');
    licensePackagesCache = data.packages;
    renderLicensePackages();
  } catch (e) {
    document.getElementById('license-packages-list').innerHTML = `<span class="muted">Nem sikerült betölteni: ${escapeHtml(e.message)}</span>`;
  }
}

function renderLicensePackages() {
  const box = document.getElementById('license-packages-list');
  if (!licensePackagesCache.length) { box.innerHTML = '<span class="muted">Még nincs egyetlen csomag sem.</span>'; return; }
  box.innerHTML = licensePackagesCache.map((p) => {
    const featureNames = p.featureKeys.map((k) => {
      const f = licenseFeaturesCache.find((x) => x.key === k);
      return f ? f.nev : k;
    }).join(', ') || '(nincs funkció hozzárendelve)';
    return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--line);flex-wrap:wrap;">
      <div style="flex:1 1 260px;">
        <div style="font-weight:600;font-size:13px;">${escapeHtml(p.nev)} <span class="licenc-badge licenc-badge--${p.aktiv ? 'ok' : 'none'}" style="margin-left:6px;">${p.aktiv ? 'aktív' : 'kivezetve'}</span></div>
        <div class="card-subtitle" style="margin-top:2px;">${escapeHtml(featureNames)}${p.ar ? ` · ${p.ar.toLocaleString('hu-HU')} Ft` : ''}</div>
      </div>
      <div>
        <button class="btn-tiny btn-license-package-edit" data-id="${p.id}">Szerkesztés</button>
        <button class="btn-tiny btn-license-package-delete" data-id="${p.id}">Törlés</button>
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('.btn-license-package-edit').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = licensePackagesCache.find((x) => x.id === Number(btn.dataset.id));
      openLicensePackageModal(p);
    });
  });
  box.querySelectorAll('.btn-license-package-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const p = licensePackagesCache.find((x) => x.id === Number(btn.dataset.id));
      if (!confirm(`Törlöd a(z) "${p.nev}" csomagot? A már kiosztott funkciók a cégeknél megmaradnak, csak maga a csomag-meghatározás törlődik.`)) return;
      try {
        await api('/api/admin/license/packages/delete', { method: 'POST', body: JSON.stringify({ id: p.id }) });
        loadLicensePackages();
      } catch (e) { alert('Nem sikerült: ' + e.message); }
    });
  });
}

function openLicensePackageModal(p) {
  document.getElementById('license-package-modal-title').textContent = p ? 'Csomag szerkesztése' : 'Új csomag';
  document.getElementById('license-package-id').value = p ? p.id : '';
  document.getElementById('license-package-nev').value = p ? p.nev : '';
  document.getElementById('license-package-leiras').value = p ? (p.leiras || '') : '';
  document.getElementById('license-package-ar').value = p ? p.ar : 0;
  document.getElementById('license-package-aktiv').checked = p ? p.aktiv : true;
  document.getElementById('license-package-msg').textContent = '';
  const checksBox = document.getElementById('license-package-feature-checks');
  const selectedKeys = new Set(p ? p.featureKeys : []);
  checksBox.innerHTML = licenseFeaturesCache.map((f) => `
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;padding:4px 0;">
      <input type="checkbox" value="${escapeHtml(f.key)}" ${selectedKeys.has(f.key) ? 'checked' : ''}> ${escapeHtml(f.nev)}
    </label>`).join('') || '<span class="muted">Előbb vegyél fel legalább egy funkciót a katalógusba.</span>';
  document.getElementById('license-package-modal-backdrop').hidden = false;
}
listen('license-package-new-btn', 'click', () => openLicensePackageModal(null));
listen('license-package-modal-close', 'click', () => {
  document.getElementById('license-package-modal-backdrop').hidden = true;
});
listen('license-package-modal-backdrop', 'click', (e) => {
  if (e.target.id === 'license-package-modal-backdrop') e.target.hidden = true;
});
listen('license-package-form', 'submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('license-package-msg');
  msg.textContent = '';
  try {
    const featureKeys = [...document.querySelectorAll('#license-package-feature-checks input:checked')].map((c) => c.value);
    const body = {
      id: document.getElementById('license-package-id').value || undefined,
      nev: document.getElementById('license-package-nev').value.trim(),
      leiras: document.getElementById('license-package-leiras').value.trim(),
      ar: Number(document.getElementById('license-package-ar').value) || 0,
      aktiv: document.getElementById('license-package-aktiv').checked,
      featureKeys,
    };
    await api('/api/admin/license/packages/save', { method: 'POST', body: JSON.stringify(body) });
    document.getElementById('license-package-modal-backdrop').hidden = true;
    loadLicensePackages();
  } catch (e2) {
    msg.textContent = e2.message; msg.className = 'profile-form-msg error';
  }
});

async function loadLicenseFeatures() {
  try {
    const data = await api('/api/admin/license/features');
    licenseFeaturesCache = data.features;
    renderLicenseFeatures();
  } catch (e) {
    document.querySelector('#admin-license-features-table tbody').innerHTML =
      `<tr><td colspan="5" class="muted">Nem sikerült betölteni: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderLicenseFeatures() {
  const tbody = document.querySelector('#admin-license-features-table tbody');
  if (!licenseFeaturesCache.length) { tbody.innerHTML = '<tr><td colspan="5" class="muted">Még nincs egyetlen funkció sem a katalógusban.</td></tr>'; return; }
  tbody.innerHTML = licenseFeaturesCache.map((f) => `
    <tr data-key="${escapeHtml(f.key)}">
      <td>${escapeHtml(f.nev)}</td>
      <td>${escapeHtml(f.leiras || '—')}</td>
      <td class="td-right">${fmtHuf(f.alapAr)}</td>
      <td><span class="licenc-badge licenc-badge--${f.aktiv ? 'ok' : 'none'}">${f.aktiv ? 'aktív' : 'kivezetve'}</span></td>
      <td>
        <button class="btn-tiny btn-license-feature-edit">Szerkesztés</button>
        <button class="btn-tiny btn-license-feature-delete">Törlés</button>
      </td>
    </tr>`).join('');

  tbody.querySelectorAll('.btn-license-feature-edit').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.closest('tr').dataset.key;
      const f = licenseFeaturesCache.find((x) => x.key === key);
      openLicenseFeatureModal(f);
    });
  });
  tbody.querySelectorAll('.btn-license-feature-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.closest('tr').dataset.key;
      const f = licenseFeaturesCache.find((x) => x.key === key);
      if (!confirm(`Biztosan törlöd ezt a funkciót a katalógusból: ${f.nev}?`)) return;
      try {
        await api('/api/admin/license/features/delete', { method: 'POST', body: JSON.stringify({ key }) });
        loadLicenseData();
      } catch (e) {
        if (e.data?.canForce) {
          const force = confirm(
            `${e.message}\n\nHa MOST folytatod, a funkció akkor is törlődik a katalógusból, és mind a(z) ${e.data.activeCount} cégnél automatikusan visszavonásra kerül — ezt nem lehet visszavonni. Folytatod?`
          );
          if (!force) return;
          try {
            await api('/api/admin/license/features/delete', { method: 'POST', body: JSON.stringify({ key, force: true }) });
            loadLicenseData();
          } catch (e2) {
            alert('Nem sikerült törölni: ' + e2.message);
          }
        } else {
          alert('Nem sikerült törölni: ' + e.message);
        }
      }
    });
  });
}

function openLicenseFeatureModal(f) {
  document.getElementById('license-feature-modal-title').textContent = f ? 'Funkció szerkesztése' : 'Új funkció';
  document.getElementById('license-feature-key').value = f ? f.key : '';
  document.getElementById('license-feature-nev').value = f ? f.nev : '';
  document.getElementById('license-feature-leiras').value = f ? (f.leiras || '') : '';
  document.getElementById('license-feature-ar').value = f ? f.alapAr : 0;
  document.getElementById('license-feature-aktiv').checked = f ? f.aktiv : true;
  document.getElementById('license-feature-msg').textContent = '';
  document.getElementById('license-feature-modal-backdrop').hidden = false;
}
listen('license-feature-new-btn', 'click', () => openLicenseFeatureModal(null));
listen('license-feature-remove-fake-btn', 'click', async () => {
  if (!confirm('Törlöd a katalógusból mindazt, ami nem a 12 valós Android-azonosító egyike? Csak azokat törli, amik SEHOL nincsenek kiosztva egyetlen cégnél sem.')) return;
  const btn = document.getElementById('license-feature-remove-fake-btn');
  btn.disabled = true; btn.textContent = 'Törlés…';
  try {
    const res = await api('/api/admin/license/features/remove-fake', { method: 'POST' });
    let msg = res.removed.length ? `Törölve: ${res.removed.join(', ')}` : 'Nem volt mit törölni.';
    if (res.skipped.length) msg += `\n\nKihagyva (mert kiosztva van):\n${res.skipped.join('\n')}`;
    alert(msg);
    loadLicenseFeatures();
  } catch (e) {
    alert('Nem sikerült: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Kamu funkciók törlése';
  }
});
listen('license-feature-seed-real-btn', 'click', async () => {
  const btn = document.getElementById('license-feature-seed-real-btn');
  btn.disabled = true; btn.textContent = 'Pótlás…';
  try {
    const res = await api('/api/admin/license/features/seed-real', { method: 'POST' });
    alert(res.added.length
      ? `Pótolva: ${res.added.join(', ')}`
      : 'Mind a 12 valós funkció már megvolt a katalógusban — nem volt mit pótolni.');
    loadLicenseFeatures();
  } catch (e) {
    alert('Nem sikerült: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Hiányzó valós funkciók pótlása';
  }
});
listen('license-feature-modal-close', 'click', () => {
  document.getElementById('license-feature-modal-backdrop').hidden = true;
});
listen('license-feature-modal-backdrop', 'click', (e) => {
  if (e.target.id === 'license-feature-modal-backdrop') e.target.hidden = true;
});
listen('license-feature-form', 'submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('license-feature-msg');
  msg.textContent = ''; msg.className = 'profile-form-msg';
  try {
    const body = {
      key: document.getElementById('license-feature-key').value || undefined,
      nev: document.getElementById('license-feature-nev').value.trim(),
      leiras: document.getElementById('license-feature-leiras').value.trim(),
      alapAr: Number(document.getElementById('license-feature-ar').value) || 0,
      aktiv: document.getElementById('license-feature-aktiv').checked,
    };
    await api('/api/admin/license/features/save', { method: 'POST', body: JSON.stringify(body) });
    document.getElementById('license-feature-modal-backdrop').hidden = true;
    loadLicenseData();
  } catch (e2) {
    msg.textContent = e2.message; msg.className = 'profile-form-msg error';
  }
});

async function loadLicenseCompanies() {
  try {
    const data = await api('/api/admin/license/companies');
    licenseCompaniesCache = data.companies;
    renderLicenseCompanies();
  } catch (e) {
    document.querySelector('#admin-licenc-table tbody').innerHTML =
      `<tr><td colspan="4" class="muted">Nem sikerült betölteni: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderLicenseCompanies() {
  const tbody = document.querySelector('#admin-licenc-table tbody');
  if (!licenseCompaniesCache.length) { tbody.innerHTML = '<tr><td colspan="4" class="muted">Még nincs egyetlen ismert cég sem.</td></tr>'; return; }
  tbody.innerHTML = licenseCompaniesCache.map((c) => {
    // Az összesítő jelvénynek az AKTÍV funkciókat kell mutatnia, akárhol
    // is lettek kiosztva — akár cégszinten (admin), akár egy konkrét
    // telephelyen (a cég saját, önkiszolgáló Profil-választása). Korábban
    // ez csak a cégszintű kiosztásokat számolta, ezért egy telephelyen
    // önkiszolgálóan bekapcsolt funkció tévesen "nincs kiosztva"-ként
    // jelent meg az áttekintésben.
    const aktivKulcsok = new Set(c.licenses.filter((l) => l.kiosztva).map((l) => l.key));
    for (const t of (c.telephelyek || [])) {
      for (const l of t.licenses) { if (l.kiosztva) aktivKulcsok.add(l.key); }
    }
    const osszesFunkcio = c.licenses.length;
    const summary = aktivKulcsok.size
      ? `<span class="licenc-badge licenc-badge--ok">${aktivKulcsok.size} / ${osszesFunkcio} funkció</span>`
      : '<span class="licenc-badge licenc-badge--none">nincs kiosztott funkció</span>';
    // Figyelmeztető jelvények CSAK akkor, ha tényleg van mire figyelni —
    // ez tartja rövidnek a sort a legtöbb cégnél.
    const warnings = [];
    if (!c.alapElofizetesAktiv) {
      warnings.push('<span class="licenc-badge licenc-badge--expired" title="Az alap havidíj nincs fizetve — minden funkció le van tiltva">⚠ regisztráció szünetel</span>');
    }
    if (c.eszkozLimit != null && c.eszkozSzam >= c.eszkozLimit) {
      warnings.push(`<span class="licenc-badge licenc-badge--expired" title="Betelt az eszközkorlát">⚠ ${c.eszkozSzam}/${c.eszkozLimit} eszköz</span>`);
    }
    if (c.effectiveInTrial) {
      warnings.push(`<span class="licenc-badge licenc-badge--warn" title="Amíg tart a próbaidő, minden funkció elérhető, a kiosztástól függetlenül">🎁 próbaidő — még ${c.effectiveTrialDaysLeft} nap</span>`);
    }
    return `
    <tr data-ceg="${escapeHtml(c.cegKulcs)}">
      <td>${escapeHtml(c.nev)}</td>
      <td class="ntak-uuid">${escapeHtml(c.adoszam)}</td>
      <td>${summary} ${warnings.join(' ')}</td>
      <td><button class="btn-tiny btn-license-manage">Kezelés</button></td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.btn-license-manage').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cegKulcs = btn.closest('tr').dataset.ceg;
      const c = licenseCompaniesCache.find((x) => x.cegKulcs === cegKulcs);
      openLicenseGrantModal(c);
    });
  });
}

async function loadLicenseDeviceList(cegKulcs) {
  const box = document.getElementById('license-device-list');
  box.innerHTML = 'Betöltés…';
  try {
    const data = await api(`/api/admin/license/devices?cegKulcs=${encodeURIComponent(cegKulcs)}`);
    if (!data.devices.length) { box.innerHTML = '<span class="muted">Még nincs regisztrált eszköz.</span>'; return; }
    box.innerHTML = data.devices.map((d) => `
      <div style="padding:7px 0;border-bottom:1px solid var(--line);">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
          <input class="license-device-nev-input" data-id="${d.id}" value="${escapeHtml(d.nev || '')}" placeholder="egyedi név (pl. 1-es kassza)" style="flex:1 1 160px;padding:5px 8px;border:1.5px solid var(--line);border-radius:6px;font-size:12.5px;">
          <button class="btn-tiny license-device-nev-save" data-id="${d.id}">Mentés</button>
          <button class="btn-tiny license-device-remove" data-id="${d.id}">Eltávolítás</button>
        </div>
        <div class="card-subtitle" style="margin-top:4px;" title="első látott: ${escapeHtml(d.elsoLatott)} · utolsó: ${escapeHtml(d.utolsoLatott)}">
          UUID: ${escapeHtml(d.eszkozAzonosito)}
          ${d.telephelyKod ? ` · telephely: ${escapeHtml(d.telephelyKod)}` : ''}
          ${d.progtip ? ` · ${escapeHtml(d.progtip)}` : ' · programtípus még ismeretlen'}${d.verzio ? ` (v${escapeHtml(d.verzio)})` : ''}
        </div>
      </div>`).join('');
    box.querySelectorAll('.license-device-nev-save').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const input = box.querySelector(`.license-device-nev-input[data-id="${btn.dataset.id}"]`);
        try {
          await api('/api/admin/license/devices/rename', { method: 'POST', body: JSON.stringify({ id: Number(btn.dataset.id), nev: input.value }) });
        } catch (e) { alert('Nem sikerült: ' + e.message); }
      });
    });
    box.querySelectorAll('.license-device-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Eltávolítod ezt az eszközt a regisztráltak közül? A felszabaduló hely után az eszköz újra tudna regisztrálni (vagy egy másik).')) return;
        try {
          await api('/api/admin/license/devices/remove', { method: 'POST', body: JSON.stringify({ id: Number(btn.dataset.id) }) });
          loadLicenseDeviceList(cegKulcs);
          loadLicenseData();
        } catch (e) { alert('Nem sikerült: ' + e.message); }
      });
    });
  } catch (e) {
    box.innerHTML = `<span class="muted">${escapeHtml(e.message)}</span>`;
  }
}

async function loadLicenseEffectiveStatus(cegKulcs) {
  const box = document.getElementById('license-effective-content');
  box.textContent = 'Betöltés…';
  box.className = 'muted';
  try {
    const data = await api(`/api/admin/license/effective?cegKulcs=${encodeURIComponent(cegKulcs)}`);
    if (!data.alapElofizetesAktiv) {
      box.innerHTML = '<span class="licenc-badge licenc-badge--expired">⚠ Alap regisztráció szünetel — az app MINDEN funkciót letiltva lát, függetlenül a kiosztástól.</span>';
      return;
    }
    const trialNote = data.inTrial ? ' <span class="licenc-badge licenc-badge--none">próbaidőszak — emiatt lát mindent</span>' : '';
    if (!data.funkciok.length) {
      box.innerHTML = `Nincs egyetlen engedélyezett funkció sem ennél a cégnél.${trialNote}`;
      return;
    }
    box.innerHTML = `${data.funkciok.map((k) => `<span class="licenc-badge licenc-badge--ok" style="margin:2px 4px 2px 0;font-family:var(--font-mono);">${escapeHtml(k)}</span>`).join('')}${trialNote}`;
  } catch (e) {
    box.textContent = 'Nem sikerült betölteni: ' + e.message;
  }
}

function openLicenseGrantModal(c) {
  loadLicenseEffectiveStatus(c.cegKulcs);
  document.getElementById('license-effective-refresh-btn').onclick = () => loadLicenseEffectiveStatus(c.cegKulcs);

  document.getElementById('license-device-limit').value = c.eszkozLimit != null ? c.eszkozLimit : '';
  document.getElementById('license-device-limit-save').onclick = async () => {
    try {
      const val = document.getElementById('license-device-limit').value;
      await api('/api/admin/license/device-limit', {
        method: 'POST',
        body: JSON.stringify({ cegKulcs: c.cegKulcs, eszkozLimit: val ? Number(val) : 0 }),
      });
      loadLicenseData();
    } catch (e) { alert('Nem sikerült: ' + e.message); }
  };
  const trialCurrent = document.getElementById('license-trial-current');
  const trialInput = document.getElementById('license-trial-napok');
  const trialMsg = document.getElementById('license-trial-msg');
  trialMsg.textContent = '';
  if (c.probaKezi) {
    trialCurrent.textContent = c.probaNapokHatra > 0
      ? `Kézzel beállítva — jelenleg ${c.probaNapokHatra} nap van hátra (lejár: ${c.probaVege}).`
      : 'Kézzel beállítva — nincs próbaidő (0 nap).';
    trialInput.value = c.probaNapokHatra;
  } else {
    trialCurrent.textContent = 'Jelenleg az automatikus próbaidő-logika érvényes (az első szinkrontól számítva).';
    trialInput.value = '';
  }
  document.getElementById('license-trial-save').onclick = async () => {
    trialMsg.textContent = 'Mentés…'; trialMsg.style.color = 'var(--text-dim)';
    try {
      await api('/api/admin/license/trial', { method: 'POST', body: JSON.stringify({ cegKulcs: c.cegKulcs, napok: trialInput.value }) });
      trialMsg.textContent = '✓ Mentve'; trialMsg.style.color = 'var(--jade-deep)';
      loadLicenseData();
    } catch (e) { trialMsg.textContent = e.message; trialMsg.style.color = 'var(--brick)'; }
  };
  document.getElementById('license-trial-reset').onclick = async () => {
    trialMsg.textContent = 'Visszaállítás…'; trialMsg.style.color = 'var(--text-dim)';
    try {
      await api('/api/admin/license/trial', { method: 'POST', body: JSON.stringify({ cegKulcs: c.cegKulcs, napok: null }) });
      trialMsg.textContent = '✓ Automatikusra állítva'; trialMsg.style.color = 'var(--jade-deep)';
      loadLicenseData();
    } catch (e) { trialMsg.textContent = e.message; trialMsg.style.color = 'var(--brick)'; }
  };

  loadLicenseDeviceList(c.cegKulcs);

  const subCheckbox = document.getElementById('license-subscription-aktiv');
  const subMegjegyzes = document.getElementById('license-subscription-megjegyzes');
  const subMsg = document.getElementById('license-subscription-msg');
  subCheckbox.checked = c.alapElofizetesAktiv;
  subMegjegyzes.value = c.alapMegjegyzes || '';
  subMsg.textContent = '';
  document.getElementById('license-subscription-save').onclick = async () => {
    subMsg.textContent = 'Mentés…'; subMsg.style.color = 'var(--text-dim)';
    try {
      await api('/api/admin/license/subscription', {
        method: 'POST',
        body: JSON.stringify({ cegKulcs: c.cegKulcs, aktiv: subCheckbox.checked, megjegyzes: subMegjegyzes.value }),
      });
      subMsg.textContent = '✓ Mentve'; subMsg.style.color = 'var(--jade-deep)';
      loadLicenseData();
    } catch (e) {
      subMsg.textContent = e.message; subMsg.style.color = 'var(--brick)';
    }
  };
  document.getElementById('license-grant-modal-backdrop').hidden = false;
  renderLicenseTelephelyBreakdown(c);
}

function renderLicenseTelephelyBreakdown(c) {
  const box = document.getElementById('license-telephely-breakdown');
  if (!c.telephelyek || !c.telephelyek.length) {
    box.innerHTML = '<p class="muted">Ennek a cégnek nincs regisztrált telephelye.</p>';
    return;
  }
  box.innerHTML = c.telephelyek.map((t) => `
    <div style="margin-bottom:16px;">
      <div style="font-weight:700;font-size:13px;margin-bottom:6px;">📍 ${escapeHtml(t.nev || t.kod)} <span class="muted" style="font-weight:400;">(${escapeHtml(t.kod)})</span></div>
      ${t.licenses.filter((l) => l.katalogusAktiv || l.kiosztva).map((l) => `
        <label class="license-site-row" data-kod="${escapeHtml(t.kod)}" data-key="${escapeHtml(l.key)}"
               style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:12.5px;cursor:pointer;">
          <input type="checkbox" class="license-site-toggle" ${l.aktiv ? 'checked' : ''}>
          <span style="flex:1;">${escapeHtml(l.nev)}${!l.katalogusAktiv ? ' <span class="muted">(törölve a katalógusból)</span>' : ''}</span>
          ${l.fizetosElofizetes ? `<span class="licenc-badge licenc-badge--ok" style="font-size:10px;" title="myPOS kártya-tokennel, havonta automatikusan megújuló előfizetés">💳 fizetett${l.lejarat ? ` (${escapeHtml(l.lejarat)}-ig)` : ''}</span>` : ''}
          ${l.sajatTelephelySpecifikus
            ? '<span class="licenc-badge licenc-badge--ok" style="font-size:10px;">saját</span>'
            : (l.aktiv ? '<span class="licenc-badge licenc-badge--none" style="font-size:10px;">cégszintűről örökölt</span>' : '')}
        </label>`).join('')}
    </div>`).join('');

  box.querySelectorAll('.license-site-toggle').forEach((cb) => {
    cb.addEventListener('change', async (e) => {
      const row = e.target.closest('.license-site-row');
      const telephelyKod = row.dataset.kod;
      const featureKey = row.dataset.key;
      const aktiv = e.target.checked;
      e.target.disabled = true;
      try {
        if (aktiv) {
          const feature = licenseFeaturesCache.find((f) => f.key === featureKey);
          await api('/api/admin/license/grant', {
            method: 'POST',
            body: JSON.stringify({ cegKulcs: c.cegKulcs, telephelyKod, featureKey, ar: feature?.alapAr || 0 }),
          });
        } else {
          await api('/api/admin/license/revoke', { method: 'POST', body: JSON.stringify({ cegKulcs: c.cegKulcs, telephelyKod, featureKey }) });
        }
        await loadLicenseCompanies();
        const fresh = licenseCompaniesCache.find((x) => x.cegKulcs === c.cegKulcs);
        renderLicenseTelephelyBreakdown(fresh);
      } catch (err) {
        alert('Nem sikerült menteni: ' + err.message);
        e.target.checked = !aktiv;
        e.target.disabled = false;
      }
    });
  });
}
listen('license-grant-modal-close', 'click', () => {
  document.getElementById('license-grant-modal-backdrop').hidden = true;
});
listen('license-grant-modal-backdrop', 'click', (e) => {
  if (e.target.id === 'license-grant-modal-backdrop') e.target.hidden = true;
});

/* ============================================================
   Admin — felhasználó meghívása (viszonteladó / cégtulajdonos / üzletvezető)
   ============================================================ */
/* ============================================================
   Admin — felhasználók listája, csoportosítás, szerkesztés, törlés
   ============================================================ */
let adminUsersCache = [];
let adminCompaniesCache = [];
let adminNtakCache = [];
const adminCompaniesPaginator = new Paginator();
const adminNtakPaginator = new Paginator();
let adminResellersCache = [];
let adminUsersRoleFilter = '';
const adminUsersPaginator = new Paginator();

async function loadAdminUsers() {
  try {
    const data = await api('/api/admin/users');
    adminUsersCache = data.users;
    document.getElementById('admin-users-count').textContent = data.users.length;
    renderAdminUsers();
  } catch (e) {
    document.querySelector('#admin-users-table tbody').innerHTML = `<tr><td colspan="5" class="muted">Nem sikerült betölteni: ${escapeHtml(e.message)}</td></tr>`;
  }
}

const ADMIN_STATUS_LABELS = { active: 'aktív', pending: 'meghívás függőben', disabled: 'letiltva' };
const ADMIN_ROLE_LABELS = { reseller: 'Viszonteladók', owner: 'Cégtulajdonosok', manager: 'Üzletvezetők' };

function adminUserScopeLabel(u) {
  if (u.role === 'reseller') return 'saját ügyfelek';
  if (u.role === 'manager') return `${u.cegNev || u.cegKulcs} — ${u.telephelyNev || u.telephelyKod}`;
  return u.cegNev || u.cegKulcs || '—';
}

function renderAdminUserRow(u) {
  return `
    <tr data-id="${u.id}">
      <td>${escapeHtml(u.nev)}</td>
      <td>${escapeHtml(u.email)}</td>
      <td>${escapeHtml(ADMIN_ROLE_LABELS[u.role] || u.role)}</td>
      <td><span class="licenc-badge licenc-badge--${u.status === 'active' ? 'ok' : u.status === 'pending' ? 'warn' : 'none'}">${ADMIN_STATUS_LABELS[u.status] || u.status}</span></td>
      <td><button class="btn-tiny btn-admin-user-edit">Részletek</button></td>
    </tr>`;
}

function renderAdminUsers() {
  if (!adminUsersCache.length) {
    document.querySelector('#admin-users-table tbody').innerHTML = '<tr><td colspan="5" class="muted">Még nincs egyetlen felhasználó sem.</td></tr>';
    document.getElementById('admin-users-pagination').innerHTML = '';
    return;
  }
  const filtered = adminUsersRoleFilter
    ? adminUsersCache.filter((u) => u.role === adminUsersRoleFilter)
    : adminUsersCache;
  const tbody = document.querySelector('#admin-users-table tbody');
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">Nincs találat ezzel a szűréssel.</td></tr>';
    document.getElementById('admin-users-pagination').innerHTML = '';
    return;
  }
  const pageData = adminUsersPaginator.slice(filtered);
  tbody.innerHTML = pageData.map(renderAdminUserRow).join('');
  adminUsersPaginator.renderControls(document.getElementById('admin-users-pagination'), renderAdminUsers);

  tbody.querySelectorAll('.btn-admin-user-edit').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.closest('tr').dataset.id);
      const u = adminUsersCache.find((x) => x.id === id);
      document.getElementById('user-edit-id').value = u.id;
      document.getElementById('user-edit-email').value = u.email;
      document.getElementById('user-edit-nev').value = u.nev;
      document.getElementById('user-edit-status').value = u.status;
      document.getElementById('user-edit-msg').textContent = '';
      const cegFields = document.getElementById('user-edit-ceg-fields');
      const telephelyField = document.getElementById('user-edit-telephely-field');
      cegFields.hidden = (u.role === 'reseller');
      telephelyField.hidden = (u.role !== 'manager');
      document.getElementById('user-edit-adoszam').value = u.cegKulcs || '';
      document.getElementById('user-edit-telephely').value = u.telephelyKod || '';

      document.querySelector('#user-edit-info-kv tbody').innerHTML = `
        <tr><td>Hatókör</td><td>${escapeHtml(adminUserScopeLabel(u))}</td></tr>
        <tr><td>Meghívta</td><td>${escapeHtml(u.invitedBy || '—')}</td></tr>
        <tr><td>Létrehozva</td><td>${fmtDateTime(u.createdAt)}</td></tr>`;

      document.getElementById('user-edit-reset-link-btn').onclick = async () => {
        if (!confirm(`Generálunk egy azonnal használható, 2 óráig érvényes jelszó-visszaállító linket ${u.nev} (${u.email}) részére. Ezt neked kell eljuttatnod hozzá (pl. telefonon felolvasva, vagy másik csatornán elküldve). Folytatod?`)) return;
        try {
          const res = await api('/api/admin/users/reset-link', { method: 'POST', body: JSON.stringify({ id: u.id }) });
          prompt('Másold ki és küldd el ezt a linket a felhasználónak (2 óráig érvényes):', res.link);
        } catch (e) { alert('Nem sikerült: ' + e.message); }
      };
      document.getElementById('user-edit-clear-lockout-btn').onclick = async () => {
        try {
          const res = await api('/api/admin/users/clear-lockout', { method: 'POST', body: JSON.stringify({ id: u.id }) });
          alert(res.removed > 0
            ? `Feloldva — ${u.nev} most már újra tud próbálkozni a bejelentkezéssel.`
            : `${u.nev} jelenleg nem volt zárolva (lehet, hogy már magától lejárt, vagy más okból nem tud belépni).`);
        } catch (e) { alert('Nem sikerült: ' + e.message); }
      };
      document.getElementById('user-edit-delete-btn').onclick = async () => {
        if (!confirm(`Biztosan törlöd ezt a felhasználót: ${u.nev} (${u.email})? Ez nem visszavonható.`)) return;
        try {
          await api('/api/admin/users/delete', { method: 'POST', body: JSON.stringify({ id: u.id }) });
          document.getElementById('user-edit-modal-backdrop').hidden = true;
          loadAdminUsers();
        } catch (e) { alert('Nem sikerült törölni: ' + e.message); }
      };

      document.getElementById('user-edit-modal-backdrop').hidden = false;
    });
  });
}

document.getElementById('admin-users-role-filter').addEventListener('change', (e) => {
  adminUsersRoleFilter = e.target.value;
  adminUsersPaginator.page = 1;
  renderAdminUsers();
});


listen('user-edit-modal-close', 'click', () => {
  document.getElementById('user-edit-modal-backdrop').hidden = true;
});
listen('user-edit-modal-backdrop', 'click', (e) => {
  if (e.target.id === 'user-edit-modal-backdrop') e.target.hidden = true;
});
listen('user-edit-form', 'submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('user-edit-msg');
  msg.textContent = ''; msg.className = 'profile-form-msg';
  try {
    const id = Number(document.getElementById('user-edit-id').value);
    const nev = document.getElementById('user-edit-nev').value.trim();
    const status = document.getElementById('user-edit-status').value;
    const cegKulcs = document.getElementById('user-edit-adoszam').value.trim();
    const telephelyKod = document.getElementById('user-edit-telephely').value.trim();
    await api('/api/admin/users/update', { method: 'POST', body: JSON.stringify({ id, nev, status, cegKulcs, telephelyKod }) });
    document.getElementById('user-edit-modal-backdrop').hidden = true;
    loadAdminUsers();
  } catch (e2) {
    msg.textContent = e2.message; msg.className = 'profile-form-msg error';
  }
});

function updateAdminInviteFields() {
  const role = document.getElementById('admin-invite-role').value;
  document.getElementById('admin-invite-ceg-fields').hidden = (role === 'reseller');
  document.getElementById('admin-invite-telephely-field').hidden = (role !== 'manager');
}
listen('admin-invite-role', 'change', updateAdminInviteFields);
updateAdminInviteFields();

listen('admin-invite-form', 'submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('admin-invite-msg');
  msg.textContent = ''; msg.className = 'profile-form-msg';
  try {
    const role = document.getElementById('admin-invite-role').value;
    const body = {
      role,
      email: document.getElementById('admin-invite-email').value.trim(),
    };
    if (role !== 'reseller') body.adoszam = document.getElementById('admin-invite-adoszam').value.trim();
    if (role === 'manager') body.telephelyKod = document.getElementById('admin-invite-telephely').value.trim();
    const res = await api('/api/admin/invite-user', { method: 'POST', body: JSON.stringify(body) });
    document.getElementById('admin-invite-form').reset();
    updateAdminInviteFields();
    msg.textContent = res.emailWarning
      ? `✓ Meghívó létrehozva, de az email küldése nem sikerült (${res.emailWarning}). Küldd el kézzel ezt a linket: ${res.inviteLink}`
      : '✓ Meghívó elküldve.';
    msg.className = res.emailWarning ? 'profile-form-msg error' : 'profile-form-msg ok';
    loadAdminUsers();
  } catch (e2) {
    msg.textContent = e2.message; msg.className = 'profile-form-msg error';
  }
});

function handleLoginSuccess(data) {
  loggedIn = true;
  state.viaAdmin = false;
  stockProductsLoaded = false;
  if (!data.telephelyValasztva) {
    showTelephelyScreen();
    loadTelephelyPicker(data.company.nev);
    return;
  }
  document.getElementById('company-name').textContent = data.company.nev;
  updateTelephelyBadge(data.company.telephelyNev);
  if (data.vanAdat === false) {
    // Frissen (pl. viszonteladó által) létrehozott cég/telephely, amire
    // még nem érkezett androidos szinkron — a normál nézet minden
    // adatlekérdezése elutasításra kerülne, ami hamis kiléptetést okozna.
    document.getElementById('telephely-waiting-nev').textContent = data.company.telephelyNev || '—';
    document.getElementById('telephely-waiting-kod').textContent = '01';
    showTelephelyWaitingScreen();
    return;
  }
  showApp();
  boot();
}

listen('logout-btn', 'click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  loggedIn = false;
  state.viaAdmin = false;
  showLandingScreen();
});
listen('back-to-admin-btn', 'click', () => {
  showAdmin();
  loadAdminOverview();
  loadAdminActivity();
});

/* ============================================================
   Admin belépés + panel
   ============================================================ */
listen('show-admin-login', 'click', (e) => { e.preventDefault(); showAdminLogin(); });

/* ============================================================
   Kezdőoldal — 2 csempe
   ============================================================ */
function showLandingScreen() { hideAllScreens(); landingScreen.hidden = false; }
listen('show-reseller-login-link', 'click', (e) => { e.preventDefault(); showResellerLogin(); });

listen('user-login-form', 'submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('user-login-btn');
  const err = document.getElementById('user-login-error');
  err.hidden = true;
  btn.disabled = true; btn.textContent = 'Belépés…';
  try {
    const email = document.getElementById('user-email-input').value;
    const password = document.getElementById('user-password-input').value;
    const data = await api('/api/auth/user-login', { method: 'POST', body: JSON.stringify({ email, password }) });
    handleLoginSuccess(data);
  } catch (e2) {
    err.textContent = e2.message === 'NOT_AUTHENTICATED' ? 'Hibás email cím vagy jelszó.' : e2.message;
    err.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = 'Belépés';
  }
});

/* ============================================================
   Viszonteladói bejelentkezés
   ============================================================ */
function showResellerLogin() { hideAllScreens(); document.getElementById('reseller-login-screen').hidden = false; }
listen('reseller-back-link', 'click', (e) => { e.preventDefault(); showLandingScreen(); });

function showResellerDashboard() { hideAllScreens(); resellerScreen.hidden = false; }

let resellerCompaniesCache = [];
const resellerCompaniesPaginator = new Paginator();
let resellerCompaniesSort = { key: 'nev', dir: 'asc' };

async function loadResellerOverview() {
  try {
    const data = await api('/api/reseller/overview');
    document.getElementById('reseller-name').textContent = data.reseller.nev;
    document.getElementById('reseller-company-count').textContent = data.companies.length;
    resellerCompaniesCache = data.companies;
    renderResellerCompaniesTable();
  } catch (e) {
    alert('Nem sikerült betölteni: ' + e.message);
  }
}

function renderResellerCompaniesTable() {
  const { key, dir } = resellerCompaniesSort;
  const sorted = [...resellerCompaniesCache].sort((a, b) => {
    const av = a[key] ?? '', bv = b[key] ?? '';
    const cmp = String(av).localeCompare(String(bv), 'hu', { numeric: true });
    return dir === 'asc' ? cmp : -cmp;
  });
  document.querySelectorAll('#reseller-companies-table .reg-sortable').forEach((th) => {
    th.querySelector('.sort-arrow')?.remove();
    if (th.dataset.sort === key) {
      th.insertAdjacentHTML('beforeend', `<span class="sort-arrow">${dir === 'asc' ? '▲' : '▼'}</span>`);
    }
  });
  const tbody = document.querySelector('#reseller-companies-table tbody');
  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">Még nincs egyetlen ügyfeled sem.</td></tr>';
    document.getElementById('reseller-companies-pagination').innerHTML = '';
    return;
  }
  const pageData = resellerCompaniesPaginator.slice(sorted);
  tbody.innerHTML = pageData.map((c) => `
    <tr>
      <td>${escapeHtml(c.nev)}</td>
      <td>${escapeHtml(c.telephelyNev || c.telephelyKod)}</td>
      <td class="ntak-uuid">${escapeHtml(c.adoszam)}</td>
      <td>${escapeHtml(c.varos || '—')}</td>
      <td>${c.lastSync ? fmtDateTime(c.lastSync) : '—'}</td>
    </tr>`).join('');
  resellerCompaniesPaginator.renderControls(document.getElementById('reseller-companies-pagination'), renderResellerCompaniesTable);
}
document.querySelectorAll('#reseller-companies-table .reg-sortable').forEach((th) => {
  th.addEventListener('click', () => {
    if (resellerCompaniesSort.key === th.dataset.sort) {
      resellerCompaniesSort.dir = resellerCompaniesSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      resellerCompaniesSort = { key: th.dataset.sort, dir: 'asc' };
    }
    renderResellerCompaniesTable();
  });
});

listen('reseller-logout-btn', 'click', async () => {
  await api('/api/auth/reseller-logout', { method: 'POST' }).catch(() => {});
  showResellerLogin();
});

listen('reseller-invite-form', 'submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('reseller-invite-msg');
  msg.textContent = ''; msg.className = 'profile-form-msg';
  try {
    const adoszam = document.getElementById('reseller-invite-adoszam').value.trim();
    const email = document.getElementById('reseller-invite-email').value.trim();
    const res = await api('/api/reseller/invite-owner', { method: 'POST', body: JSON.stringify({ adoszam, email }) });
    document.getElementById('reseller-invite-form').reset();
    msg.textContent = res.emailWarning
      ? `✓ Meghívó létrehozva, de az email küldése nem sikerült (${res.emailWarning}). Küldd el kézzel ezt a linket: ${res.inviteLink}`
      : '✓ Meghívó elküldve.';
    msg.className = res.emailWarning ? 'profile-form-msg error' : 'profile-form-msg ok';
    loadResellerOverview();
  } catch (e2) {
    msg.textContent = e2.message; msg.className = 'profile-form-msg error';
  }
});

listen('reseller-login-form', 'submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('reseller-login-btn');
  const err = document.getElementById('reseller-login-error');
  err.hidden = true;
  btn.disabled = true; btn.textContent = 'Belépés…';
  try {
    const email = document.getElementById('reseller-email-input').value;
    const password = document.getElementById('reseller-password-input').value;
    await api('/api/auth/reseller-login', { method: 'POST', body: JSON.stringify({ email, password }) });
    showResellerDashboard();
    loadResellerOverview();
  } catch (e2) {
    err.textContent = e2.message === 'NOT_AUTHENTICATED' ? 'Hibás email cím vagy jelszó.' : e2.message;
    err.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = 'Belépés';
  }
});

/* ============================================================
   Meghívó elfogadása (?meghivo=TOKEN a URL-ben)
   ============================================================ */
async function checkInviteLink() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('meghivo');
  if (!token) return false;
  hideAllScreens();
  document.getElementById('invite-accept-screen').hidden = false;
  document.getElementById('invite-accept-extra-fields').hidden = false;
  document.getElementById('invite-accept-legal-fields').hidden = false;
  const sub = document.getElementById('invite-accept-sub');
  try {
    const info = await api(`/api/invite/info?token=${encodeURIComponent(token)}`);
    sub.textContent = info.cegNev
      ? `${info.roleLabel} jogosultság — ${info.cegNev} (${info.adoszam}) — ${info.email}`
      : `${info.roleLabel} jogosultság — ${info.email}`;
  } catch (e) {
    sub.textContent = e.message;
    document.getElementById('invite-accept-form').hidden = true;
    return true;
  }
  listen('invite-accept-form', 'submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('invite-accept-error');
    err.hidden = true;
    const nev = document.getElementById('invite-nev-input').value.trim();
    const telefon = document.getElementById('invite-telefon-input').value.trim();
    const p1 = document.getElementById('invite-password-input').value;
    const p2 = document.getElementById('invite-password-input2').value;
    const gdprAccepted = document.getElementById('invite-gdpr-checkbox').checked;
    const aszfAccepted = document.getElementById('invite-aszf-checkbox').checked;
    if (p1 !== p2) { err.textContent = 'A két jelszó nem egyezik.'; err.hidden = false; return; }
    if (!gdprAccepted || !aszfAccepted) { err.textContent = 'Az Adatkezelési tájékoztató és az ÁSZF elfogadása kötelező.'; err.hidden = false; return; }
    const btn = document.getElementById('invite-accept-btn');
    btn.disabled = true; btn.textContent = 'Mentés…';
    try {
      await api('/api/invite/accept', { method: 'POST', body: JSON.stringify({ token, nev, telefon, password: p1, gdprAccepted, aszfAccepted }) });
      document.getElementById('invite-accept-form').hidden = true;
      document.getElementById('invite-accept-success').hidden = false;
    } catch (e2) {
      err.textContent = e2.message; err.hidden = false;
      btn.disabled = false; btn.textContent = 'Fiók aktiválása';
    }
  }, { once: true });
  return true;
}

listen('show-company-login', 'click', (e) => { e.preventDefault(); showLandingScreen(); });

const LEGAL_DOCS = {
  gdpr: {
    title: 'Adatkezelési tájékoztató',
    body: `<p><b>Ideiglenes szöveg — a végleges Adatkezelési tájékoztatót a jogi/adatvédelmi felülvizsgálat után kell ide betölteni.</b></p>
      <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>
      <p>Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>
      <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>`,
  },
  aszf: {
    title: 'Általános Szerződési Feltételek',
    body: `<p><b>Ideiglenes szöveg — a végleges Általános Szerződési Feltételeket a jogi felülvizsgálat után kell ide betölteni.</b></p>
      <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>
      <p>Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>
      <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>`,
  },
};
function openLegalDocModal(key) {
  const doc = LEGAL_DOCS[key];
  if (!doc) return;
  document.getElementById('legal-doc-modal-title').textContent = doc.title;
  document.getElementById('legal-doc-modal-body').innerHTML = doc.body;
  document.getElementById('legal-doc-modal-backdrop').hidden = false;
}
listen('invite-gdpr-link', 'click', (e) => { e.preventDefault(); openLegalDocModal('gdpr'); });
listen('invite-aszf-link', 'click', (e) => { e.preventDefault(); openLegalDocModal('aszf'); });
listen('legal-doc-modal-close', 'click', () => { document.getElementById('legal-doc-modal-backdrop').hidden = true; });
listen('legal-doc-modal-backdrop', 'click', (e) => {
  if (e.target.id === 'legal-doc-modal-backdrop') e.target.hidden = true;
});

function openForgotPasswordModal() {
  document.getElementById('forgot-password-email').value = '';
  document.getElementById('forgot-password-msg').textContent = '';
  document.getElementById('forgot-password-modal-backdrop').hidden = false;
}
listen('user-forgot-password-link', 'click', (e) => { e.preventDefault(); openForgotPasswordModal(); });
listen('reseller-forgot-password-link', 'click', (e) => { e.preventDefault(); openForgotPasswordModal(); });
listen('forgot-password-modal-close', 'click', () => {
  document.getElementById('forgot-password-modal-backdrop').hidden = true;
});
listen('forgot-password-modal-backdrop', 'click', (e) => {
  if (e.target.id === 'forgot-password-modal-backdrop') e.target.hidden = true;
});
listen('forgot-password-form', 'submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('forgot-password-msg');
  const email = document.getElementById('forgot-password-email').value.trim();
  msg.textContent = 'Küldés…';
  try {
    const res = await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
    msg.textContent = res.message;
    document.getElementById('forgot-password-form').querySelector('button[type="submit"]').disabled = true;
  } catch (e2) {
    msg.textContent = e2.message;
  }
});

/* ============================================================
   Jelszó visszaállítása (?jelszo-visszaallitas=TOKEN a URL-ben) —
   ugyanazt a képernyőt/űrlapot használja, mint a meghívó-elfogadás,
   csak más végpontokkal és feliratokkal.
   ============================================================ */
async function checkResetPasswordLink() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('jelszo-visszaallitas');
  if (!token) return false;
  hideAllScreens();
  document.getElementById('invite-accept-screen').hidden = false;
  document.getElementById('invite-accept-extra-fields').hidden = true;
  document.getElementById('invite-accept-legal-fields').hidden = true;
  document.getElementById('invite-accept-title').textContent = 'Jelszó visszaállítása';
  document.getElementById('invite-accept-btn').textContent = 'Új jelszó mentése';
  const sub = document.getElementById('invite-accept-sub');
  try {
    const info = await api(`/api/auth/reset-password/check?token=${encodeURIComponent(token)}`);
    sub.textContent = `Szia, ${info.nev}! Add meg az új jelszavad.`;
  } catch (e) {
    sub.textContent = e.message;
    document.getElementById('invite-accept-form').hidden = true;
    return true;
  }
  listen('invite-accept-form', 'submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('invite-accept-error');
    err.hidden = true;
    const p1 = document.getElementById('invite-password-input').value;
    const p2 = document.getElementById('invite-password-input2').value;
    if (p1 !== p2) { err.textContent = 'A két jelszó nem egyezik.'; err.hidden = false; return; }
    const btn = document.getElementById('invite-accept-btn');
    btn.disabled = true; btn.textContent = 'Mentés…';
    try {
      await api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password: p1 }) });
      document.getElementById('invite-accept-form').hidden = true;
      document.getElementById('invite-accept-success').hidden = false;
      document.getElementById('invite-accept-success').innerHTML = '✓ A jelszavad sikeresen megváltozott. <a href="/">Jelentkezz be itt.</a>';
    } catch (e2) {
      err.textContent = e2.message; err.hidden = false;
      btn.disabled = false; btn.textContent = 'Új jelszó mentése';
    }
  }, { once: true });
  return true;
}

/* ============================================================
   Telephely-választó és -karbantartó
   ============================================================ */
async function loadTelephelyPicker(cegNevFallback) {
  document.getElementById('telephely-ceg-nev').textContent = cegNevFallback || '—';
  try {
    const data = await api('/api/telephelyek');
    document.getElementById('telephely-ceg-nev').textContent = data.cegNev;
    const list = document.getElementById('telephely-list');
    list.innerHTML = '';
    data.telephelyek.forEach((t) => {
      const btn = document.createElement('button');
      btn.className = 'telephely-item';
      btn.innerHTML = `
        <div>
          <div class="telephely-item-nev">${escapeHtml(t.nev)}</div>
          <div class="telephely-item-meta">${escapeHtml(t.cim || 'nincs megadva cím')}${t.utolsoSzinkron ? ' · szinkron: ' + fmtDateTime(t.utolsoSzinkron) : ''}</div>
        </div>
        ${!t.vanAdat ? '<span class="telephely-item-badge">még nincs adat</span>' : ''}`;
      btn.addEventListener('click', () => selectTelephely(t.kod));
      list.appendChild(btn);
    });
  } catch (e) {
    alert('Nem sikerült betölteni a telephelyeket: ' + e.message);
  }
}

async function selectTelephely(kod) {
  try {
    const data = await api('/api/telephely/select', { method: 'POST', body: JSON.stringify({ telephelyKod: kod }) });
    document.getElementById('company-name').textContent = data.company.nev;
    updateTelephelyBadge(data.company.telephelyNev);
    if (!data.vanAdat) {
      // Még nem érkezett hozzá androidos szinkron — a normál nézet
      // (Áttekintés stb.) minden adatlekérdezése elutasításra kerülne,
      // ami hamis "munkamenet lejárt" kiléptetést okozna. Ehelyett egy
      // magyarázó "vár még adatra" képernyőt mutatunk.
      document.getElementById('telephely-waiting-nev').textContent = data.company.telephelyNev || '—';
      document.getElementById('telephely-waiting-kod').textContent = kod;
      showTelephelyWaitingScreen();
      return;
    }
    showApp();
    boot();
  } catch (e) {
    alert('Nem sikerült kiválasztani a telephelyet: ' + e.message);
  }
}

listen('telephely-waiting-back-btn', 'click', () => {
  showTelephelyScreen();
  loadTelephelyPicker();
});

function updateTelephelyBadge(telephelyNev) {
  const box = document.getElementById('telephely-current');
  const clean = (telephelyNev && telephelyNev !== 'undefined' && telephelyNev !== 'null') ? String(telephelyNev).trim() : '';
  if (clean) {
    document.getElementById('telephely-current-nev').textContent = clean;
    box.hidden = false;
  } else {
    box.hidden = true;
  }
}

listen('telephely-new-form', 'submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('telephely-new-btn');
  const err = document.getElementById('telephely-new-error');
  err.hidden = true;
  btn.disabled = true; btn.textContent = 'Létrehozás…';
  try {
    const kod = document.getElementById('telephely-new-kod').value.trim();
    const nev = document.getElementById('telephely-new-nev').value.trim();
    const cim = document.getElementById('telephely-new-cim').value.trim();
    await api('/api/telephely/create', { method: 'POST', body: JSON.stringify({ kod, nev, cim }) });
    document.getElementById('telephely-new-form').reset();
    loadTelephelyPicker();
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = 'Létrehozás';
  }
});

listen('telephely-switch-link', 'click', (e) => {
  e.preventDefault();
  showTelephelyScreen();
  loadTelephelyPicker();
});

listen('telephely-logout-link', 'click', async (e) => {
  e.preventDefault();
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  loggedIn = false;
  showLandingScreen();
});

listen('admin-login-form', 'submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('admin-login-btn');
  const err = document.getElementById('admin-login-error');
  err.hidden = true;
  btn.disabled = true; btn.textContent = 'Belépés…';
  try {
    const password = document.getElementById('admin-password-input').value;
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
    showAdmin();
    loadAdminOverview();
    loadAdminActivity();
  } catch (e2) {
    err.textContent = e2.message === 'NOT_AUTHENTICATED' ? 'Hibás jelszó.' : e2.message;
    err.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = 'Belépés';
  }
});

listen('admin-logout-btn', 'click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLandingScreen();
});

const NTAK_ADMIN_STATUS_LABELS = { TELJESEN_HIBAS: 'Teljesen hibás', RESZBEN_SIKERES: 'Részben sikeres' };

// Informatív, sok-mutatós áttekintő rács az admin kezdőoldalára — minden
// kártya egy-egy önmagában értelmezhető, azonnal hasznos szám.
function renderAdminOverview(s) {
  if (!s) return;
  const root = document.getElementById('admin-overview-root');

  /* --- 1. sor: a négy legfontosabb szám, alárendelt kontextussal --- */
  const roleParts = [];
  if (s.usersByRole.owner) roleParts.push(`${s.usersByRole.owner} tulajdonos`);
  if (s.usersByRole.manager) roleParts.push(`${s.usersByRole.manager} üzletvezető`);
  if (s.usersByRole.reseller) roleParts.push(`${s.usersByRole.reseller} viszonteladó`);
  const statCards = `
    <div class="ov-grid">
      <div class="card ov-stat">
        <div class="ov-label">Cégek</div>
        <div class="ov-big">${s.totalCompanies}</div>
        <div class="ov-sub">${s.totalSites} telephely</div>
      </div>
      <div class="card ov-stat">
        <div class="ov-label">Aktív előfizetés</div>
        <div class="ov-big">${s.activeSubscriptions}</div>
        <div class="ov-sub${s.pausedSubscriptions > 0 ? ' warn' : ''}">${s.pausedSubscriptions > 0 ? `${s.pausedSubscriptions} szüneteltetve` : 'nincs szüneteltetett'}</div>
      </div>
      <div class="card ov-stat">
        <div class="ov-label">Bevétel e hónapban</div>
        <div class="ov-big">${fmtHuf(s.paymentsThisMonthTotal)}</div>
        <div class="ov-sub">${s.paymentsThisMonthCount} sikeres fizetés</div>
      </div>
      <div class="card ov-stat">
        <div class="ov-label">Felhasználók</div>
        <div class="ov-big">${s.totalUsers}</div>
        <div class="ov-sub">${roleParts.join(' · ') || '—'}</div>
      </div>
    </div>`;

  /* --- 2. sor: telephelyek szinkron-egészsége egyetlen sávban --- */
  const total = s.totalSites;
  const fresh = s.syncedLast24h;
  const week = Math.max(0, s.syncedLast7d - s.syncedLast24h);
  const never = s.neverSynced;
  const stale = Math.max(0, total - s.syncedLast7d - never);
  const pct = (n) => (total ? (n / total) * 100 : 0);
  const seg = (n, cls) => (n > 0 ? `<div class="syncbar-seg syncbar-seg--${cls}" style="width:${pct(n)}%"></div>` : '');
  const leg = (n, cls, label) => `<span><i class="syncbar-seg--${cls}"></i>${n} ${label}</span>`;
  const syncCard = `
    <div class="card">
      <div class="card-title">Telephelyek szinkron-állapota</div>
      ${total === 0 ? '<div class="empty-state">Még nincs szinkronizáló telephely.</div>' : `
      <div class="ov-sub">${fresh} / ${total} telephely szinkronizált az elmúlt 24 órában</div>
      <div class="syncbar">${seg(fresh, 'fresh')}${seg(week, 'week')}${seg(stale, 'stale')}${seg(never, 'never')}</div>
      <div class="syncbar-legend">
        ${leg(fresh, 'fresh', '24 órán belül')}
        ${leg(week, 'week', '1–7 napja')}
        ${leg(stale, 'stale', '7 napnál régebben')}
        ${leg(never, 'never', 'soha')}
      </div>`}
    </div>`;

  /* --- 3. sor: teendők — csak az, ami tényleg beavatkozást kér.
         Minden sor egy gomb, ami a releváns admin nézetre visz. --- */
  const issues = [];
  if (s.neverSynced > 0) issues.push({ count: s.neverSynced, label: 'telephely soha nem szinkronizált', goto: 'companies' });
  if (s.failedSyncCount > 0) issues.push({ count: s.failedSyncCount, label: 'sikertelen szinkron-feltöltés a naplóban', goto: 'activity' });
  if (s.ntakProblems > 0) issues.push({ count: s.ntakProblems, label: 'NTAK-beküldési probléma', goto: 'ntak' });
  if (s.pausedSubscriptions > 0) issues.push({ count: s.pausedSubscriptions, label: 'szüneteltetett előfizetés', goto: 'licenc' });
  if ((s.usersByStatus.pending || 0) > 0) issues.push({ count: s.usersByStatus.pending, label: 'függőben lévő felhasználói meghívó', goto: 'felhasznalok' });
  const issueCard = `
    <div class="card">
      <div class="card-title">Figyelmet igényel</div>
      <div class="issue-list">
        ${issues.length === 0
          ? '<div class="issue-row issue-row--ok">✓ Minden rendben — nincs beavatkozást igénylő tétel.</div>'
          : issues.map((i) => `
            <button class="issue-row" data-goto="${i.goto}">
              <span class="issue-count">${i.count}</span>
              <span style="flex:1">${i.label}</span>
              <span class="issue-open">Megnyitás ›</span>
            </button>`).join('')}
      </div>
    </div>`;

  root.innerHTML = statCards + syncCard + issueCard;
  root.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.querySelector(`.admin-nav-item[data-admin-view="${btn.dataset.goto}"]`);
      if (target) target.click();
    });
  });
}

let adminRegCache = [];
let adminRegSort = { key: 'nev', dir: 'asc' };
const adminRegPaginator = new Paginator();

async function loadAdminRegistrations() {
  try {
    const data = await api('/api/admin/registrations');
    adminRegCache = data.companies;
    renderAdminRegTable();
  } catch (e) {
    document.querySelector('#admin-reg-table tbody').innerHTML = `<tr><td colspan="8" class="muted">Nem sikerült betölteni: ${escapeHtml(e.message)}</td></tr>`;
  }
}

// A cégenkénti-telephelyenkénti-eszközönkénti fát EGY LAPOS, eszköz-szintű
// listává alakítja — ez teszi lehetővé az érdemi rendezést/szűrést
// (reg. dátum, lejárat, állapot szerint). Az eszköz nélküli cégek egyetlen,
// "üres" sorként jelennek meg, hogy ők is láthatók maradjanak.
function flattenRegRows() {
  const rows = [];
  adminRegCache.forEach((c) => {
    const anyDevices = c.sites.some((s) => s.devices.length);
    if (!anyDevices) {
      rows.push({
        cegNev: c.nev || '(névtelen)', adoszam: c.adoszam, telephely: '—',
        progtip: '—', verzio: '—', regdat: null, ervdat: null,
        allapot: 'nincs-eszkoz', allapotLabel: 'Nincs eszköz',
      });
      return;
    }
    c.sites.forEach((s) => {
      s.devices.forEach((d) => {
        const napokHatra = d.ervdat ? Math.ceil((new Date(d.ervdat) - new Date()) / 86400000) : null;
        let allapot = 'aktiv', allapotLabel = 'Aktív';
        if (napokHatra !== null && napokHatra < 0) { allapot = 'lejart'; allapotLabel = 'Lejárt'; }
        else if (napokHatra !== null && napokHatra <= 30) { allapot = 'hamarosan'; allapotLabel = `Hamarosan lejár (${napokHatra} nap)`; }
        rows.push({
          cegNev: c.nev || '(névtelen)', adoszam: c.adoszam, telephely: s.nev || '—',
          progtip: d.progtip || '—', verzio: d.verzio || '—', regdat: d.regdat, ervdat: d.ervdat,
          allapot, allapotLabel,
        });
      });
    });
  });
  return rows;
}

function renderAdminRegTable() {
  const q = (document.getElementById('reg-search-input').value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('reg-status-filter').value;
  let rows = flattenRegRows().filter((r) =>
    (!q || r.cegNev.toLowerCase().includes(q) || (r.adoszam || '').toLowerCase().includes(q))
    && (!statusFilter || r.allapot === statusFilter)
  );

  const { key, dir } = adminRegSort;
  rows.sort((a, b) => {
    let av = a[key] ?? '', bv = b[key] ?? '';
    if (key === 'regdat' || key === 'ervdat') { av = av || ''; bv = bv || ''; }
    const cmp = String(av).localeCompare(String(bv), 'hu', { numeric: true });
    return dir === 'asc' ? cmp : -cmp;
  });

  document.querySelectorAll('#admin-reg-table .reg-sortable').forEach((th) => {
    th.querySelector('.sort-arrow')?.remove();
    if (th.dataset.sort === key) {
      th.insertAdjacentHTML('beforeend', `<span class="sort-arrow">${dir === 'asc' ? '▲' : '▼'}</span>`);
    }
  });

  const tbody = document.querySelector('#admin-reg-table tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">Nincs találat.</td></tr>';
    document.getElementById('admin-reg-pagination').innerHTML = '';
    return;
  }
  const pageData = adminRegPaginator.slice(rows);
  const statusBadgeClass = { aktiv: 'ok', lejart: 'expired', hamarosan: 'warn', 'nincs-eszkoz': 'none' };
  tbody.innerHTML = pageData.map((r) => `
    <tr data-adoszam="${escapeHtml(r.adoszam)}">
      <td>${escapeHtml(r.cegNev)}</td>
      <td class="ntak-uuid">${escapeHtml(r.adoszam)}</td>
      <td>${escapeHtml(r.telephely)}</td>
      <td>${escapeHtml(r.progtip)}</td>
      <td>${r.regdat ? escapeHtml(r.regdat.slice(0, 10)) : '—'}</td>
      <td>${r.ervdat ? escapeHtml(r.ervdat.slice(0, 10)) : '—'}</td>
      <td><span class="licenc-badge licenc-badge--${statusBadgeClass[r.allapot]}">${escapeHtml(r.allapotLabel)}</span></td>
      <td><button class="btn-tiny btn-reg-detail" data-adoszam="${escapeHtml(r.adoszam)}">Részletek</button></td>
    </tr>`).join('');
  tbody.querySelectorAll('.btn-reg-detail').forEach((btn) => {
    btn.addEventListener('click', () => openRegDetailModal(btn.dataset.adoszam));
  });
  adminRegPaginator.renderControls(document.getElementById('admin-reg-pagination'), renderAdminRegTable);
}
listen('reg-search-input', 'input', () => { adminRegPaginator.page = 1; renderAdminRegTable(); });
listen('reg-status-filter', 'change', () => { adminRegPaginator.page = 1; renderAdminRegTable(); });
document.querySelectorAll('#admin-reg-table .reg-sortable').forEach((th) => {
  th.addEventListener('click', () => {
    if (adminRegSort.key === th.dataset.sort) {
      adminRegSort.dir = adminRegSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      adminRegSort = { key: th.dataset.sort, dir: 'asc' };
    }
    renderAdminRegTable();
  });
});

function openRegDetailModal(adoszam) {
  const c = adminRegCache.find((x) => x.adoszam === adoszam);
  if (!c) return;
  document.getElementById('reg-detail-title').textContent = c.nev || '(névtelen cég)';
  document.getElementById('reg-detail-subtitle').textContent = c.adoszam;
  const badgeBox = document.getElementById('reg-detail-live-badge');
  badgeBox.innerHTML = c.hasLiveSync
    ? `<span class="licenc-badge licenc-badge--ok">Van élő L-NYUGTA szinkron (${c.liveSites.length} telephely)</span>`
    : '<span class="licenc-badge licenc-badge--none">Nincs élő L-NYUGTA szinkron ehhez az adószámhoz</span>';

  document.getElementById('reg-site-new-btn').onclick = async () => {
    const varos = prompt('Telephely városa:');
    if (varos === null) return;
    const cim = prompt('Telephely címe (utca, házszám):') || '';
    try {
      let companyId = c.id;
      if (!companyId) {
        const res = await api('/api/admin/registrations/company/add', { method: 'POST', body: JSON.stringify({ adoszam: c.adoszam, nev: c.nev }) });
        companyId = res.id;
      }
      await api('/api/admin/registrations/site/add', { method: 'POST', body: JSON.stringify({ companyId, varos, cim }) });
      await loadAdminRegistrations();
      openRegDetailModal(adoszam);
    } catch (e) { alert('Nem sikerült: ' + e.message); }
  };

  renderRegSites(c);
  document.getElementById('reg-detail-modal-backdrop').hidden = false;
}
listen('reg-detail-modal-close', 'click', () => {
  document.getElementById('reg-detail-modal-backdrop').hidden = true;
});
listen('reg-detail-modal-backdrop', 'click', (e) => {
  if (e.target.id === 'reg-detail-modal-backdrop') e.target.hidden = true;
});

function renderRegSites(c) {
  const box = document.getElementById('reg-detail-sites');
  if (!c.sites.length) { box.innerHTML = '<p class="muted">Még nincs telephely felvéve ehhez a céghez.</p>'; return; }
  box.innerHTML = c.sites.map((s) => `
    <div class="card" style="background:var(--paper-dim);margin-bottom:12px;padding:14px 16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div>
          <div style="font-weight:600;font-size:13.5px;">${escapeHtml(s.nev || 'Telephely')}</div>
          <div class="card-subtitle" style="margin:0;">${escapeHtml([s.varos, s.cim].filter(Boolean).join(', ') || 'nincs cím megadva')}</div>
        </div>
        <button class="btn-tiny reg-device-new-btn" data-site-id="${s.id}">+ Új eszköz</button>
      </div>
      ${s.devices.length ? s.devices.map((d) => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--line);font-size:12.5px;">
          <div>
            <b>${escapeHtml(d.progtip || '(ismeretlen típus)')}</b>${d.verzio ? ` · v${escapeHtml(d.verzio)}` : ''}
            <div class="card-subtitle" style="margin:2px 0 0;">lejárat: ${escapeHtml((d.ervdat || '—').slice(0, 10))} · ${escapeHtml(d.kapcsnev || 'nincs kapcsolattartó')}</div>
          </div>
          <button class="btn-tiny reg-device-edit-btn" data-device-id="${d.id}">Szerkesztés</button>
        </div>
      `).join('') : '<p class="muted" style="margin:8px 0 0;">Nincs eszköz ezen a telephelyen.</p>'}
    </div>
  `).join('');

  box.querySelectorAll('.reg-device-new-btn').forEach((btn) => {
    btn.addEventListener('click', () => openRegDeviceModal(null, Number(btn.dataset.siteId)));
  });
  box.querySelectorAll('.reg-device-edit-btn').forEach((btn) => {
    const deviceId = Number(btn.dataset.deviceId);
    let device = null;
    for (const s of c.sites) { const found = s.devices.find((d) => d.id === deviceId); if (found) { device = found; break; } }
    btn.addEventListener('click', () => openRegDeviceModal(device, null));
  });
}

function toDatetimeLocal(v) {
  if (!v) return '';
  return v.replace(' ', 'T').slice(0, 16);
}
function fromDatetimeLocal(v) {
  if (!v) return null;
  return v.replace('T', ' ') + ':00';
}

function openRegDeviceModal(device, siteIdForNew) {
  document.getElementById('reg-device-modal-title').textContent = device ? 'Eszköz szerkesztése' : 'Új eszköz felvétele';
  document.getElementById('reg-device-id').value = device ? device.id : '';
  document.getElementById('reg-device-site-id').value = device ? '' : siteIdForNew;
  document.getElementById('reg-device-uuid').value = device ? (device.uuid || '') : '';
  document.getElementById('reg-device-progtip').value = device ? (device.progtip || '') : '';
  document.getElementById('reg-device-verzio').value = device ? (device.verzio || '') : '';
  document.getElementById('reg-device-regdat').value = toDatetimeLocal(device ? device.regdat : '');
  document.getElementById('reg-device-ervdat').value = toDatetimeLocal(device ? device.ervdat : '');
  document.getElementById('reg-device-kapcsnev').value = device ? (device.kapcsnev || '') : '';
  document.getElementById('reg-device-email').value = device ? (device.email || '') : '';
  document.getElementById('reg-device-telefon').value = device ? (device.telefon || '') : '';
  document.getElementById('reg-device-regmodel').value = device ? (device.regmodel || '') : '';
  document.getElementById('reg-device-regmanufacturer').value = device ? (device.regmanufacturer || '') : '';
  document.getElementById('reg-device-msg').textContent = '';
  document.getElementById('reg-device-delete-btn').hidden = !device;
  document.getElementById('reg-device-modal-backdrop').hidden = false;
}
listen('reg-device-modal-close', 'click', () => {
  document.getElementById('reg-device-modal-backdrop').hidden = true;
});
listen('reg-device-modal-backdrop', 'click', (e) => {
  if (e.target.id === 'reg-device-modal-backdrop') e.target.hidden = true;
});
listen('reg-device-form', 'submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('reg-device-msg');
  msg.textContent = '';
  const id = document.getElementById('reg-device-id').value;
  const body = {
    uuid: document.getElementById('reg-device-uuid').value.trim(),
    progtip: document.getElementById('reg-device-progtip').value.trim(),
    verzio: document.getElementById('reg-device-verzio').value.trim(),
    regdat: fromDatetimeLocal(document.getElementById('reg-device-regdat').value),
    ervdat: fromDatetimeLocal(document.getElementById('reg-device-ervdat').value),
    kapcsnev: document.getElementById('reg-device-kapcsnev').value.trim(),
    email: document.getElementById('reg-device-email').value.trim(),
    telefon: document.getElementById('reg-device-telefon').value.trim(),
    regmodel: document.getElementById('reg-device-regmodel').value.trim(),
    regmanufacturer: document.getElementById('reg-device-regmanufacturer').value.trim(),
  };
  try {
    if (id) {
      await api('/api/admin/registrations/device/save', { method: 'POST', body: JSON.stringify({ id: Number(id), ...body }) });
    } else {
      body.siteId = Number(document.getElementById('reg-device-site-id').value);
      await api('/api/admin/registrations/device/add', { method: 'POST', body: JSON.stringify(body) });
    }
    document.getElementById('reg-device-modal-backdrop').hidden = true;
    const adoszam = document.getElementById('reg-detail-subtitle').textContent;
    await loadAdminRegistrations();
    openRegDetailModal(adoszam);
  } catch (e2) {
    msg.textContent = e2.message; msg.className = 'profile-form-msg error';
  }
});
listen('reg-device-delete-btn', 'click', async () => {
  if (!confirm('Biztosan törlöd ezt az eszközt a regisztrációk közül?')) return;
  const id = document.getElementById('reg-device-id').value;
  try {
    await api('/api/admin/registrations/device/delete', { method: 'POST', body: JSON.stringify({ id: Number(id) }) });
    document.getElementById('reg-device-modal-backdrop').hidden = true;
    const adoszam = document.getElementById('reg-detail-subtitle').textContent;
    await loadAdminRegistrations();
    openRegDetailModal(adoszam);
  } catch (e) { alert('Nem sikerült: ' + e.message); }
});
listen('reg-company-new-btn', 'click', async () => {
  const adoszam = prompt('Az új cég adószáma:');
  if (!adoszam) return;
  const nev = prompt('A cég neve:') || '';
  try {
    await api('/api/admin/registrations/company/add', { method: 'POST', body: JSON.stringify({ adoszam, nev }) });
    await loadAdminRegistrations();
  } catch (e) { alert('Nem sikerült: ' + e.message); }
});

async function loadAdminOverview() {
  const data = await api('/api/admin/overview');

  renderAdminOverview(data.stats);

  document.getElementById('admin-email-warning').hidden = !!data.emailReady;

  document.getElementById('admin-company-count').textContent = data.companies.length;
  adminCompaniesCache = data.companies;
  adminResellersCache = data.resellers;
  renderAdminCompaniesTable();
  adminNtakCache = data.ntak;
  renderAdminNtakTable();
}

function renderAdminCompaniesTable() {
  const compTbody = document.querySelector('#admin-companies-table tbody');
  const pageData = adminCompaniesPaginator.slice(adminCompaniesCache);
  compTbody.innerHTML = '';
  pageData.forEach((c) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(c.nev)}</td>
      <td>${escapeHtml(c.telephelyNev || c.telephelyKod || '—')}</td>
      <td class="ntak-uuid">${escapeHtml(c.adoszam)}</td>
      <td>${c.lastSync ? fmtDateTime(c.lastSync) : '—'}</td>
      <td><button class="btn-tiny btn-company-detail" data-key="${escapeHtml(c.key)}">Részletek</button></td>`;
    compTbody.appendChild(tr);
  });
  compTbody.querySelectorAll('.btn-company-detail').forEach((btn) => {
    btn.addEventListener('click', () => openCompanyDetailModal(btn.dataset.key));
  });
  adminCompaniesPaginator.renderControls(document.getElementById('admin-companies-pagination'), renderAdminCompaniesTable);
}

function renderAdminNtakTable() {
  const ntakTbody = document.querySelector('#admin-ntak-table tbody');
  if (!adminNtakCache.length) {
    ntakTbody.innerHTML = '<tr><td colspan="6" class="empty-state">Egyik cégnek sincs NTAK adata.</td></tr>';
    document.getElementById('admin-ntak-pagination').innerHTML = '';
    return;
  }
  const pageData = adminNtakPaginator.slice(adminNtakCache);
  ntakTbody.innerHTML = '';
  pageData.forEach((n) => {
    const tr = document.createElement('tr');
    const problem = n.lastProblem
      ? `${NTAK_ADMIN_STATUS_LABELS[n.lastProblem.ellenorzott] || n.lastProblem.ellenorzott} — ${fmtDateTime(n.lastProblem.kulddate)}`
      : '—';
    tr.innerHTML = `
      <td>${escapeHtml(n.nev)}</td>
      <td class="num">${n.ok}</td>
      <td class="num">${n.warn ? `<span class="ntak-badge warn">${n.warn}</span>` : '0'}</td>
      <td class="num">${n.error ? `<span class="ntak-badge error">${n.error}</span>` : '0'}</td>
      <td class="num">${n.pending}</td>
      <td>${escapeHtml(problem)}</td>`;
    ntakTbody.appendChild(tr);
  });
  adminNtakPaginator.renderControls(document.getElementById('admin-ntak-pagination'), renderAdminNtakTable);
}

async function adminOpenCompany(key) {
  try {
    const data2 = await api('/api/admin/impersonate', { method: 'POST', body: JSON.stringify({ companyKey: key }) });
    document.getElementById('company-name').textContent = data2.company.nev;
    updateTelephelyBadge(data2.company.telephelyNev);
    loggedIn = true;
    state.viaAdmin = true;
    stockProductsLoaded = false;
    showApp();
    boot();
  } catch (e) {
    alert('Nem sikerült megnyitni: ' + e.message);
  }
}

function openCompanyDetailModal(key) {
  const c = adminCompaniesCache.find((x) => x.key === key);
  if (!c) return;
  document.getElementById('company-detail-title').textContent = c.nev;
  document.getElementById('company-detail-subtitle').textContent = `${c.telephelyNev || c.telephelyKod || ''} · ${c.adoszam}`;
  document.querySelector('#company-detail-kv tbody').innerHTML = `
    <tr><td>Város</td><td>${escapeHtml(c.varos || '—')}</td></tr>
    <tr><td>Utolsó szinkron</td><td>${c.lastSync ? fmtDateTime(c.lastSync) : '—'}</td></tr>
    <tr><td>Forrás</td><td>${escapeHtml(c.source || '—')}</td></tr>
    <tr><td>Méret</td><td>${c.bytes ? Math.round(c.bytes / 1024) + ' KB' : '—'}</td></tr>`;
  const select = document.getElementById('company-detail-reseller');
  select.innerHTML = `<option value="">— nincs —</option>` +
    adminResellersCache.map((r) => `<option value="${r.id}" ${r.id === c.resellerId ? 'selected' : ''}>${escapeHtml(r.nev)}</option>`).join('');
  select.onchange = async () => {
    try {
      await api('/api/admin/companies/assign-reseller', { method: 'POST', body: JSON.stringify({ cegKulcs: c.cegKulcs, resellerId: select.value || null }) });
    } catch (e) { alert('Nem sikerült menteni: ' + e.message); }
  };
  document.getElementById('company-detail-open-btn').onclick = () => {
    document.getElementById('company-detail-modal-backdrop').hidden = true;
    adminOpenCompany(key);
  };
  document.getElementById('company-detail-download-link').href = `/api/admin/companies/download-db?key=${encodeURIComponent(key)}`;
  document.getElementById('company-detail-license-btn').onclick = async (e) => {
    try {
      await navigator.clipboard.writeText(c.adoszam);
      const btn = e.currentTarget;
      btn.textContent = '✓ Adószám másolva';
      setTimeout(() => { btn.textContent = '🔗 Licenc (lszamla)'; }, 2000);
    } catch (_) { /* ha a vágólap-hozzáférés nem engedélyezett, csendben folytatjuk */ }
    window.open('https://leichter.hu/lszamla/index.php?p=reglistak', '_blank');
  };

  // Veszélyes-zóna: cég végleges törlése — csak akkor engedélyezett a
  // gomb, ha a pontos cégnév be van gépelve, és egy utolsó, szöveges
  // megerősítő ablak is megjelenik kattintáskor.
  const confirmInput = document.getElementById('company-detail-delete-confirm');
  const deleteBtn = document.getElementById('company-detail-delete-btn');
  confirmInput.value = '';
  confirmInput.placeholder = c.nev;
  deleteBtn.disabled = true;
  confirmInput.oninput = () => { deleteBtn.disabled = confirmInput.value.trim() !== c.nev; };
  deleteBtn.onclick = async () => {
    if (!confirm(`Ez VÉGLEGESEN törli "${c.nev}" cég MINDEN adatát (adatbázis, felhasználók, regisztráció, licenc, készlet, stb.) — ez nem vonható vissza. Biztosan folytatod?`)) return;
    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Törlés folyamatban…';
    try {
      await api('/api/admin/company/delete', { method: 'POST', body: JSON.stringify({ cegKulcs: c.cegKulcs, megerositoNev: c.nev }) });
      document.getElementById('company-detail-modal-backdrop').hidden = true;
      alert(`"${c.nev}" végleg törölve. A biztonsági mentés a szerveren, a ~/lnyugta_backups/ mappában található.`);
      loadAdminOverview();
    } catch (err) {
      alert('Nem sikerült törölni: ' + err.message);
      deleteBtn.disabled = false;
      deleteBtn.textContent = 'Cég végleges törlése';
    }
  };

  document.getElementById('company-detail-modal-backdrop').hidden = false;
}
listen('company-detail-modal-close', 'click', () => {
  document.getElementById('company-detail-modal-backdrop').hidden = true;
});
listen('company-detail-modal-backdrop', 'click', (e) => {
  if (e.target.id === 'company-detail-modal-backdrop') e.target.hidden = true;
});

/* ============================================================
   Tevékenység-napló (admin)
   ============================================================ */
const ACTIVITY_TYPE_LABELS = {
  client_error: 'Frontend hiba',
  company_login: 'Céges belépés',
  company_logout: 'Céges kilépés',
  admin_login: 'Admin belépés',
  admin_logout: 'Admin kilépés',
  admin_impersonate: 'Admin: cég megnyitása',
  admin_regen_code: 'Kód újragenerálva',
  admin_send_code: 'Kód kiküldve emailben',
  sync_upload: 'Szinkron feltöltés',
  stock_receipt_add: 'Bevételezés rögzítve',
  stock_receipt_delete: 'Bevételezés törölve',
  stock_threshold_set: 'Riasztási küszöb beállítva',
  stock_threshold_delete: 'Riasztási küszöb törölve',
  stock_reset: 'Készlet nullázva',
  product_change_add: 'Cikk-módosítás rögzítve',
  product_group_add: 'Termékcsoport létrehozva',
  product_bulk_price: 'Tömeges árváltoztatás',
  product_import: 'CSV import',
  telephely_select: 'Telephely kiválasztva',
  telephely_create: 'Új telephely létrehozva',
  telephely_update: 'Telephely adatai módosítva',
  profile_email_update: 'Profil: kapcsolattartási email módosítva',
  user_invite_sent: 'Meghívó kiküldve',
  user_invite_accepted: 'Meghívó elfogadva',
  user_update: 'Felhasználó módosítva',
  user_delete: 'Felhasználó törölve',
  company_reseller_assign: 'Cég viszonteladóhoz rendelve',
  admin_db_download: 'Admin: adatbázis letöltve',
};
const activityFilter = { company: '', type: '' };
const activityLogPaginator = new Paginator();

async function loadAdminActivity() {
  const data = await api('/api/admin/activity');

  // --- cégenkénti összesítő mátrix ---
  const sumTbody = document.querySelector('#activity-summary-table tbody');
  sumTbody.innerHTML = '';
  if (!data.summary.length) {
    sumTbody.innerHTML = '<tr><td colspan="3" class="empty-state">Még nincs naplózott esemény.</td></tr>';
  } else {
    data.summary.forEach((row) => {
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      const typeBreakdown = Object.entries(row.counts)
        .map(([t, c]) => `${ACTIVITY_TYPE_LABELS[t] || t}: ${c}`)
        .join(' · ');
      tr.innerHTML = `
        <td>${escapeHtml(row.nev)}</td>
        <td class="num">${row.total}</td>
        <td class="activity-summary-detail" title="${escapeHtml(typeBreakdown)}">${fmtDateTime(row.lastTs)} — <span class="muted">${escapeHtml(typeBreakdown)}</span></td>`;
      tr.addEventListener('click', () => {
        activityFilter.company = row.key;
        activityLogPaginator.page = 1;
        document.getElementById('activity-company-select').value = row.key;
        renderActivityLog(data);
      });
      sumTbody.appendChild(tr);
    });
  }

  // --- szűrők feltöltése ---
  const companySelect = document.getElementById('activity-company-select');
  const currentVal = companySelect.value;
  companySelect.innerHTML = '<option value="">Összes cég</option>' +
    data.companies.map((c) => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.nev)}</option>`).join('') +
    '<option value="__admin__">Admin (nem cég-specifikus)</option>';
  companySelect.value = currentVal;

  const typeChips = document.getElementById('activity-type-chips');
  typeChips.innerHTML = `<button class="chip activity-type-chip ${!activityFilter.type ? 'is-active' : ''}" data-type="">Összes típus</button>` +
    data.types.map((t) => `<button class="chip activity-type-chip ${activityFilter.type === t ? 'is-active' : ''}" data-type="${t}">${ACTIVITY_TYPE_LABELS[t] || t}</button>`).join('');
  typeChips.querySelectorAll('.activity-type-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      activityFilter.type = btn.dataset.type;
      activityLogPaginator.page = 1;
      renderActivityLog(data);
    });
  });

  renderActivityLog(data);
}

function renderActivityLog(data) {
  document.querySelectorAll('.activity-type-chip').forEach((c) => c.classList.toggle('is-active', c.dataset.type === activityFilter.type));

  let entries = data.entries;
  if (activityFilter.company) entries = entries.filter((e) => (e.companyKey || '__admin__') === activityFilter.company);
  if (activityFilter.type) entries = entries.filter((e) => e.type === activityFilter.type);

  const tbody = document.querySelector('#activity-log-table tbody');
  tbody.innerHTML = '';
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Nincs a szűrésnek megfelelő esemény.</td></tr>';
    document.getElementById('activity-log-pagination').innerHTML = '';
    return;
  }
  const pageData = activityLogPaginator.slice(entries);
  pageData.forEach((e) => {
    const tr = document.createElement('tr');
    const statusBadge = e.ok ? '<span class="ntak-badge ok">Sikeres</span>' : '<span class="ntak-badge error">Hiba</span>';
    tr.innerHTML = `
      <td>${fmtDateTime(e.ts)}</td>
      <td>${escapeHtml(e.nev || (e.companyKey ? e.companyKey : 'Admin'))}</td>
      <td><span class="activity-type-badge">${escapeHtml(ACTIVITY_TYPE_LABELS[e.type] || e.type)}</span></td>
      <td>${statusBadge}</td>
      <td>${escapeHtml(e.detail || '—')}</td>`;
    tbody.appendChild(tr);
  });
  activityLogPaginator.renderControls(document.getElementById('activity-log-pagination'), () => renderActivityLog(data));
}

listen('activity-company-select', 'change', (e) => {
  activityFilter.company = e.target.value;
  activityLogPaginator.page = 1;
  loadAdminActivity();
});

/* induláskor: mindig a bejelentkező képernyő jelenjen meg, még akkor is, ha
   a böngészőben van érvényes session-cookie egy korábbi belépésből. A link
   megnyitásakor tehát sosem ugrunk automatikusan a dashboardra — csak a
   ténylegesen beküldött belépési űrlap után.
   (A loggedIn deklaráció a fájl LEGELEJÉN van a többi globális state-tel —
   ha itt lenne, egy korábbi top-level hiba TDZ-hibát okozna belépéskor.) */
checkInviteLink().then((wasInvite) => {
  if (wasInvite) return;
  checkResetPasswordLink().then((wasReset) => { if (!wasReset) showLandingScreen(); });
});

/* ============================================================
   Mobil hamburger-menü
   ============================================================ */
function closeMobileSidebar() {
  document.getElementById('sidebar').classList.remove('is-open');
  document.getElementById('sidebar-overlay').hidden = true;
  document.getElementById('hamburger-btn').classList.remove('is-hidden');
}
function openMobileSidebar() {
  document.getElementById('sidebar').classList.add('is-open');
  document.getElementById('sidebar-overlay').hidden = false;
  // a hamburgert elrejtjük nyitott állapotban, hogy ne fedje a sidebar saját logóját
  document.getElementById('hamburger-btn').classList.add('is-hidden');
}
listen('hamburger-btn', 'click', () => {
  const sidebar = document.getElementById('sidebar');
  if (sidebar.classList.contains('is-open')) closeMobileSidebar(); else openMobileSidebar();
});
listen('sidebar-overlay', 'click', closeMobileSidebar);
listen('sidebar-close-btn', 'click', closeMobileSidebar);

function closeAdminMobileSidebar() {
  document.getElementById('admin-sidebar').classList.remove('is-open');
  document.getElementById('admin-sidebar-overlay').hidden = true;
  document.getElementById('admin-hamburger-btn').classList.remove('is-hidden');
}
function openAdminMobileSidebar() {
  document.getElementById('admin-sidebar').classList.add('is-open');
  document.getElementById('admin-sidebar-overlay').hidden = false;
  document.getElementById('admin-hamburger-btn').classList.add('is-hidden');
}
listen('admin-hamburger-btn', 'click', () => {
  const sidebar = document.getElementById('admin-sidebar');
  if (sidebar.classList.contains('is-open')) closeAdminMobileSidebar(); else openAdminMobileSidebar();
});
listen('admin-sidebar-overlay', 'click', closeAdminMobileSidebar);
listen('admin-sidebar-close-btn', 'click', closeAdminMobileSidebar);

/* ============================================================
   Navigáció / nézetváltás
   ============================================================ */
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    const view = btn.dataset.view;
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
    document.getElementById('main-topbar').hidden = (view === 'stock' || view === 'stock-receipt' || view === 'masterdata' || view === 'compare');
    if (view === 'revenue') loadRevenueView();
    if (view === 'products') loadProductsView(true);
    if (view === 'masterdata') loadMasterdataView();
    if (view === 'receipts') loadReceiptsView(true);
    if (view === 'ntak') loadNtakView();
    if (view === 'stock') loadStockView();
    if (view === 'stock-receipt') { loadStockProductList(); loadStockReceiptLog(); }
    if (view === 'sync') loadSyncView();
    if (view === 'profil') loadProfilView();
    closeMobileSidebar(); // mobilon navigáció után zárja a kihúzható menüt
    document.querySelectorAll('.mobile-tab-btn').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.forwardView === view);
    });
  });
});
listen('stock-goto-receipt-btn', 'click', () => {
  document.querySelector('.nav-item[data-view="stock-receipt"]').click();
});
listen('stock-reset-btn', 'click', async () => {
  if (!confirm('Biztosan nullázod MINDEN cikk készletét? Ez minden termékhez egy korrekciós bevételezési tételt ad hozzá, ami nullára hozza az egyenleget — a korábbi bevételezési/eladási előzmény nem törlődik, de ez a művelet a Bevételezési naplóban is látszani fog. Nem vonható vissza automatikusan.')) return;
  const btn = document.getElementById('stock-reset-btn');
  btn.disabled = true; btn.textContent = 'Nullázás…';
  try {
    const res = await api('/api/stock/reset', { method: 'POST' });
    alert(`Kész — ${res.count} cikk készlete nullázva.`);
    loadStockView();
  } catch (e) {
    alert('Nem sikerült: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Készlet nullázása';
  }
});

/* ============================================================
   Mobil alsó navigáció — a kattintást a meglévő nav-item gombokra
   továbbítja, hogy minden meglévő logika (nézetváltás, adatbetöltés)
   változtatás nélkül újrahasznosítható legyen.
   ============================================================ */
document.querySelectorAll('.mobile-tab-btn[data-forward-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelector(`.nav-item[data-view="${btn.dataset.forwardView}"]`).click();
  });
});
listen('mobile-tab-more', 'click', () => {
  const sidebar = document.getElementById('sidebar');
  if (sidebar.classList.contains('is-open')) closeMobileSidebar(); else openMobileSidebar();
});

/* ============================================================
   Mobil, görgethető dátum-pirulák — a meglévő range-select értékét
   állítják be és 'change' eseményt indítanak, a teljes meglévő
   dátumtartomány-logika újrahasznosításával.
   ============================================================ */
document.querySelectorAll('.range-pill[data-range-value]').forEach((pill) => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.range-pill').forEach((p) => p.classList.remove('is-active'));
    pill.classList.add('is-active');
    document.getElementById('range-select').classList.remove('is-mobile-visible');
    const select = document.getElementById('range-select');
    select.value = pill.dataset.rangeValue;
    select.dispatchEvent(new Event('change'));
  });
});
listen('range-pill-more', 'click', () => {
  document.querySelectorAll('.range-pill').forEach((p) => p.classList.remove('is-active'));
  document.getElementById('range-select').classList.toggle('is-mobile-visible');
});


/* ============================================================
   Dátumtartomány vezérlő
   ============================================================ */
function updateRangeLabel() {
  const el = document.getElementById('range-label');
  const { from, to } = state.range;
  el.textContent = from === to ? fmtDate(from) : `${fmtDate(from)} – ${fmtDate(to)}`;
}
// Egységes belépési pont minden tartomány-változtatáshoz: beállítja a state-et,
// frissíti a címkét, és ha a tartomány már nem egyetlen nap, óránkénti nézetből
// visszavált napi bontásra (az óránkénti csak egy napra értelmezhető).
function applyRange(range) {
  state.range = range;
  if (range.from !== range.to) setGroup('day');
  updateRangeLabel();
  refreshAll();
}
listen('range-select', 'change', (e) => {
  const key = e.target.value;
  document.getElementById('range-custom-inputs').hidden = key !== 'custom';
  document.getElementById('range-single-input').hidden = key !== 'single-day';
  if (key === 'custom') {
    document.getElementById('from-input').value = state.range.from;
    document.getElementById('to-input').value = state.range.to;
    return; // "Alkalmaz"-ra vár
  }
  if (key === 'single-day') {
    document.getElementById('single-day-input').value = state.range.to;
    return; // "Alkalmaz"-ra vár
  }
  applyRange({ ...resolvePreset(key), preset: key });
});
listen('apply-range-btn', 'click', () => {
  const from = document.getElementById('from-input').value;
  const to = document.getElementById('to-input').value;
  if (from && to) applyRange({ from, to, preset: 'custom' });
});
listen('apply-single-day-btn', 'click', () => {
  const day = document.getElementById('single-day-input').value;
  if (day) applyRange({ from: day, to: day, preset: 'single-day' });
});
listen('refresh-btn', 'click', () => refreshAll(true));

/* ============================================================
   Boot / élő frissítés
   ============================================================ */
function boot() {
  document.getElementById('from-input').value = state.range.from;
  document.getElementById('to-input').value = state.range.to;
  document.getElementById('stock-datum-input').value = todayIso();
  updateRangeLabel();
  refreshAll();
  refreshSyncPill();
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => { refreshAll(); refreshSyncPill(); }, 30000); // "élő" frissítés 30mp-enként
}

async function refreshAll(spin) {
  const icon = document.querySelector('.refresh-icon');
  if (spin) icon.classList.add('spin');
  try {
    await loadOverview();
    const activeView = document.querySelector('.nav-item.is-active').dataset.view;
    if (activeView === 'revenue') await loadRevenueView();
    if (activeView === 'products') await loadProductsView(false);
    if (activeView === 'receipts') await loadReceiptsView(false);
    if (activeView === 'ntak') await loadNtakView();
    if (activeView === 'stock') await loadStockView();
    if (activeView === 'stock-receipt') await loadStockReceiptLog();
    if (activeView === 'masterdata') await loadMasterdataView();
  } finally {
    if (spin) setTimeout(() => icon.classList.remove('spin'), 400);
  }
}

async function refreshSyncPill() {
  try {
    const meta = await api('/api/sync/status');
    const dot = document.getElementById('sync-dot');
    const text = document.getElementById('sync-pill-text');
    if (!meta.lastSync) { dot.className = 'dot stale'; text.textContent = 'nincs szinkron adat'; return; }
    const ageMin = (Date.now() - new Date(meta.lastSync).getTime()) / 60000;
    dot.className = 'dot ' + (ageMin < 15 ? 'ok' : ageMin < 120 ? '' : 'stale');
    text.textContent = 'szinkron: ' + fmtDateTime(meta.lastSync);
  } catch (_) {}
}

/* ============================================================
   Áttekintés
   ============================================================ */
async function loadOverview() {
  const { from, to } = state.range;
  const summary = await api(`/api/summary?from=${from}&to=${to}`);
  document.getElementById('kpi-revenue').textContent = fmtHuf(summary.revenue);
  document.getElementById('kpi-count').textContent = summary.receiptCount.toLocaleString('hu-HU');
  document.getElementById('kpi-avg').textContent = fmtHuf(summary.avgBasket);
  renderTrend('kpi-revenue-trend', summary.revenue, summary.prev.revenue);
  renderTrend('kpi-count-trend', summary.receiptCount, summary.prev.receiptCount);

  const series = await api(`/api/revenue-series?from=${from}&to=${to}&group=${state.group}`);
  renderLineChart(document.getElementById('overview-chart'), series.points);
  const chartTitles = { hour: 'Óránkénti forgalom', day: 'Napi forgalom', week: 'Heti forgalom', month: 'Havi forgalom' };
  document.getElementById('overview-chart-title').textContent = chartTitles[state.group] || 'Forgalom alakulása';

  renderFizmodList(document.getElementById('fizmod-list'), summary.byFizmod, summary.revenue);

  const products = await api(`/api/products?from=${from}&to=${to}&limit=6`);
  renderTopProducts(document.getElementById('overview-top-products'), products.items);
}

function renderTrend(elId, cur, prev) {
  const el = document.getElementById(elId);
  if (!prev) { el.textContent = ''; return; }
  const pct = Math.round(((cur - prev) / prev) * 100);
  el.textContent = (pct >= 0 ? '▲ ' : '▼ ') + Math.abs(pct) + '% az előző időszakhoz képest';
  el.className = 'kpi-trend ' + (pct >= 0 ? 'up' : 'down');
}

function renderFizmodList(container, rows, total) {
  container.innerHTML = '';
  if (!rows.length) { container.innerHTML = '<div class="empty-state">Nincs adat.</div>'; return; }
  const names = { kp: 'Készpénz', 'bankkártya': 'Bankkártya', 'egyéb': 'Egyéb' };
  rows.forEach((r) => {
    const pct = total ? Math.round((r.revenue / total) * 100) : 0;
    const row = document.createElement('div');
    row.className = 'fizmod-row';
    row.innerHTML = `
      <span class="fizmod-name">${names[r.fizmod] || r.fizmod}</span>
      <span class="fizmod-bar-wrap"><span class="fizmod-bar" style="width:${pct}%"></span></span>
      <span class="fizmod-amount">${fmtHuf(r.revenue)}</span>`;
    container.appendChild(row);
  });
}

function renderTopProducts(container, items) {
  if (!items.length) { container.innerHTML = '<div class="empty-state">Nincs adat a kiválasztott időszakban.</div>'; return; }
  const table = document.createElement('table');
  table.className = 'data-table';
  table.innerHTML = `<thead><tr><th>Termék</th><th class="td-right">Mennyiség</th><th class="td-right">Árbevétel</th></tr></thead>`;
  const tbody = document.createElement('tbody');
  items.forEach((it) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(it.nev)}</td><td class="num">${it.mennyiseg} ${escapeHtml(it.me || '')}</td><td class="num">${fmtHuf(it.arbevetel)}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.innerHTML = '';
  container.appendChild(table);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Hivatalos, NAV-szerű címmezők — újrahasznosítva a számlázási cím és a
// telephelyek címének bevitelénél is. `prefix` adja az egyedi id-eket,
// `vals` az esetleges kezdőértékeket, `jellegek` a közterület-jelleg
// legördülő listájának elemeit (a szerver adja vissza).
function navAddressFieldsHtml(prefix, vals = {}, jellegek = []) {
  const jellegOptions = jellegek.map((j) => `<option value="${escapeHtml(j)}" ${vals.kozteruletJelleg === j ? 'selected' : ''}>${escapeHtml(j)}</option>`).join('');
  return `
    <div class="nav-address-grid">
      <div class="stock-field">
        <label for="${prefix}-irsz">Irányítószám</label>
        <input id="${prefix}-irsz" maxlength="4" inputmode="numeric" placeholder="pl. 1053" value="${escapeHtml(vals.iranyitoszam)}">
      </div>
      <div class="stock-field">
        <label for="${prefix}-telepules">Település</label>
        <input id="${prefix}-telepules" placeholder="pl. Budapest" value="${escapeHtml(vals.telepules)}">
      </div>
      <div class="stock-field">
        <label for="${prefix}-kozterulet-nev">Közterület neve</label>
        <input id="${prefix}-kozterulet-nev" placeholder="pl. Kossuth Lajos" value="${escapeHtml(vals.kozteruletNev)}">
      </div>
      <div class="stock-field">
        <label for="${prefix}-kozterulet-jelleg">Közterület jellege</label>
        <select id="${prefix}-kozterulet-jelleg">
          <option value="">— válassz —</option>
          ${jellegOptions}
          <option value="_egyeb" ${vals.kozteruletJelleg && !jellegek.includes(vals.kozteruletJelleg) ? 'selected' : ''}>Egyéb (kézi bevitel)</option>
        </select>
      </div>
      <div class="stock-field" id="${prefix}-kozterulet-jelleg-egyeb-field" ${vals.kozteruletJelleg && !jellegek.includes(vals.kozteruletJelleg) ? '' : 'hidden'}>
        <label for="${prefix}-kozterulet-jelleg-egyeb">Közterület jellege (kézi bevitel)</label>
        <input id="${prefix}-kozterulet-jelleg-egyeb" placeholder="pl. sétány" value="${vals.kozteruletJelleg && !jellegek.includes(vals.kozteruletJelleg) ? escapeHtml(vals.kozteruletJelleg) : ''}">
      </div>
      <div class="stock-field">
        <label for="${prefix}-hazszam">Házszám</label>
        <input id="${prefix}-hazszam" placeholder="pl. 12" value="${escapeHtml(vals.hazszam)}">
      </div>
      <div class="stock-field">
        <label for="${prefix}-emelet">Emelet / ajtó / lépcsőház</label>
        <input id="${prefix}-emelet" placeholder="pl. 2. em. 3. ajtó (opcionális)" value="${escapeHtml(vals.emelet)}">
      </div>
    </div>`;
}
function wireNavAddressJellegCustom(prefix, jellegek) {
  const sel = document.getElementById(`${prefix}-kozterulet-jelleg`);
  const customField = document.getElementById(`${prefix}-kozterulet-jelleg-egyeb-field`);
  const customInput = document.getElementById(`${prefix}-kozterulet-jelleg-egyeb`);
  if (sel.value === '_egyeb') {
    customField.hidden = false;
    // Ha a betöltött érték nem szerepel az ismert listában, ide kerül át.
  }
  sel.addEventListener('change', () => { customField.hidden = sel.value !== '_egyeb'; });
}
function readNavAddressFields(prefix) {
  const jellegSel = document.getElementById(`${prefix}-kozterulet-jelleg`).value;
  const kozteruletJelleg = jellegSel === '_egyeb'
    ? document.getElementById(`${prefix}-kozterulet-jelleg-egyeb`).value.trim()
    : jellegSel;
  return {
    iranyitoszam: document.getElementById(`${prefix}-irsz`).value.trim(),
    telepules: document.getElementById(`${prefix}-telepules`).value.trim(),
    kozteruletNev: document.getElementById(`${prefix}-kozterulet-nev`).value.trim(),
    kozteruletJelleg,
    hazszam: document.getElementById(`${prefix}-hazszam`).value.trim(),
    emelet: document.getElementById(`${prefix}-emelet`).value.trim(),
  };
}

/* ============================================================
   Táblázat-rendezés — általános, bármelyik táblázatra ráépíthető.
   Az oszlop fejlécére kattintva növekvő/csökkenő sorrendbe rendezi a
   sorokat, a cella szöveges tartalma alapján (számfelismeréssel).
   Ha egy fejléc ne legyen rendezhető (pl. csak gombokat tartalmaz),
   adj neki data-no-sort attribútumot.
   ============================================================ */
function makeSortableTable(tableId) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const thead = table.querySelector('thead');
  if (!thead) return;
  thead.querySelectorAll('th').forEach((th, colIndex) => {
    if (th.dataset.noSort !== undefined || !th.textContent.trim()) return;
    th.classList.add('sortable-th');
    if (th.dataset.sortBound) return;
    th.dataset.sortBound = '1';
    th.addEventListener('click', () => sortTableByColumn(table, colIndex, th));
  });
}
function sortTableByColumn(table, colIndex, th) {
  const tbody = table.querySelector('tbody');
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll('tr'));
  if (rows.length < 2) return;
  const dir = th.dataset.sortDir === 'asc' ? 'desc' : 'asc';
  table.querySelectorAll('th').forEach((h) => { delete h.dataset.sortDir; h.classList.remove('sorted-asc', 'sorted-desc'); });
  th.dataset.sortDir = dir;
  th.classList.add(dir === 'asc' ? 'sorted-asc' : 'sorted-desc');

  const getRaw = (row) => {
    const cell = row.children[colIndex];
    return cell ? cell.textContent.trim() : '';
  };
  rows.sort((a, b) => {
    const va = getRaw(a), vb = getRaw(b);
    const na = parseFloat(va.replace(/[^\d,.-]/g, '').replace(',', '.'));
    const nb = parseFloat(vb.replace(/[^\d,.-]/g, '').replace(',', '.'));
    const bothNumeric = /\d/.test(va) && /\d/.test(vb) && !isNaN(na) && !isNaN(nb);
    const cmp = bothNumeric ? na - nb : va.localeCompare(vb, 'hu');
    return dir === 'asc' ? cmp : -cmp;
  });
  rows.forEach((r) => tbody.appendChild(r));
}

/* ============================================================
   SVG vonaldiagram — külső könyvtár nélkül
   ============================================================ */
function renderLineChart(container, points) {
  container.innerHTML = '';
  if (!points || !points.length) { container.innerHTML = '<div class="empty-state">Nincs megjeleníthető adat.</div>'; return; }
  const W = container.clientWidth || 560, H = container.classList.contains('chart-holder--tall') ? 280 : 200;
  const padL = 54, padR = 16, padT = 16, padB = 28;
  const max = Math.max(...points.map((p) => p.revenue), 1);
  const stepX = (W - padL - padR) / Math.max(points.length - 1, 1);
  const x = (i) => padL + i * stepX;
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);

  let path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.revenue).toFixed(1)}`).join(' ');
  let area = path + ` L ${x(points.length - 1).toFixed(1)} ${H - padB} L ${x(0)} ${H - padB} Z`;

  const gridLines = 4;
  let gridSvg = '';
  for (let g = 0; g <= gridLines; g++) {
    const gy = padT + ((H - padT - padB) / gridLines) * g;
    const val = Math.round(max * (1 - g / gridLines));
    gridSvg += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#D3E6F5" stroke-width="1"/>`;
    gridSvg += `<text x="${padL - 8}" y="${gy + 4}" font-size="10" fill="#6C8299" text-anchor="end" font-family="IBM Plex Mono">${formatShort(val)}</text>`;
  }
  const labelEvery = Math.max(Math.ceil(points.length / 7), 1);
  let labelsSvg = '';
  points.forEach((p, i) => {
    if (i % labelEvery === 0 || i === points.length - 1) {
      labelsSvg += `<text x="${x(i)}" y="${H - 8}" font-size="10" fill="#6C8299" text-anchor="middle" font-family="Inter">${shortDate(p.d)}</text>`;
    }
  });
  // Minden ponthoz egy nagyobb, láthatatlan érintési célterület is tartozik
  // (r=12) a kis, látható pont (r=2.6) körül — mobilon ujjal sokkal
  // könnyebb eltalálni, mint a puszta 2.6px sugarú kört.
  const dots = points.map((p, i) => `
    <g class="chart-dot-group" data-idx="${i}" style="cursor:pointer;">
      <circle cx="${x(i)}" cy="${y(p.revenue)}" r="12" fill="transparent"/>
      <circle cx="${x(i)}" cy="${y(p.revenue)}" r="2.6" fill="#3D71A8" class="chart-dot-visible"/>
    </g>`).join('');

  container.innerHTML = `
    <div class="chart-tooltip" id="chart-tooltip-${container.id || 'x'}" hidden></div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg">
      ${gridSvg}
      <path d="${area}" fill="rgba(90,147,201,0.18)" stroke="none"/>
      <path d="${path}" fill="none" stroke="#3D71A8" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      ${labelsSvg}
    </svg>`;

  const tooltip = container.querySelector('.chart-tooltip');
  container.querySelectorAll('.chart-dot-group').forEach((g) => {
    g.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = points[Number(g.dataset.idx)];
      const wasActive = g.classList.contains('is-active-point');
      container.querySelectorAll('.chart-dot-group').forEach((gg) => gg.classList.remove('is-active-point'));
      if (wasActive) { tooltip.hidden = true; return; }
      g.classList.add('is-active-point');
      tooltip.innerHTML = `<strong>${escapeHtml(shortDate(p.d))}</strong><br>${fmtHuf(p.revenue)}`;
      const cx = Number(g.querySelector('.chart-dot-visible').getAttribute('cx'));
      const cy = Number(g.querySelector('.chart-dot-visible').getAttribute('cy'));
      const leftPct = (cx / W) * 100;
      const topPx = Math.max(0, (cy / H) * H - 8);
      tooltip.style.left = `${leftPct}%`;
      tooltip.style.top = `${topPx}px`;
      tooltip.hidden = false;
    });
  });
  container.addEventListener('click', () => {
    tooltip.hidden = true;
    container.querySelectorAll('.chart-dot-group').forEach((gg) => gg.classList.remove('is-active-point'));
  });
}
function shortDate(d) {
  if (/^\d{2}$/.test(d)) return `${d}:00`; // óránkénti bontás — "14" -> "14:00"
  const dt = new Date(d);
  return dt.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' });
}
function formatShort(v) { if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M'; if (v >= 1000) return Math.round(v / 1000) + 'e'; return String(v); }

/* ============================================================
   Forgalom nézet
   ============================================================ */
function setGroup(g) {
  state.group = g;
  document.querySelectorAll('#group-toggle .chip').forEach((c) => c.classList.toggle('is-active', c.dataset.group === g));
}
document.querySelectorAll('#group-toggle .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const g = chip.dataset.group;
    if (g === 'hour' && state.range.from !== state.range.to) {
      // Óránkénti bontás csak egyetlen napra értelmezhető — automatikusan
      // egy napra szűkítjük a tartományt (a jelenlegi záró dátumra), és ezt
      // az "Egy nap" választóban is megjelenítjük, hogy látszódjon, mi történt.
      const day = state.range.to;
      state.range = { from: day, to: day, preset: 'single-day' };
      document.getElementById('range-select').value = 'single-day';
      document.getElementById('range-custom-inputs').hidden = true;
      document.getElementById('range-single-input').hidden = false;
      document.getElementById('single-day-input').value = day;
      updateRangeLabel();
    }
    setGroup(g);
    loadRevenueView();
  });
});

document.getElementById('analysis-type-row').querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#analysis-type-row .chip').forEach((c) => c.classList.remove('is-active'));
    chip.classList.add('is-active');
    const type = chip.dataset.analysis;
    document.getElementById('analysis-period-panel').hidden = type !== 'period';
    document.getElementById('analysis-hours-panel').hidden = type !== 'hours';
    document.getElementById('analysis-products-panel').hidden = type !== 'products';
    document.getElementById('analysis-report-panel').hidden = type !== 'report';
  });
});

// Alapértelmezett vizsgált időszak a cikkenkénti elemzéshez is — ugyanaz
// a 90 napos alapértelmezés, mint a nyitvatartás-elemzésnél.
(function initProductsAnDefaultRange() {
  const to = todayIso();
  const from = new Date(Date.now() - 89 * 86400000).toISOString().slice(0, 10);
  document.getElementById('products-an-to').value = to;
  document.getElementById('products-an-from').value = from;
})();

// Alapértelmezett vizsgált időszak: utolsó 90 nap — elég hosszú ahhoz, hogy
// minden hét napjából legyen több előfordulás, statisztikailag stabilabb
// átlagot adva, mint egy-két hét.
(function initHoursDefaultRange() {
  const to = todayIso();
  const from = new Date(Date.now() - 89 * 86400000).toISOString().slice(0, 10);
  document.getElementById('hours-to').value = to;
  document.getElementById('hours-from').value = from;
})();

listen('hours-run-btn', 'click', async () => {
  const btn = document.getElementById('hours-run-btn');
  const msg = document.getElementById('hours-msg');
  msg.textContent = ''; msg.className = 'stock-form-msg';
  btn.disabled = true; btn.textContent = 'Számolás…';
  try {
    const from = document.getElementById('hours-from').value;
    const to = document.getElementById('hours-to').value;
    if (!from || !to) throw new Error('Add meg a vizsgált időszakot.');
    const data = await api(`/api/analysis/opening-hours?from=${from}&to=${to}`);
    renderHoursResults(data);
    document.getElementById('hours-results').hidden = false;
  } catch (e) {
    msg.textContent = e.message; msg.className = 'stock-form-msg error';
  } finally {
    btn.disabled = false; btn.textContent = 'Elemzés indítása';
  }
});

let hoursAnalysisData = null;

let hoursMetric = 'revenue';
const HOURS_METRIC_META = {
  revenue: { label: 'Forgalom', fmt: (v) => fmtHuf(v), title: 'Forgalom napszak és hét napja szerint' },
  nyugtaszam: { label: 'Nyugtaszám', fmt: (v) => `${v} db`, title: 'Nyugtaszám napszak és hét napja szerint' },
  kosarertek: { label: 'Kosárérték', fmt: (v) => fmtHuf(v), title: 'Átlagos kosárérték napszak és hét napja szerint' },
};
document.getElementById('hours-metric-row').querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#hours-metric-row .chip').forEach((c) => c.classList.remove('is-active'));
    chip.classList.add('is-active');
    hoursMetric = chip.dataset.metric;
    if (hoursAnalysisData) {
      renderHoursResults(hoursAnalysisData);
      const activeDayChip = document.querySelector('#hours-day-picker .chip.is-active');
      if (activeDayChip) renderHoursDayDetail(Number(activeDayChip.dataset.wd));
    }
  });
});

function renderHoursResults(data) {
  hoursAnalysisData = data;
  document.getElementById('hours-global-analysis').textContent = data.globalRecommendation;
  const meta = HOURS_METRIC_META[hoursMetric];
  document.getElementById('hours-heatmap-title').textContent = meta.title;
  document.getElementById('hours-heatmap-sub').innerHTML =
    `minden mező az ADOTT hét-nap ADOTT órájának ÁTLAGOS (nem összesített) <b>${meta.label.toLowerCase()}</b> mutatóját jelzi. Minél sötétebb egy mező, annál nagyobb az érték. A nyitvatartáson kívüli órák halványítva. Kattints egy mezőre a pontos átlag és medián megtekintéséhez.`;

  // A hőtérkép csak azt az óra-tartományt mutatja, ami ténylegesen releváns
  // (a legkorábbi nyitástól a legkésőbbi zárásig, egy kis ráhagyással) —
  // nincs értelme 0-24 óráig mutatni egy nappali nyitvatartású boltnál.
  const activeDays = data.weekdays.filter((w) => w.napok > 0);
  let minH = 23, maxH = 0;
  activeDays.forEach((w) => {
    const oh = w.avgNyitas ? parseInt(w.avgNyitas.slice(0, 2), 10) : 8;
    const ch = w.avgZaras ? parseInt(w.avgZaras.slice(0, 2), 10) + 1 : 20;
    if (oh - 1 < minH) minH = Math.max(0, oh - 1);
    if (ch + 1 > maxH) maxH = Math.min(23, ch + 1);
  });
  if (!activeDays.length) { minH = 8; maxH = 20; }

  const globalMax = Math.max(...data.heatmap[hoursMetric].flat(), 1);
  const order = [1, 2, 3, 4, 5, 6, 0];
  let html = '<table><thead><tr><th></th>';
  for (let h = minH; h <= maxH; h++) html += `<th>${h}</th>`;
  html += '</tr></thead><tbody>';
  order.forEach((wd) => {
    const w = data.weekdays[wd];
    const oh = w.avgNyitas ? parseInt(w.avgNyitas.slice(0, 2), 10) : null;
    const ch = w.avgZaras ? parseInt(w.avgZaras.slice(0, 2), 10) : null;
    html += `<tr><th class="hh-wd-label">${w.label}</th>`;
    for (let h = minH; h <= maxH; h++) {
      const avg = w.hourly[hoursMetric].avg[h] || 0;
      const isOpen = oh !== null && ch !== null && h >= oh && h < ch;
      const alpha = Math.min(1, avg / globalMax);
      const bg = isOpen ? `rgba(61,113,168,${(0.08 + alpha * 0.85).toFixed(2)})` : 'transparent';
      const cls = isOpen ? '' : 'hh-closed';
      html += `<td><div class="hh-cell ${cls}" data-wd="${wd}" data-hh="${h}" style="background:${bg}"></div></td>`;
    }
    html += '</tr>';
  });
  html += '</tbody></table>';
  document.getElementById('hours-heatmap').innerHTML = html;

  const heatmapTip = document.getElementById('hours-heatmap-tip');
  document.querySelectorAll('.hh-cell').forEach((cell) => {
    cell.addEventListener('click', () => {
      const wd = Number(cell.dataset.wd), h = Number(cell.dataset.hh);
      const w = data.weekdays[wd];
      const avg = w.hourly[hoursMetric].avg[h] || 0, med = w.hourly[hoursMetric].median[h] || 0;
      heatmapTip.innerHTML = `<b>${w.label} ${h}:00–${h + 1}:00</b> — ${meta.label.toLowerCase()} átlag: ${meta.fmt(avg)}, medián: ${meta.fmt(med)} (${w.napok} ${w.label.toLowerCase()} alapján)`;
      heatmapTip.hidden = false;
    });
  });

  // Napi részletek választó — csak azok a napok, amikhez van adat.
  const picker = document.getElementById('hours-day-picker');
  picker.innerHTML = order.filter((wd) => data.weekdays[wd].napok > 0)
    .map((wd, i) => `<button class="chip${i === 0 ? ' is-active' : ''}" data-wd="${wd}">${data.weekdays[wd].label}</button>`).join('');
  picker.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      picker.querySelectorAll('.chip').forEach((c) => c.classList.remove('is-active'));
      chip.classList.add('is-active');
      renderHoursDayDetail(Number(chip.dataset.wd));
    });
  });
  const firstWd = order.find((wd) => data.weekdays[wd].napok > 0);
  if (firstWd !== undefined) renderHoursDayDetail(firstWd);
}

function renderHoursDayDetail(wd) {
  const w = hoursAnalysisData.weekdays[wd];
  const meta = HOURS_METRIC_META[hoursMetric];
  document.getElementById('hours-day-analysis').textContent = w.recommendation || 'Nincs elegendő adat ehhez a naphoz.';
  document.getElementById('hours-day-sub').textContent =
    `Az oszlopok az ÁTLAGOS óránkénti ${meta.label.toLowerCase()}ot mutatják, ${w.napok} db ${w.label.toLowerCase()} alapján; a pont a MEDIÁNT jelzi. Kattints egy oszlopra a pontos értékekért.`;

  const container = document.getElementById('hours-day-chart');
  container.innerHTML = '';
  const oh = w.avgNyitas ? parseInt(w.avgNyitas.slice(0, 2), 10) : null;
  const ch = w.avgZaras ? parseInt(w.avgZaras.slice(0, 2), 10) : null;
  const minH = oh !== null ? Math.max(0, oh - 1) : 6;
  const maxH = ch !== null ? Math.min(23, ch + 1) : 22;
  const hours = [];
  for (let h = minH; h <= maxH; h++) hours.push(h);

  const hourlyAvg = w.hourly[hoursMetric].avg;
  const hourlyMedian = w.hourly[hoursMetric].median;
  const W = container.clientWidth || 560, H = 240;
  const padL = 58, padR = 16, padT = 20, padB = 32;
  const max = Math.max(...hours.map((h) => Math.max(hourlyAvg[h] || 0, hourlyMedian[h] || 0)), 1);
  const groupW = (W - padL - padR) / hours.length;
  const barW = groupW * 0.6;
  let bars = '', labels = '', dots = '';
  hours.forEach((h, i) => {
    const avg = hourlyAvg[h] || 0;
    const med = hourlyMedian[h] || 0;
    const isOpen = oh !== null && ch !== null && h >= oh && h < ch;
    const barH = (H - padT - padB) * (avg / max);
    const gx = padL + i * groupW;
    const cx = gx + groupW / 2;
    bars += `<rect class="hours-bar" data-h="${h}" x="${(cx - barW / 2).toFixed(1)}" y="${(H - padB - barH).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(barH, 1).toFixed(1)}" fill="${isOpen ? '#3D71A8' : '#C8CDD4'}" rx="3" style="cursor:pointer;"/>`;
    const medY = H - padB - (H - padT - padB) * (med / max);
    dots += `<circle cx="${cx.toFixed(1)}" cy="${medY.toFixed(1)}" r="3.5" fill="#F0A93E" stroke="#fff" stroke-width="1.2"/>`;
    labels += `<text x="${cx.toFixed(1)}" y="${H - 12}" font-size="10" fill="#6C8299" text-anchor="middle" font-family="IBM Plex Mono">${h}</text>`;
  });
  let gridSvg = '';
  for (let g = 0; g <= 3; g++) {
    const gy = padT + ((H - padT - padB) / 3) * g;
    const val = Math.round(max * (1 - g / 3));
    gridSvg += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#EDF2F8" stroke-width="1"/>`;
    gridSvg += `<text x="${padL - 8}" y="${gy + 4}" font-size="10" fill="#6C8299" text-anchor="end" font-family="IBM Plex Mono">${hoursMetric === 'nyugtaszam' ? val : formatShort(val)}</text>`;
  }
  const axisLabel = `<text x="${-(H / 2)}" y="14" font-size="10.5" fill="#6C8299" text-anchor="middle" font-family="Inter" transform="rotate(-90)">${meta.label}${hoursMetric !== 'nyugtaszam' ? ' (Ft)' : ''}</text>`;
  container.innerHTML = `
    <div class="chart-tooltip" id="hours-day-tooltip" hidden></div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg">
      ${gridSvg}${axisLabel}${bars}${dots}${labels}
    </svg>
    <div class="chart-legend">
      <span><i style="background:#3D71A8;"></i>Átlag (nyitvatartáson belül)</span>
      <span><i style="background:#C8CDD4;"></i>Átlag (nyitvatartáson kívül)</span>
      <span><i style="background:#F0A93E;border-radius:50%;height:8px;width:8px;"></i>Medián</span>
    </div>`;

  const tooltip = document.getElementById('hours-day-tooltip');
  container.querySelectorAll('.hours-bar').forEach((bar) => {
    bar.addEventListener('click', () => {
      const h = Number(bar.dataset.h);
      const avg = hourlyAvg[h] || 0, med = hourlyMedian[h] || 0;
      tooltip.innerHTML = `<strong>${h}:00–${h + 1}:00</strong><br>Átlag: ${meta.fmt(avg)}<br>Medián: ${meta.fmt(med)}<br>${w.napok} nap alapján`;
      const bx = Number(bar.getAttribute('x')) + Number(bar.getAttribute('width')) / 2;
      const by = Number(bar.getAttribute('y'));
      tooltip.style.left = `${(bx / W) * 100}%`;
      tooltip.style.top = `${by}px`;
      tooltip.hidden = false;
    });
  });
  container.addEventListener('click', (e) => { if (!e.target.classList.contains('hours-bar')) tooltip.hidden = true; });
}

listen('products-an-run-btn', 'click', async () => {
  const btn = document.getElementById('products-an-run-btn');
  const msg = document.getElementById('products-an-msg');
  msg.textContent = ''; msg.className = 'stock-form-msg';
  btn.disabled = true; btn.textContent = 'Számolás…';
  try {
    const from = document.getElementById('products-an-from').value;
    const to = document.getElementById('products-an-to').value;
    if (!from || !to) throw new Error('Add meg a vizsgált időszakot.');
    const data = await api(`/api/analysis/products/top?from=${from}&to=${to}&limit=15`);
    renderProductsTopList(data);
    document.getElementById('products-an-results').hidden = false;
  } catch (e) {
    msg.textContent = e.message; msg.className = 'stock-form-msg error';
  } finally {
    btn.disabled = false; btn.textContent = 'Elemzés indítása';
  }
});

let productsAnData = null;
let productsAnMetric = 'mennyiseg';
const PRODUCTS_METRIC_META = {
  mennyiseg: { label: 'Mennyiség', fmt: (v) => `${v} db` },
  bevetel: { label: 'Bevétel', fmt: (v) => fmtHuf(v) },
};

function renderProductsTopList(data) {
  const box = document.getElementById('products-top-list');
  if (!data.products.length) { box.innerHTML = '<span class="muted">Nincs eladási adat a kiválasztott időszakban.</span>'; return; }
  box.innerHTML = data.products.map((p, i) => `
    <div class="compare-mover-row">
      <span class="compare-mover-name">${i + 1}. ${escapeHtml(p.nev)}</span>
      <span style="display:flex;gap:10px;align-items:center;">
        <span class="card-subtitle" style="margin:0;">${p.mennyiseg} db · ${fmtHuf(p.bevetel)}</span>
        <button class="btn-tiny products-select-btn" data-cikk="${escapeHtml(p.nev)}">Elemzés</button>
      </span>
    </div>`).join('');
  box.querySelectorAll('.products-select-btn').forEach((btn) => {
    btn.addEventListener('click', () => loadProductDetail(btn.dataset.cikk, document.getElementById('products-an-from').value, document.getElementById('products-an-to').value));
  });
  // Automatikusan mutassuk az elsőt (legjobban fogyó cikket), hogy azonnal
  // legyen mit látni, ne kelljen külön rákattintani.
  if (data.products.length) loadProductDetail(data.products[0].nev, data.from, data.to);
}

async function loadProductDetail(cikk, from, to) {
  document.getElementById('products-detail-title').textContent = `Cikk-elemzés — ${cikk}`;
  try {
    const data = await api(`/api/analysis/products/detail?from=${from}&to=${to}&cikk=${encodeURIComponent(cikk)}`);
    productsAnData = data;
    renderProductsResults(data);
  } catch (e) {
    document.getElementById('products-global-analysis').textContent = e.message;
  }
}

document.getElementById('products-metric-row').querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#products-metric-row .chip').forEach((c) => c.classList.remove('is-active'));
    chip.classList.add('is-active');
    productsAnMetric = chip.dataset.metric;
    if (productsAnData) {
      renderProductsResults(productsAnData);
      const activeDayChip = document.querySelector('#products-day-picker .chip.is-active');
      if (activeDayChip) renderProductsDayDetail(Number(activeDayChip.dataset.wd));
    }
  });
});

function renderProductsResults(data) {
  document.getElementById('products-global-analysis').textContent = data.globalRecommendation;
  const meta = PRODUCTS_METRIC_META[productsAnMetric];

  const activeDays = data.weekdays.filter((w) => w.napok > 0);
  const order = [1, 2, 3, 4, 5, 6, 0];
  const globalMax = Math.max(...data.heatmap[productsAnMetric].flat(), 1);
  let html = '<table><thead><tr><th></th>';
  for (let h = 0; h < 24; h++) html += `<th>${h}</th>`;
  html += '</tr></thead><tbody>';
  order.forEach((wd) => {
    const w = data.weekdays[wd];
    html += `<tr><th class="hh-wd-label">${w.label}</th>`;
    for (let h = 0; h < 24; h++) {
      const avg = w.hourly[productsAnMetric].avg[h] || 0;
      const alpha = Math.min(1, avg / globalMax);
      const bg = w.napok > 0 ? `rgba(61,113,168,${(0.08 + alpha * 0.85).toFixed(2)})` : 'transparent';
      html += `<td><div class="hh-cell${w.napok === 0 ? ' hh-closed' : ''}" data-wd="${wd}" data-hh="${h}" style="background:${bg}"></div></td>`;
    }
    html += '</tr>';
  });
  html += '</tbody></table>';
  document.getElementById('products-heatmap').innerHTML = html;

  const heatmapTip = document.getElementById('products-heatmap-tip');
  document.querySelectorAll('#products-heatmap .hh-cell').forEach((cell) => {
    cell.addEventListener('click', () => {
      const wd = Number(cell.dataset.wd), h = Number(cell.dataset.hh);
      const w = data.weekdays[wd];
      const avg = w.hourly[productsAnMetric].avg[h] || 0, med = w.hourly[productsAnMetric].median[h] || 0;
      heatmapTip.innerHTML = `<b>${w.label} ${h}:00–${h + 1}:00</b> — ${meta.label.toLowerCase()} átlag: ${meta.fmt(avg)}, medián: ${meta.fmt(med)} (${w.napok} nap alapján)`;
      heatmapTip.hidden = false;
    });
  });

  const picker = document.getElementById('products-day-picker');
  picker.innerHTML = order.filter((wd) => data.weekdays[wd].napok > 0)
    .map((wd, i) => `<button class="chip${i === 0 ? ' is-active' : ''}" data-wd="${wd}">${data.weekdays[wd].label}</button>`).join('');
  picker.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      picker.querySelectorAll('.chip').forEach((c) => c.classList.remove('is-active'));
      chip.classList.add('is-active');
      renderProductsDayDetail(Number(chip.dataset.wd));
    });
  });
  const firstWd = order.find((wd) => data.weekdays[wd].napok > 0);
  if (firstWd !== undefined) renderProductsDayDetail(firstWd);
  else { document.getElementById('products-day-chart').innerHTML = '<div class="empty-state">Nincs adat.</div>'; document.getElementById('products-day-analysis').textContent = ''; }
}

function renderProductsDayDetail(wd) {
  const w = productsAnData.weekdays[wd];
  const meta = PRODUCTS_METRIC_META[productsAnMetric];
  document.getElementById('products-day-analysis').textContent = w.recommendation || 'Nincs elegendő adat ehhez a naphoz.';
  document.getElementById('products-day-sub').textContent =
    `Az oszlopok az ÁTLAGOS óránkénti ${meta.label.toLowerCase()}et mutatják, ${w.napok} db ${w.label.toLowerCase()} alapján; a pont a MEDIÁNT jelzi.`;

  const container = document.getElementById('products-day-chart');
  container.innerHTML = '';
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const hourlyAvg = w.hourly[productsAnMetric].avg;
  const hourlyMedian = w.hourly[productsAnMetric].median;
  const W = container.clientWidth || 560, H = 240;
  const padL = 58, padR = 16, padT = 20, padB = 32;
  const max = Math.max(...hours.map((h) => Math.max(hourlyAvg[h] || 0, hourlyMedian[h] || 0)), 1);
  const groupW = (W - padL - padR) / hours.length;
  const barW = groupW * 0.6;
  let bars = '', labels = '', dots = '';
  hours.forEach((h, i) => {
    const avg = hourlyAvg[h] || 0;
    const med = hourlyMedian[h] || 0;
    const barH = (H - padT - padB) * (avg / max);
    const gx = padL + i * groupW;
    const cx = gx + groupW / 2;
    bars += `<rect class="products-bar" data-h="${h}" x="${(cx - barW / 2).toFixed(1)}" y="${(H - padB - barH).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(barH, 1).toFixed(1)}" fill="#3D71A8" rx="3" style="cursor:pointer;"/>`;
    const medY = H - padB - (H - padT - padB) * (med / max);
    dots += `<circle cx="${cx.toFixed(1)}" cy="${medY.toFixed(1)}" r="3.5" fill="#F0A93E" stroke="#fff" stroke-width="1.2"/>`;
    if (h % 2 === 0) labels += `<text x="${cx.toFixed(1)}" y="${H - 12}" font-size="10" fill="#6C8299" text-anchor="middle" font-family="IBM Plex Mono">${h}</text>`;
  });
  let gridSvg = '';
  for (let g = 0; g <= 3; g++) {
    const gy = padT + ((H - padT - padB) / 3) * g;
    const val = Math.round(max * (1 - g / 3) * 10) / 10;
    gridSvg += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#EDF2F8" stroke-width="1"/>`;
    gridSvg += `<text x="${padL - 8}" y="${gy + 4}" font-size="10" fill="#6C8299" text-anchor="end" font-family="IBM Plex Mono">${productsAnMetric === 'mennyiseg' ? val : formatShort(val)}</text>`;
  }
  container.innerHTML = `
    <div class="chart-tooltip" id="products-day-tooltip" hidden></div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg">
      ${gridSvg}${bars}${dots}${labels}
    </svg>
    <div class="chart-legend">
      <span><i style="background:#3D71A8;"></i>Átlag</span>
      <span><i style="background:#F0A93E;border-radius:50%;height:8px;width:8px;"></i>Medián</span>
    </div>`;

  const tooltip = document.getElementById('products-day-tooltip');
  container.querySelectorAll('.products-bar').forEach((bar) => {
    bar.addEventListener('click', () => {
      const h = Number(bar.dataset.h);
      const avg = hourlyAvg[h] || 0, med = hourlyMedian[h] || 0;
      tooltip.innerHTML = `<strong>${h}:00–${h + 1}:00</strong><br>Átlag: ${meta.fmt(avg)}<br>Medián: ${meta.fmt(med)}<br>${w.napok} nap alapján`;
      const bx = Number(bar.getAttribute('x')) + Number(bar.getAttribute('width')) / 2;
      const by = Number(bar.getAttribute('y'));
      tooltip.style.left = `${(bx / W) * 100}%`;
      tooltip.style.top = `${by}px`;
      tooltip.hidden = false;
    });
  });
  container.addEventListener('click', (e) => { if (!e.target.classList.contains('products-bar')) tooltip.hidden = true; });
}

// Alapértelmezett vizsgált időszak a riporthoz — 30 nap, ez egy
// gyors, "egy pillantás alatt átlátható" összefoglalóhoz elég.
(function initReportDefaultRange() {
  const to = todayIso();
  const from = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  document.getElementById('report-an-to').value = to;
  document.getElementById('report-an-from').value = from;
})();

listen('report-an-run-btn', 'click', async () => {
  const btn = document.getElementById('report-an-run-btn');
  const msg = document.getElementById('report-an-msg');
  msg.textContent = ''; msg.className = 'stock-form-msg';
  btn.disabled = true; btn.textContent = 'Számolás…';
  try {
    const from = document.getElementById('report-an-from').value;
    const to = document.getElementById('report-an-to').value;
    if (!from || !to) throw new Error('Add meg a vizsgált időszakot.');
    const data = await api(`/api/analysis/report?from=${from}&to=${to}`);
    renderReport(data);
    document.getElementById('report-an-results').hidden = false;
  } catch (e) {
    msg.textContent = e.message; msg.className = 'stock-form-msg error';
  } finally {
    btn.disabled = false; btn.textContent = 'Riport készítése';
  }
});

function renderReport(data) {
  document.getElementById('report-osszefoglalo').textContent = data.osszefoglalo;
  document.getElementById('report-kpi-grid').innerHTML = `
    <div class="compare-overview-card is-focus">
      <div class="compare-overview-label">Összforgalom</div>
      <div class="compare-overview-value">${fmtHuf(data.revenue)}</div>
    </div>
    <div class="compare-overview-card">
      <div class="compare-overview-label">Nyugtaszám</div>
      <div class="compare-overview-value">${data.receiptCount} db</div>
    </div>
    <div class="compare-overview-card">
      <div class="compare-overview-label">Átlagos kosárérték</div>
      <div class="compare-overview-value">${fmtHuf(data.avgBasket)}</div>
    </div>`;

  renderReportWeekdayChart(document.getElementById('report-weekday-chart'), data.weekday);

  const topBox = document.getElementById('report-top-products');
  topBox.innerHTML = data.topProducts.length
    ? data.topProducts.map((p, i) => `
        <div class="compare-mover-row">
          <span class="compare-mover-name">${i + 1}. ${escapeHtml(p.nev)}</span>
          <span class="card-subtitle" style="margin:0;">${p.mennyiseg} db · ${fmtHuf(p.bevetel)}</span>
        </div>`).join('')
    : '<div class="empty-state">Nincs eladási adat.</div>';
}

/* Egyszerű, egy-sorozatos oszlopdiagram a hét napjai szerint — a
   riporthoz, ahol nincs A/B összehasonlítás, csak egy önmagában
   értelmezhető heti mintázat. */
function renderReportWeekdayChart(container, weekday) {
  container.innerHTML = '';
  const W = container.clientWidth || 560, H = 200;
  const padL = 54, padR = 16, padT = 16, padB = 30;
  const order = [1, 2, 3, 4, 5, 6, 0];
  const max = Math.max(...weekday.map((w) => w.avgRevenue), 1);
  const groupW = (W - padL - padR) / 7;
  const barW = groupW * 0.5;
  let bars = '', labels = '';
  order.forEach((wd, gi) => {
    const w = weekday[wd];
    const gx = padL + gi * groupW;
    const barH = (H - padT - padB) * (w.avgRevenue / max);
    bars += `<rect x="${(gx + groupW / 2 - barW / 2).toFixed(1)}" y="${(H - padB - barH).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(barH, 1).toFixed(1)}" fill="#3D71A8" rx="3"/>`;
    labels += `<text x="${(gx + groupW / 2).toFixed(1)}" y="${H - 10}" font-size="10.5" fill="#6C8299" text-anchor="middle" font-family="Inter">${w.label.slice(0, 3)}</text>`;
  });
  let gridSvg = '';
  for (let g = 0; g <= 3; g++) {
    const gy = padT + ((H - padT - padB) / 3) * g;
    const val = Math.round(max * (1 - g / 3));
    gridSvg += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#EDF2F8" stroke-width="1"/>`;
    gridSvg += `<text x="${padL - 8}" y="${gy + 4}" font-size="10" fill="#6C8299" text-anchor="end" font-family="IBM Plex Mono">${formatShort(val)}</text>`;
  }
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg">${gridSvg}${bars}${labels}</svg>`;
}

let compareState = { mode: 'years' };


function initCompareYearSelects() {
  const thisYear = new Date().getFullYear();
  const yA = document.getElementById('compare-yearA');
  const yB = document.getElementById('compare-yearB');
  yA.innerHTML = ''; yB.innerHTML = '';
  for (let y = thisYear; y >= thisYear - 6; y--) {
    yA.innerHTML += `<option value="${y}" ${y === thisYear ? 'selected' : ''}>${y}</option>`;
    yB.innerHTML += `<option value="${y}" ${y === thisYear - 1 ? 'selected' : ''}>${y}</option>`;
  }
}
initCompareYearSelects();

document.getElementById('compare-mode-row').querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#compare-mode-row .chip').forEach((c) => c.classList.remove('is-active'));
    chip.classList.add('is-active');
    compareState.mode = chip.dataset.mode;
    document.getElementById('compare-controls-years').hidden = compareState.mode !== 'years';
    document.getElementById('compare-controls-custom').hidden = compareState.mode !== 'custom';
    document.getElementById('compare-controls-weekday').hidden = compareState.mode !== 'weekday';
    document.getElementById('compare-results').hidden = true;
    document.getElementById('compare-msg').textContent = '';
  });
});

let compareCikkTimer = null;
listen('compare-cikk-input', 'input', () => {
  clearTimeout(compareCikkTimer);
  const q = document.getElementById('compare-cikk-input').value.trim();
  compareCikkTimer = setTimeout(async () => {
    if (q.length < 2) return;
    try {
      const res = await api(`/api/compare/products?q=${encodeURIComponent(q)}`);
      document.getElementById('compare-cikk-list').innerHTML = res.items.map((n) => `<option value="${escapeHtml(n)}">`).join('');
    } catch (_) { /* csendben, ez csak kényelmi segédlet */ }
  }, 250);
});

listen('compare-run-btn', 'click', async () => {
  const btn = document.getElementById('compare-run-btn');
  const msg = document.getElementById('compare-msg');
  msg.textContent = ''; msg.className = 'stock-form-msg';
  btn.disabled = true; btn.textContent = 'Számolás…';
  try {
    const cikk = document.getElementById('compare-cikk-input').value.trim();
    const params = new URLSearchParams({ mode: compareState.mode });
    if (cikk) params.set('cikk', cikk);

    if (compareState.mode === 'years') {
      params.set('yearA', document.getElementById('compare-yearA').value);
      params.set('yearB', document.getElementById('compare-yearB').value);
    } else if (compareState.mode === 'custom') {
      const fromA = document.getElementById('compare-fromA').value;
      const toA = document.getElementById('compare-toA').value;
      const fromB = document.getElementById('compare-fromB').value;
      const toB = document.getElementById('compare-toB').value;
      if (!fromA || !toA || !fromB || !toB) throw new Error('Add meg mind a négy dátumot.');
      params.set('fromA', fromA); params.set('toA', toA); params.set('fromB', fromB); params.set('toB', toB);
    } else if (compareState.mode === 'weekday') {
      const from = document.getElementById('compare-wd-from').value;
      const to = document.getElementById('compare-wd-to').value;
      if (!from || !to) throw new Error('Add meg az időszak kezdetét és végét.');
      params.set('from', from); params.set('to', to);
      params.set('weekday', document.getElementById('compare-wd-day').value);
    }

    const data = await api(`/api/compare?${params.toString()}`);
    if (compareState.mode === 'weekday') renderWeekdayTrendResults(data);
    else renderCompareResults(data);
    document.getElementById('compare-results').hidden = false;
  } catch (e) {
    msg.textContent = e.message; msg.className = 'stock-form-msg error';
  } finally {
    btn.disabled = false; btn.textContent = 'Elemzés indítása';
  }
});

function renderCompareResults(data) {
  document.getElementById('compare-trend-card').hidden = false;
  document.getElementById('compare-weekday-card').hidden = false;
  document.getElementById('compare-movers-grid').hidden = !data.movers;

  const grid = document.getElementById('compare-overview-grid');
  const cards = [data.periodA, data.periodB];
  grid.innerHTML = cards.map((p, i) => `
    <div class="compare-overview-card${i === 0 ? ' is-focus' : ''}">
      <div class="compare-overview-label">${escapeHtml(p.label)} (${fmtDate(p.from)} – ${fmtDate(p.to)})</div>
      <div class="compare-overview-value">${fmtHuf(p.revenue)}</div>
      <div class="compare-overview-delta">${p.receiptCount} nyugta</div>
    </div>`).join('');
  document.getElementById('compare-overview-analysis').textContent = data.analysis;

  document.getElementById('compare-trend-title').textContent = `Napi trend, egymásra illesztve — ${data.periodA.label} vs. ${data.periodB.label}`;
  document.getElementById('compare-trend-sub').textContent =
    `${fmtDate(data.periodA.from)} – ${fmtDate(data.periodA.to)} (kék) vs. ${fmtDate(data.periodB.from)} – ${fmtDate(data.periodB.to)} (szürke) — napok sorrendje szerint illesztve`;
  renderComparisonChart(document.getElementById('compare-trend-chart'), data.dailyA, data.dailyB);

  renderWeekdayChart(document.getElementById('compare-weekday-chart'), data.weekdayA, data.weekdayB, data.periodB.label);

  if (data.movers) {
    const gainersBox = document.getElementById('compare-gainers-list');
    gainersBox.innerHTML = data.movers.gainers.length
      ? data.movers.gainers.map((m) => `
          <div class="compare-mover-row">
            <span class="compare-mover-name">${escapeHtml(m.nev)}</span>
            <span class="compare-mover-delta up">▲ ${fmtHuf(m.deltaRevenue)}</span>
          </div>`).join('')
      : '<div class="empty-state">Nincs kiugró növekedés.</div>';
    const losersBox = document.getElementById('compare-losers-list');
    losersBox.innerHTML = data.movers.losers.length
      ? data.movers.losers.map((m) => `
          <div class="compare-mover-row">
            <span class="compare-mover-name">${escapeHtml(m.nev)}</span>
            <span class="compare-mover-delta down">▼ ${fmtHuf(Math.abs(m.deltaRevenue))}</span>
          </div>`).join('')
      : '<div class="empty-state">Nincs kiugró visszaesés.</div>';
  }
}

function renderWeekdayTrendResults(data) {
  document.getElementById('compare-weekday-card').hidden = true;
  document.getElementById('compare-movers-grid').hidden = true;
  document.getElementById('compare-trend-card').hidden = false;

  const grid = document.getElementById('compare-overview-grid');
  grid.innerHTML = `
    <div class="compare-overview-card is-focus">
      <div class="compare-overview-label">${escapeHtml(data.weekdayLabel)}k — ${fmtDate(data.from)} – ${fmtDate(data.to)}</div>
      <div class="compare-overview-value">${fmtHuf(data.avg)} <span style="font-size:11px;font-weight:400;color:var(--text-dim);">átlag / nap</span></div>
      <div class="compare-overview-delta">${data.points.length} előfordulás</div>
    </div>`;
  document.getElementById('compare-overview-analysis').textContent = data.analysis;

  document.getElementById('compare-trend-title').textContent = `${data.weekdayLabel}k trendje`;
  document.getElementById('compare-trend-sub').textContent = `Minden ${data.weekdayLabel.toLowerCase()} forgalma időrendben, ${fmtDate(data.from)} – ${fmtDate(data.to)} között`;
  renderSingleTrendChart(document.getElementById('compare-trend-chart'), data.points);
}

/* Két vonalat egymásra illesztő SVG-diagram — a jelenlegi időszakot és a
   kiválasztott viszonyítási alapot napok sorrendje szerint (nem naptári
   dátum szerint) veti egybe, hogy a görbék ALAKJA közvetlenül összevethető
   legyen. */
function renderComparisonChart(container, curPoints, focusPoints) {
  container.innerHTML = '';
  if (!curPoints.length) { container.innerHTML = '<div class="empty-state">Nincs megjeleníthető adat.</div>'; return; }
  const W = container.clientWidth || 560, H = 280;
  const padL = 54, padR = 16, padT = 16, padB = 28;
  const n = Math.max(curPoints.length, focusPoints.length);
  const max = Math.max(...curPoints.map((p) => p.revenue), ...focusPoints.map((p) => p.revenue), 1);
  const stepX = (W - padL - padR) / Math.max(n - 1, 1);
  const x = (i) => padL + i * stepX;
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const pathOf = (pts) => pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.revenue).toFixed(1)}`).join(' ');

  let gridSvg = '';
  for (let g = 0; g <= 4; g++) {
    const gy = padT + ((H - padT - padB) / 4) * g;
    const val = Math.round(max * (1 - g / 4));
    gridSvg += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#D3E6F5" stroke-width="1"/>`;
    gridSvg += `<text x="${padL - 8}" y="${gy + 4}" font-size="10" fill="#6C8299" text-anchor="end" font-family="IBM Plex Mono">${formatShort(val)}</text>`;
  }
  const labelEvery = Math.max(Math.ceil(n / 7), 1);
  let labelsSvg = '';
  for (let i = 0; i < n; i++) {
    if (i % labelEvery === 0 || i === n - 1) {
      labelsSvg += `<text x="${x(i)}" y="${H - 8}" font-size="10" fill="#6C8299" text-anchor="middle" font-family="Inter">${i + 1}. nap</text>`;
    }
  }

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg">
      ${gridSvg}
      <path d="${pathOf(focusPoints)}" fill="none" stroke="#9AA9B8" stroke-width="2" stroke-dasharray="5,4" stroke-linejoin="round" stroke-linecap="round"/>
      <path d="${pathOf(curPoints)}" fill="none" stroke="#3D71A8" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
      ${labelsSvg}
    </svg>
    <div class="chart-legend">
      <span><i style="background:#3D71A8;"></i>1. időszak</span>
      <span><i style="background:#9AA9B8;"></i>2. időszak</span>
    </div>`;
}

/* Egyetlen vonalat mutató SVG-diagram — a hét-napi trend nézethez, ahol
   nincs A/B összehasonlítás, csak egy folytonos idősor. */
function renderSingleTrendChart(container, points) {
  container.innerHTML = '';
  if (!points.length) { container.innerHTML = '<div class="empty-state">Nincs megjeleníthető adat.</div>'; return; }
  const W = container.clientWidth || 560, H = 280;
  const padL = 54, padR = 16, padT = 16, padB = 32;
  const max = Math.max(...points.map((p) => p.revenue), 1);
  const stepX = (W - padL - padR) / Math.max(points.length - 1, 1);
  const x = (i) => padL + i * stepX;
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.revenue).toFixed(1)}`).join(' ');

  let gridSvg = '';
  for (let g = 0; g <= 4; g++) {
    const gy = padT + ((H - padT - padB) / 4) * g;
    const val = Math.round(max * (1 - g / 4));
    gridSvg += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#D3E6F5" stroke-width="1"/>`;
    gridSvg += `<text x="${padL - 8}" y="${gy + 4}" font-size="10" fill="#6C8299" text-anchor="end" font-family="IBM Plex Mono">${formatShort(val)}</text>`;
  }
  const labelEvery = Math.max(Math.ceil(points.length / 8), 1);
  let labelsSvg = '';
  const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.revenue).toFixed(1)}" r="3" fill="#3D71A8"/>`).join('');
  points.forEach((p, i) => {
    if (i % labelEvery === 0 || i === points.length - 1) {
      labelsSvg += `<text x="${x(i)}" y="${H - 10}" font-size="9.5" fill="#6C8299" text-anchor="middle" font-family="Inter" transform="rotate(0)">${shortDate(p.d)}</text>`;
    }
  });

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg">
      ${gridSvg}
      <path d="${path}" fill="none" stroke="#3D71A8" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      ${labelsSvg}
    </svg>`;
}

/* Csoportosított oszlopdiagram — hét napja szerint, 2 oszlop naponta
   (jelenlegi vs. viszonyítási alap). */
function renderWeekdayChart(container, curWd, focusWd, focusLabel) {
  container.innerHTML = '';
  const W = container.clientWidth || 560, H = 220;
  const padL = 54, padR = 16, padT = 16, padB = 30;
  const max = Math.max(...curWd.map((w) => w.avgRevenue), ...focusWd.map((w) => w.avgRevenue), 1);
  const groupW = (W - padL - padR) / 7;
  const barW = groupW * 0.32;
  let bars = '';
  let labels = '';
  const order = [1, 2, 3, 4, 5, 6, 0]; // hétfőtől induljon, ne vasárnappal
  order.forEach((wd, gi) => {
    const cur = curWd.find((w) => w.wd === wd);
    const foc = focusWd.find((w) => w.wd === wd);
    const gx = padL + gi * groupW;
    const curH = (H - padT - padB) * (cur.avgRevenue / max);
    const focH = (H - padT - padB) * (foc.avgRevenue / max);
    bars += `<rect x="${(gx + groupW / 2 - barW - 2).toFixed(1)}" y="${(H - padB - curH).toFixed(1)}" width="${barW}" height="${curH.toFixed(1)}" fill="#3D71A8" rx="3"/>`;
    bars += `<rect x="${(gx + groupW / 2 + 2).toFixed(1)}" y="${(H - padB - focH).toFixed(1)}" width="${barW}" height="${focH.toFixed(1)}" fill="#9AA9B8" rx="3"/>`;
    labels += `<text x="${(gx + groupW / 2).toFixed(1)}" y="${H - 10}" font-size="10.5" fill="#6C8299" text-anchor="middle" font-family="Inter">${cur.label.slice(0, 3)}</text>`;
  });
  let gridSvg = '';
  for (let g = 0; g <= 3; g++) {
    const gy = padT + ((H - padT - padB) / 3) * g;
    const val = Math.round(max * (1 - g / 3));
    gridSvg += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#EDF2F8" stroke-width="1"/>`;
    gridSvg += `<text x="${padL - 8}" y="${gy + 4}" font-size="10" fill="#6C8299" text-anchor="end" font-family="IBM Plex Mono">${formatShort(val)}</text>`;
  }
  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg">
      ${gridSvg}${bars}${labels}
    </svg>
    <div class="chart-legend">
      <span><i style="background:#3D71A8;"></i>1. időszak (napi átlag)</span>
      <span><i style="background:#9AA9B8;"></i>${escapeHtml(focusLabel)} (napi átlag)</span>
    </div>`;
}


async function loadRevenueView() {
  const { from, to } = state.range;
  const hint = document.getElementById('group-hint');
  if (state.group === 'hour') {
    hint.hidden = false;
    hint.textContent = `Óránkénti bontás — ${fmtDate(from)} napra.`;
  } else {
    hint.hidden = true;
  }
  try {
    const series = await api(`/api/revenue-series?from=${from}&to=${to}&group=${state.group}`);
    renderLineChart(document.getElementById('revenue-chart'), series.points);
  } catch (e) {
    document.getElementById('revenue-chart').innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`;
  }

  const summary = await api(`/api/summary?from=${from}&to=${to}`);
  const names = { kp: 'Készpénz', 'bankkártya': 'Bankkártya', 'egyéb': 'Egyéb' };
  const tbody = document.querySelector('#fizmod-table tbody');
  tbody.innerHTML = '';
  summary.byFizmod.forEach((r) => {
    const pct = summary.revenue ? Math.round((r.revenue / summary.revenue) * 100) : 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${names[r.fizmod] || r.fizmod}</td><td class="num">${r.cnt}</td><td class="num">${fmtHuf(r.revenue)}</td><td class="num">${pct}%</td>`;
    tbody.appendChild(tr);
  });

  const vat = await api(`/api/vat-breakdown?from=${from}&to=${to}`);
  const vatBody = document.querySelector('#vat-table tbody');
  vatBody.innerHTML = '';
  if (!vat.items.length) vatBody.innerHTML = '<tr><td colspan="4" class="empty-state">Nincs adat.</td></tr>';
  vat.items.forEach((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(r.afakod)}</td><td class="num">${fmtHuf(r.netto)}</td><td class="num">${fmtHuf(r.afa)}</td><td class="num">${fmtHuf(r.brutto)}</td>`;
    vatBody.appendChild(tr);
  });
  makeSortableTable('fizmod-table');
  makeSortableTable('vat-table');
}

/* ============================================================
   Cikk eladások nézet
   ============================================================ */
let productsSearchTimer;
listen('products-search', 'input', (e) => {
  clearTimeout(productsSearchTimer);
  productsSearchTimer = setTimeout(() => {
    state.products.q = e.target.value; state.products.offset = 0; loadProductsView(false);
  }, 300);
});
const productsPaginator = new Paginator({ pageSize: state.products.limit });
let productsSort = { key: 'arbevetel', dir: 'desc' };

async function loadProductsView() {
  const { from, to } = state.range;
  const q = state.products.q;
  productsPaginator.pageSize = state.products.limit;
  const offset = (productsPaginator.page - 1) * productsPaginator.pageSize;
  const data = await api(`/api/products?from=${from}&to=${to}&q=${encodeURIComponent(q)}&limit=${productsPaginator.pageSize}&offset=${offset}&sort=${productsSort.key}&order=${productsSort.dir}`);
  const tbody = document.querySelector('#products-table tbody');
  tbody.innerHTML = '';
  if (!data.items.length) tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Nincs találat.</td></tr>';
  data.items.forEach((it) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(it.nev)}</td><td class="num">${it.mennyiseg} ${escapeHtml(it.me || '')}</td><td class="num">${it.nyugtaszam}</td><td class="num">${fmtHuf(it.arbevetel)}</td>`;
    tbody.appendChild(tr);
  });
  productsPaginator.setTotal(data.total);
  productsPaginator.renderControls(document.getElementById('products-pagination'), () => loadProductsView());
  document.querySelectorAll('#products-table .reg-sortable').forEach((th) => {
    th.querySelector('.sort-arrow')?.remove();
    if (th.dataset.sort === productsSort.key) {
      th.insertAdjacentHTML('beforeend', `<span class="sort-arrow">${productsSort.dir === 'asc' ? '▲' : '▼'}</span>`);
    }
  });
}
document.querySelectorAll('#products-table .reg-sortable').forEach((th) => {
  th.addEventListener('click', () => {
    if (productsSort.key === th.dataset.sort) {
      productsSort.dir = productsSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      productsSort = { key: th.dataset.sort, dir: 'asc' };
    }
    productsPaginator.page = 1;
    loadProductsView();
  });
});

/* ============================================================
   Nyugták nézet
   ============================================================ */
let receiptsSearchTimer;
listen('receipts-search', 'input', (e) => {
  clearTimeout(receiptsSearchTimer);
  receiptsSearchTimer = setTimeout(() => { state.receipts.q = e.target.value; receiptsPaginator.page = 1; loadReceiptsView(false); }, 300);
});
listen('receipts-filter-btn', 'click', () => {
  state.receipts.fizmod = document.getElementById('receipts-fizmod').value;
  state.receipts.min = document.getElementById('receipts-min').value;
  state.receipts.max = document.getElementById('receipts-max').value;
  receiptsPaginator.page = 1;
  loadReceiptsView(false);
});

const receiptsPaginator = new Paginator({ pageSize: state.receipts.limit });
let receiptsSort = { key: 'id', dir: 'desc' };

async function loadReceiptsView() {
  const { from, to } = state.range;
  const { q, fizmod, min, max } = state.receipts;
  receiptsPaginator.pageSize = state.receipts.limit;
  const offset = (receiptsPaginator.page - 1) * receiptsPaginator.pageSize;
  const params = new URLSearchParams({ from, to, q, fizmod, limit: receiptsPaginator.pageSize, offset, sort: receiptsSort.key, order: receiptsSort.dir });
  if (min) params.set('min', min);
  if (max) params.set('max', max);
  const data = await api(`/api/receipts?${params.toString()}`);
  const names = { kp: 'Készpénz', 'bankkártya': 'Bankkártya', 'egyéb': 'Egyéb' };
  const tbody = document.querySelector('#receipts-table tbody');
  tbody.innerHTML = '';
  if (!data.items.length) tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Nincs találat.</td></tr>';
  data.items.forEach((r) => {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.innerHTML = `<td>${escapeHtml(r.bsz)}</td><td>${fmtDate(r.keltdat)}</td><td class="num">${fmtHuf(r.osszeg)}</td><td>${names[r.fizmod] || r.fizmod}</td>`;
    tr.addEventListener('click', () => openReceiptModal(r.bsz));
    tbody.appendChild(tr);
  });
  receiptsPaginator.setTotal(data.total);
  receiptsPaginator.renderControls(document.getElementById('receipts-pagination'), () => loadReceiptsView());
  document.querySelectorAll('#receipts-table .reg-sortable').forEach((th) => {
    th.querySelector('.sort-arrow')?.remove();
    if (th.dataset.sort === receiptsSort.key) {
      th.insertAdjacentHTML('beforeend', `<span class="sort-arrow">${receiptsSort.dir === 'asc' ? '▲' : '▼'}</span>`);
    }
  });
}
document.querySelectorAll('#receipts-table .reg-sortable').forEach((th) => {
  th.addEventListener('click', () => {
    if (receiptsSort.key === th.dataset.sort) {
      receiptsSort.dir = receiptsSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      receiptsSort = { key: th.dataset.sort, dir: 'asc' };
    }
    receiptsPaginator.page = 1;
    loadReceiptsView();
  });
});

async function openReceiptModal(bsz) {
  const data = await api(`/api/receipt?bsz=${encodeURIComponent(bsz)}`);
  const names = { kp: 'Készpénz', 'bankkártya': 'Bankkártya', 'egyéb': 'Egyéb' };
  const content = document.getElementById('receipt-modal-content');
  const total = data.header.bruttokp + data.header.bruttoafr + data.header.bruttokartya;
  content.innerHTML = `
    <h3>${escapeHtml(data.header.bsz)}</h3>
    <div class="receipt-meta">${fmtDate(data.header.keltdat)}${data.header.umdate ? ' · ' + data.header.umdate.slice(11, 16) : ''} · ${names[data.header.fizmod] || data.header.fizmod}</div>
    ${data.items.map((it) => `
      <div class="receipt-line">
        <span>${it.menny} × ${escapeHtml(it.megnevezes)}</span>
        <span>${fmtHuf(it.sorbrutto)}</span>
      </div>`).join('')}
    <div class="receipt-total"><span>Összesen</span><span>${fmtHuf(total)}</span></div>`;
  document.getElementById('receipt-modal-backdrop').hidden = false;
}
listen('receipt-modal-close', 'click', () => { document.getElementById('receipt-modal-backdrop').hidden = true; });
listen('receipt-modal-backdrop', 'click', (e) => { if (e.target.id === 'receipt-modal-backdrop') e.currentTarget.hidden = true; });

/* ============================================================
   NTAK nézet
   ============================================================ */
const NTAK_STATUS_LABELS = {
  TELJESEN_SIKERES: { label: 'Teljesen sikeres', cls: 'ok' },
  RESZBEN_SIKERES: { label: 'Részben sikeres', cls: 'warn' },
  TELJESEN_HIBAS: { label: 'Teljesen hibás', cls: 'error' },
  BEFOGADVA: { label: 'Befogadva', cls: 'pending' },
  ISMERETLEN: { label: 'Ismeretlen', cls: 'pending' },
};
const NTAK_TYPE_LABELS = { 'napi-zaras': 'Napi zárás', 'rendeles-osszesito': 'Rendelés összesítő', 'nyugta-kuldes': 'Nyugta-küldés' };

function ntakStatusBadge(status) {
  const meta = NTAK_STATUS_LABELS[status] || { label: status, cls: 'pending' };
  return `<span class="ntak-badge ${meta.cls}">${escapeHtml(meta.label)}</span>`;
}

async function loadNtakView() {
  const { from, to } = state.range;
  const data = await api(`/api/ntak/summary?from=${from}&to=${to}`);

  const diagCard = document.getElementById('ntak-diag-card');
  const diagContent = document.getElementById('ntak-diag-content');
  const noDataAtAll = !data.submissionsByStatus.length && !data.napzarasok.length && !data.recent.length;
  if (noDataAtAll && data.diag) {
    const d = data.diag;
    const rows = [];
    rows.push(`<b>nyfej</b> (nyugták) tábla: ${d.nyfej ? `${d.nyfej.total} sor, dátumtartomány ${d.nyfej.minDate || '—'} – ${d.nyfej.maxDate || '—'}, ebből ${d.nyfej.vanZarasid} sorban van kitöltve az "ntakzarasid", ${d.nyfej.vanEllenorzott} sorban az "ellenorzott" mező` : '(nem sikerült lekérdezni)'}`);
    rows.push(`<b>ntakrms</b> (küldési napló) tábla: ${d.ntakrms ? `${d.ntakrms.total} sor, dátumtartomány ${d.ntakrms.minDate || '—'} – ${d.ntakrms.maxDate || '—'}` : '(nem sikerült lekérdezni)'}`);
    rows.push(`<b>ntaknapzaras</b> (napi nyitás-zárás) tábla: ${d.ntaknapzaras ? `${d.ntaknapzaras.total} sor, dátumtartomány ${d.ntaknapzaras.minDate || '—'} – ${d.ntaknapzaras.maxDate || '—'}` : '(nem sikerült lekérdezni)'}`);
    if (d.error) rows.push(`<span style="color:var(--brick);">Hiba lekérdezés közben: ${escapeHtml(d.error)}</span>`);
    const ellRange = d.nyfejEllenorzottInRange;
    if (d.ntakrms && d.ntakrms.total > 0 && (d.ntakrms.maxDate < from || d.ntakrms.minDate > to)) {
      rows.push(`<b>→ Van adat, de a kiválasztott időszakon (${from} – ${to}) kívül esik — próbálj más dátumtartományt (pl. "Előző év" helyett "Idén" vagy "Egyedi tartomány").</b>`);
    } else if (ellRange && ellRange.total > 0 && (ellRange.maxDate < from || ellRange.minDate > to)) {
      rows.push(`<b>→ Összesen ${ellRange.total} nyugtán van kitöltve az NTAK-ellenőrzési adat, de mindegyik a(z) ${ellRange.minDate} – ${ellRange.maxDate} tartományba esik, ami kívül van a most kiválasztott időszakon (${from} – ${to}). Próbálj tágabb vagy más dátumtartományt.</b>`);
    } else if ((!d.ntakrms || d.ntakrms.total === 0) && (!d.nyfej || d.nyfej.vanEllenorzott === 0)) {
      rows.push(`<b>→ Ennek a telephelynek egyáltalán nem érkezett még NTAK-adatküldési adat az androidos szinkronon keresztül — ezt androidos oldalon érdemes ellenőrizni.</b>`);
    }
    diagContent.innerHTML = rows.join('<br><br>');
    diagCard.hidden = false;
  } else {
    diagCard.hidden = true;
  }

  const ntakrmsHiba = data.diag && data.diag.error && data.diag.error.includes('no such table: ntakrms');
  const fallbackNote = document.getElementById('ntak-fallback-note');
  fallbackNote.hidden = !data.usedNyfejFallback;
  if (data.usedNyfejFallback) {
    fallbackNote.textContent = 'Ez az androidos alkalmazás-verzió nem vezet külön küldési naplót — az alábbi adatok a nyugták saját, beépített NTAK-küldési mezőiből származnak, ami ugyanolyan megbízható forrás.';
  }
  const statusBox = document.getElementById('ntak-status-summary');
  if (!data.submissionsByStatus.length) {
    statusBox.innerHTML = ntakrmsHiba
      ? '<div class="empty-state">Ez az androidos alkalmazás-verzió nem küld részletes küldési naplót — csak a napi nyitás-zárás eredménye érhető el lent.</div>'
      : '<div class="empty-state">Nincs NTAK adatküldés a kiválasztott időszakban.</div>';
  } else {
    statusBox.innerHTML = data.submissionsByStatus
      .map((r) => `<div class="ntak-summary-item">${ntakStatusBadge(r.ellenorzott)}<span class="ntak-summary-count">${r.cnt}</span></div>`)
      .join('');
  }
  const typeBox = document.getElementById('ntak-type-summary');
  typeBox.innerHTML = data.submissionsByType
    .map((r) => `<div class="ntak-summary-item"><span class="ntak-type-name">${escapeHtml(NTAK_TYPE_LABELS[r.url] || r.url)}</span><span class="ntak-summary-count">${r.cnt}</span></div>`)
    .join('');

  const subTbody = document.querySelector('#ntak-submissions-table tbody');
  subTbody.innerHTML = '';
  if (!data.recent.length) {
    subTbody.innerHTML = ntakrmsHiba
      ? '<tr><td colspan="5" class="empty-state">Ez az androidos alkalmazás-verzió nem küld részletes küldési naplót.</td></tr>'
      : '<tr><td colspan="5" class="empty-state">Nincs adatküldés a kiválasztott időszakban.</td></tr>';
  } else {
    data.recent.forEach((r) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(NTAK_TYPE_LABELS[r.url] || r.url)}</td>
        <td>${fmtDateTime(r.kulddate)}</td>
        <td>${r.elldate ? fmtDateTime(r.elldate) : '—'}</td>
        <td>${ntakStatusBadge(r.ellenorzott || 'ISMERETLEN')}</td>
        <td class="ntak-uuid" title="${escapeHtml(r.uuid || '')}">${escapeHtml((r.uuid || '').slice(0, 8))}…</td>`;
      subTbody.appendChild(tr);
    });
  }

  const napTbody = document.querySelector('#ntak-napzaras-table tbody');
  napTbody.innerHTML = '';
  if (!data.napzarasok.length) {
    napTbody.innerHTML = '<tr><td colspan="6" class="empty-state">Nincs napi nyitás-zárás adat a kiválasztott időszakban.</td></tr>';
  } else {
    data.napzarasok.forEach((r) => {
      const tr = document.createElement('tr');
      const nyitasIdo = r.nyitas ? r.nyitas.slice(11, 16) : '—';
      const zarasIdo = r.zaras ? r.zaras.slice(11, 16) : '—';
      const zarasStatusz = r.zarasStatusz
        ? `${ntakStatusBadge(r.zarasStatusz)}${r.zarasNyugtaSzam ? `<div class="muted" style="font-size:11px;margin-top:3px;">${r.zarasNyugtaSzam} nyugta alapján</div>` : ''}`
        : '<span class="ntak-badge pending">Nincs adatküldés</span>';
      tr.innerHTML = `
        <td>${fmtDate(r.targynap)}</td>
        <td>${nyitasIdo}</td>
        <td>${zarasIdo}</td>
        <td>${escapeHtml(r.naptipus || '—')}</td>
        <td class="num">${fmtHuf(r.borravalo)}</td>
        <td>${zarasStatusz}</td>`;
      napTbody.appendChild(tr);
    });
  }
  makeSortableTable('ntak-submissions-table');
  makeSortableTable('ntak-napzaras-table');
}

/* ============================================================
   Készlet nézet
   ============================================================ */
async function loadStockProductList() {
  if (stockProductsLoaded) return;
  try {
    const data = await api('/api/products/master');
    const list = document.getElementById('stock-cikk-list');
    list.innerHTML = data.items.map((p) => `<option value="${escapeHtml(p.nev)}">`).join('');
    stockProductsLoaded = true;
  } catch (_) { /* nem kritikus, a mező enélkül is szabadon kitölthető */ }
}

function renderStockGroupTiles(groups) {
  const box = document.getElementById('stock-group-tiles');
  const allTile = `<button class="stock-tile ${!stockFilter.csoport ? 'is-active' : ''}" data-csoport="">Összes<span class="stock-tile-count">${groups.reduce((s, g) => s + g.cnt, 0)}</span></button>`;
  const tiles = groups.map((g) => `
    <div class="stock-tile-wrap">
      <button class="stock-tile ${stockFilter.csoport === g.nev ? 'is-active' : ''}" data-csoport="${escapeHtml(g.nev)}">
        ${escapeHtml(g.nev)}<span class="stock-tile-count">${g.cnt}</span>
      </button>
      <input type="number" min="0" class="stock-group-threshold-input" placeholder="riasztás" title="Csoportszintű riasztási küszöb (${escapeHtml(g.nev)})" data-csoport="${escapeHtml(g.nev)}" value="${g.kuszob != null ? g.kuszob : ''}">
    </div>`).join('');
  box.innerHTML = allTile + tiles;
  box.querySelectorAll('.stock-tile').forEach((btn) => {
    btn.addEventListener('click', () => {
      stockFilter.csoport = btn.dataset.csoport;
      stockPaginator.page = 1;
      loadStockView();
    });
  });
  box.querySelectorAll('.stock-group-threshold-input').forEach((inp) => {
    inp.addEventListener('change', () => saveThreshold('csoport', inp.dataset.csoport, inp.value, inp));
  });
}

async function saveThreshold(scope, nev, kuszob, inputEl) {
  try {
    if (kuszob === '' || kuszob == null) {
      await api(`/api/stock/threshold?scope=${scope}&nev=${encodeURIComponent(nev)}`, { method: 'DELETE' });
    } else {
      await api('/api/stock/threshold', { method: 'POST', body: JSON.stringify({ scope, nev, kuszob }) });
    }
    inputEl.classList.add('is-saved');
    setTimeout(() => inputEl.classList.remove('is-saved'), 900);
  } catch (e) {
    alert('Nem sikerült menteni a riasztási küszöböt: ' + e.message);
  }
}

async function loadStockView() {
  const params = new URLSearchParams();
  if (stockFilter.q) params.set('q', stockFilter.q);
  if (stockFilter.csoport) params.set('csoport', stockFilter.csoport);
  const stock = await api(`/api/stock?${params.toString()}`);

  renderStockGroupTiles(stock.groups);

  const tbody = document.querySelector('#stock-table tbody');
  const accList = document.getElementById('stock-acc-list');
  tbody.innerHTML = '';
  accList.innerHTML = '';
  if (!stock.items.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Nincs a szűrésnek megfelelő cikk.</td></tr>';
    accList.innerHTML = '<p class="empty-state">Nincs a szűrésnek megfelelő cikk.</p>';
    document.getElementById('stock-pagination').innerHTML = '';
  } else {
    const pageData = stockPaginator.slice(stock.items);
    pageData.forEach((it) => {
      const tr = document.createElement('tr');
      const keszletCls = it.keszlet < 0 ? 'stock-negative' : '';
      const alacsonyBadge = it.alacsony ? '<span class="ntak-badge warn">Alacsony!</span>' : '';
      tr.innerHTML = `
        <td>${escapeHtml(it.nev)} ${alacsonyBadge}</td>
        <td>${escapeHtml(it.csoportNev)}</td>
        <td class="num">${it.bevetelezve} ${escapeHtml(it.me || '')}</td>
        <td class="num">${it.eladva} ${escapeHtml(it.me || '')}</td>
        <td class="num ${keszletCls}">${it.keszlet} ${escapeHtml(it.me || '')}</td>
        <td>${it.utolsoBevetelezes ? fmtDate(it.utolsoBevetelezes) : '—'}</td>
        <td><input type="number" min="0" class="stock-threshold-input" value="${it.kuszob != null ? it.kuszob : ''}" placeholder="—" data-nev="${escapeHtml(it.nev)}"></td>`;
      tbody.appendChild(tr);

      // Mobil, lenyíló kártyás sor — alapból csak a név és a készlet
      // látszik, minden más adat a kártya kinyitásakor jelenik meg.
      const row = document.createElement('div');
      row.className = 'acc-row';
      row.innerHTML = `
        <button type="button" class="acc-summary">
          <span class="acc-summary-name">${escapeHtml(it.nev)} ${alacsonyBadge}</span>
          <span class="acc-summary-value ${keszletCls}">${it.keszlet} ${escapeHtml(it.me || '')}</span>
          <span class="acc-chevron">▾</span>
        </button>
        <div class="acc-details" hidden>
          <div class="acc-detail-row"><span>Csoport</span><span>${escapeHtml(it.csoportNev)}</span></div>
          <div class="acc-detail-row"><span>Bevételezve</span><span>${it.bevetelezve} ${escapeHtml(it.me || '')}</span></div>
          <div class="acc-detail-row"><span>Eladva</span><span>${it.eladva} ${escapeHtml(it.me || '')}</span></div>
          <div class="acc-detail-row"><span>Utolsó bevételezés</span><span>${it.utolsoBevetelezes ? fmtDate(it.utolsoBevetelezes) : '—'}</span></div>
          <div class="acc-detail-row">
            <span>Riasztási küszöb</span>
            <input type="number" min="0" class="stock-threshold-input" value="${it.kuszob != null ? it.kuszob : ''}" placeholder="—" data-nev="${escapeHtml(it.nev)}">
          </div>
        </div>`;
      accList.appendChild(row);
    });
    document.querySelectorAll('.stock-threshold-input').forEach((inp) => {
      inp.addEventListener('change', () => saveThreshold('cikk', inp.dataset.nev, inp.value, inp));
    });
    accList.querySelectorAll('.acc-summary').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.acc-row');
        const details = row.querySelector('.acc-details');
        const isOpen = row.classList.toggle('is-open');
        details.hidden = !isOpen;
      });
    });
    stockPaginator.renderControls(document.getElementById('stock-pagination'), () => loadStockView());
  }
  makeSortableTable('stock-table');
}

let stockSearchTimer = null;
listen('stock-search-input', 'input', (e) => {
  clearTimeout(stockSearchTimer);
  stockSearchTimer = setTimeout(() => { stockFilter.q = e.target.value.trim(); stockPaginator.page = 1; loadStockView(); }, 300);
});

/* ============================================================
   Bevételezés nézet
   ============================================================ */
async function loadStockReceiptLog() {
  const receipts = await api('/api/stock/receipts?limit=50');
  const logTbody = document.querySelector('#stock-log-table tbody');
  logTbody.innerHTML = '';
  if (!receipts.items.length) {
    logTbody.innerHTML = '<tr><td colspan="7" class="empty-state">Még nincs rögzített bevételezés.</td></tr>';
    return;
  }
  receipts.items.forEach((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtDate(r.datum)}</td>
      <td>${escapeHtml(r.cikkNev)}</td>
      <td class="num">${r.mennyiseg} ${escapeHtml(r.me || '')}</td>
      <td>${escapeHtml(r.szallito || '—')}</td>
      <td>${escapeHtml(r.megjegyzes || '—')}</td>
      <td data-no-sort>${r.szamlaFajl ? `<a href="/api/stock/receipt-file?file=${encodeURIComponent(r.szamlaFajl)}" target="_blank" class="btn-tiny">📎 Számla</a>` : '—'}</td>
      <td><button class="btn-delete-receipt" data-id="${r.id}" title="Törlés">✕</button></td>`;
    logTbody.appendChild(tr);
  });
  logTbody.querySelectorAll('.btn-delete-receipt').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Biztosan törlöd ezt a bevételezést?')) return;
      try {
        await api(`/api/stock/receipt?id=${btn.dataset.id}`, { method: 'DELETE' });
        loadStockReceiptLog();
      } catch (e) { alert('Nem sikerült törölni: ' + e.message); }
    });
  });
  makeSortableTable('stock-log-table');
}

listen('stock-szamla-input', 'change', () => {
  const file = document.getElementById('stock-szamla-input').files[0];
  const preview = document.getElementById('stock-szamla-preview');
  if (!file) { preview.hidden = true; preview.innerHTML = ''; return; }
  if (file.type.startsWith('image/')) {
    const url = URL.createObjectURL(file);
    preview.innerHTML = `<img src="${url}" alt="Számla előnézet">`;
  } else {
    preview.innerHTML = `<span class="stock-szamla-filename">📄 ${escapeHtml(file.name)}</span>`;
  }
  preview.hidden = false;
});

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Nem sikerült beolvasni a fájlt.'));
    reader.readAsDataURL(file);
  });
}

listen('stock-receipt-form', 'submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('stock-add-btn');
  const msg = document.getElementById('stock-form-msg');
  msg.textContent = ''; msg.className = 'stock-form-msg';
  btn.disabled = true; btn.textContent = 'Mentés…';
  try {
    const body = {
      cikkNev: document.getElementById('stock-cikk-input').value.trim(),
      mennyiseg: document.getElementById('stock-mennyiseg-input').value,
      me: document.getElementById('stock-me-input').value,
      beszerzesiAr: document.getElementById('stock-ar-input').value,
      szallito: document.getElementById('stock-szallito-input').value,
      datum: document.getElementById('stock-datum-input').value,
      megjegyzes: document.getElementById('stock-megjegyzes-input').value,
    };
    const szamlaFile = document.getElementById('stock-szamla-input').files[0];
    if (szamlaFile) {
      btn.textContent = 'Fájl feltöltése…';
      body.fajlAdat = await readFileAsBase64(szamlaFile);
      body.fajlNev = szamlaFile.name;
    }
    await api('/api/stock/receipt', { method: 'POST', body: JSON.stringify(body) });
    msg.textContent = '✓ Bevételezés rögzítve.'; msg.className = 'stock-form-msg ok';
    document.getElementById('stock-receipt-form').reset();
    document.getElementById('stock-datum-input').value = todayIso();
    document.getElementById('stock-szamla-preview').hidden = true;
    document.getElementById('stock-szamla-preview').innerHTML = '';
    loadStockReceiptLog();
  } catch (e2) {
    msg.textContent = e2.message; msg.className = 'stock-form-msg error';
  } finally {
    btn.disabled = false; btn.textContent = 'Bevételezés rögzítése';
  }
});

/* ============================================================
   Cikktörzs nézet (kétirányú szinkron)
   ============================================================ */
let masterdataGroupsLoaded = false;
let masterdataEditingOriginal = null; // szerkesztés alatt lévő cikk eredeti neve (ha van)
const masterdataFilter = { q: '' };

async function loadMasterdataGroups() {
  if (masterdataGroupsLoaded) return;
  try {
    const data = await api('/api/products/groups');
    const list = document.getElementById('md-csoport-list');
    list.innerHTML = data.items.map((g) => `<option value="${escapeHtml(g.nev)}">`).join('');
    const select = document.getElementById('bp-csoport-select');
    select.innerHTML = '<option value="">— válassz —</option>' +
      data.items.map((g) => `<option value="${escapeHtml(g.nev)}">${escapeHtml(g.nev)}${g.isNewPending ? ' (még függőben)' : ''}</option>`).join('');
    masterdataGroupsLoaded = true;
  } catch (_) { /* nem kritikus */ }
}

listen('new-group-btn', 'click', async () => {
  const input = document.getElementById('new-group-input');
  const msg = document.getElementById('new-group-msg');
  const nev = input.value.trim();
  msg.textContent = ''; msg.className = 'stock-form-msg';
  if (!nev) { msg.textContent = 'Adj meg egy nevet.'; msg.className = 'stock-form-msg error'; return; }
  try {
    await api('/api/products/group', { method: 'POST', body: JSON.stringify({ megnevezes: nev }) });
    msg.textContent = '✓ Létrehozva (függőben) — a következő szinkronig még nem él.'; msg.className = 'stock-form-msg ok';
    input.value = '';
    masterdataGroupsLoaded = false; // hogy a legördülők/datalist frissüljön az új csoporttal
    loadMasterdataGroups();
  } catch (err) {
    msg.textContent = err.message; msg.className = 'stock-form-msg error';
  }
});

// NTAK hivatalos kategorizálási segédlete alapján (info.ntak.hu) — az
// ÉRTÉKKÓDOKAT (nem a megjelenített neveket) csak azokra a fő- és
// alkategóriákra tudjuk 100%-ig megerősíteni, amik ténylegesen
// előfordultak már szinkronizált, éles adatban (ETEL, ALKMENTESITAL_HELYBEN,
// ALKOHOLOSITAL_HELYBEN + néhány alkategória) — a többinél a legjobb
// következtetésünket adjuk, ugyanazt az elnevezési mintát követve. Emiatt
// van egy "Egyéb (kézi bevitel)" menekülő lehetőség minden szinten — soha
// nem zárunk ki egy valós, helyes NTAK-kódot.
const NTAK_TAXONOMY = {
  ETEL: { label: 'Étel', alkat: {
    REGGELI: 'Reggeli', SZENDVICS: 'Szendvics', ELOETEL: 'Előétel', LEVES: 'Leves',
    FOETEL: 'Főétel', FOETEL_KORETTEL: 'Főétel körettel', KORET_MARTAS: 'Köret, mártások',
    KOSTOLO: 'Kóstolóétel, kóstolófalat', SAVANYUSAG_SALATA: 'Savanyúság / saláta',
    DESSZERT: 'Desszert, sütemény, édesség', PEKARU: 'Péksütemény, pékáru',
    SNACK: 'Snack', ETELCSOMAG: 'Ételcsomag', EGYEB: 'Egyéb',
  } },
  ALKMENTESITAL_HELYBEN: { label: 'Helyben készített alkoholmentes ital', alkat: {
    VIZ: 'Víz', LIMONADE_SZORP: 'Limonádé / szörp / frissen facsart ital',
    ALKMENTES_KOKTEL: 'Alkoholmentes koktél, kevert ital', ITALCSOMAG: 'Italcsomag',
    TEA_FORROCSOKOLADE: 'Tea / forrócsoki és tejalapú italok', KAVE: 'Kávé',
  } },
  ALKMENTESITAL_NEMHELYBEN: { label: 'Nem helyben készített alkoholmentes ital', alkat: {
    VIZ: 'Víz', ROSTOS_UDITO: 'Rostos üdítő', SZENSAVAS_UDITO: 'Szénsavas üdítő',
    SZENSAVMENTES_UDITO: 'Szénsavmentes üdítő', ITALCSOMAG: 'Italcsomag',
  } },
  ALKOHOLOSITAL_HELYBEN: { label: 'Alkoholos ital', alkat: {
    KOKTEL: 'Koktél, kevert ital', LIKOR: 'Likőr', PARLAT: 'Párlat',
    SOR: 'Sör', BOR: 'Bor', PEZSGO: 'Pezsgő', ITALCSOMAG: 'Italcsomag',
  } },
  EGYEB_FOKAT: { label: 'Egyéb', alkat: {
    EGYEB: 'Egyéb', SZERVIZDIJ: 'Szervízdíj', BORRAVALO: 'Borravaló',
    KISZALLITASI_DIJ: 'Kiszállítási díj', KORNYEZETBARAT_CSOMAGOLAS: 'Környezetbarát csomagolás',
    MUANYAG_CSOMAGOLAS: 'Műanyag csomagolás', KEDVEZMENY: 'Kedvezmény', NEM_VENDEGLATAS: 'Nem vendéglátás',
  } },
};
const NTAK_FOKAT_CUSTOM = '_EGYEB_KEZI';
const NTAK_ALKAT_CUSTOM = '_EGYEB_KEZI';

function populateNtakFokatSelect() {
  const sel = document.getElementById('md-ntak-fokat-input');
  sel.innerHTML = '<option value="">— válassz —</option>'
    + Object.entries(NTAK_TAXONOMY).map(([code, def]) => `<option value="${code}">${escapeHtml(def.label)}</option>`).join('')
    + `<option value="${NTAK_FOKAT_CUSTOM}">Egyéb (kézi bevitel)</option>`;
}
function populateNtakAlkatSelect(fokatCode, selectedAlkat) {
  const sel = document.getElementById('md-ntak-alkat-input');
  const customField = document.getElementById('md-ntak-alkat-custom-field');
  const customInput = document.getElementById('md-ntak-alkat-custom-input');
  if (fokatCode === NTAK_FOKAT_CUSTOM) {
    sel.innerHTML = `<option value="${NTAK_ALKAT_CUSTOM}" selected>Egyéb (kézi bevitel)</option>`;
    customField.hidden = false;
    if (selectedAlkat) customInput.value = selectedAlkat;
    return;
  }
  const def = NTAK_TAXONOMY[fokatCode];
  if (!def) {
    sel.innerHTML = '<option value="">— előbb válassz főkategóriát —</option>';
    customField.hidden = true;
    return;
  }
  sel.innerHTML = '<option value="">— válassz —</option>'
    + Object.entries(def.alkat).map(([code, label]) => `<option value="${code}">${escapeHtml(label)}</option>`).join('')
    + `<option value="${NTAK_ALKAT_CUSTOM}">Egyéb (kézi bevitel)</option>`;
  // Ha a betöltött cikk alkategóriája nem szerepel a fenti listában
  // (pl. mert egy más rendszerből érkezett, nem a mi választásunkból),
  // ne veszítsük el az értékét — automatikusan a kézi bevitelre váltunk.
  if (selectedAlkat && !def.alkat[selectedAlkat] && selectedAlkat !== NTAK_ALKAT_CUSTOM) {
    sel.value = NTAK_ALKAT_CUSTOM;
    customField.hidden = false;
    customInput.value = selectedAlkat;
  } else {
    sel.value = selectedAlkat || '';
    customField.hidden = sel.value !== NTAK_ALKAT_CUSTOM;
  }
}
listen('md-ntak-fokat-input', 'change', (e) => {
  document.getElementById('md-ntak-fokat-custom-field').hidden = e.target.value !== NTAK_FOKAT_CUSTOM;
  populateNtakAlkatSelect(e.target.value, '');
});
listen('md-ntak-alkat-input', 'change', (e) => {
  document.getElementById('md-ntak-alkat-custom-field').hidden = e.target.value !== NTAK_ALKAT_CUSTOM;
});
populateNtakFokatSelect();

// Termékfotó — feltöltés/előnézet/törlés. Csak weben tárolt kiegészítő
// adat (lásd a szerver-oldali megjegyzést), NEM megy az androidos szinkronba.
let masterdataPhotoPendingFile = null;
let masterdataPhotoRemoved = false;
listen('md-photo-upload-btn', 'click', () => document.getElementById('md-photo-input').click());
listen('md-photo-input', 'change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  masterdataPhotoPendingFile = file;
  masterdataPhotoRemoved = false;
  const reader = new FileReader();
  reader.onload = () => {
    const img = document.getElementById('md-photo-preview');
    img.src = reader.result;
    img.hidden = false;
    document.getElementById('md-photo-placeholder').hidden = true;
    document.getElementById('md-photo-remove-btn').hidden = false;
  };
  reader.readAsDataURL(file);
});
listen('md-photo-remove-btn', 'click', () => {
  masterdataPhotoPendingFile = null;
  masterdataPhotoRemoved = true;
  document.getElementById('md-photo-preview').hidden = true;
  document.getElementById('md-photo-placeholder').hidden = false;
  document.getElementById('md-photo-remove-btn').hidden = true;
  document.getElementById('md-photo-input').value = '';
});
function resetMasterdataPhoto() {
  masterdataPhotoPendingFile = null;
  masterdataPhotoRemoved = false;
  document.getElementById('md-photo-input').value = '';
  document.getElementById('md-photo-preview').hidden = true;
  document.getElementById('md-photo-placeholder').hidden = false;
  document.getElementById('md-photo-remove-btn').hidden = true;
}

function populateGongyolegSelect(packagingOptions, currentNev, selectedAzon) {
  const sel = document.getElementById('md-gongyoleg-input');
  const options = (packagingOptions || []).filter((p) => p.nev !== currentNev);
  sel.innerHTML = '<option value="">— nincs —</option>'
    + options.map((p) => `<option value="${escapeHtml(p.azon)}">${escapeHtml(p.nev)}</option>`).join('');
  sel.value = selectedAzon || '';
}

function fillMasterdataForm(item) {
  masterdataEditingOriginal = item.nev;
  const nevInput = document.getElementById('md-nev-input');
  nevInput.value = item.nev;
  nevInput.readOnly = true;
  nevInput.title = 'Szerkesztés közben a cikk neve nem módosítható — ez azonosítja a cikket a szinkronban. Átnevezéshez törölni és újra felvenni kell.';
  document.getElementById('md-nev-hint').hidden = false;
  document.getElementById('md-ar-input').value = item.pendingChange ? item.pendingChange.bruttoar : item.bruttoar;
  document.getElementById('md-afa-input').value = item.pendingChange ? item.pendingChange.afakod : item.afakod;
  document.getElementById('md-me-input').value = item.me || '';
  document.getElementById('md-csoport-input').value = (item.pendingChange ? item.pendingChange.csoportNev : item.csoportNev) || '';
  document.getElementById('md-vonalkod-input').value = item.vonalkod || '';
  document.getElementById('md-afakodelv-input').value = (item.pendingChange ? item.pendingChange.afakodelv : item.afakodElviteli) || '';

  const fokatVal = (item.pendingChange ? item.pendingChange.fokatjson : item.fokat) || '';
  const alkatVal = (item.pendingChange ? item.pendingChange.alkatjson : item.alkat) || '';
  const fokatSel = document.getElementById('md-ntak-fokat-input');
  const fokatCustomField = document.getElementById('md-ntak-fokat-custom-field');
  const fokatCustomInput = document.getElementById('md-ntak-fokat-custom-input');
  if (fokatVal && !NTAK_TAXONOMY[fokatVal]) {
    fokatSel.value = NTAK_FOKAT_CUSTOM; // ismeretlen kód — ne vesszen el, kézi bevitelként kezeljük
    fokatCustomField.hidden = false;
    fokatCustomInput.value = fokatVal;
  } else {
    fokatSel.value = fokatVal;
    fokatCustomField.hidden = true;
    fokatCustomInput.value = '';
  }
  populateNtakAlkatSelect(fokatSel.value, alkatVal);

  const ntakSzorzoVal = item.pendingChange ? item.pendingChange.ntakszorzo : item.ntakSzorzo;
  document.getElementById('md-ntak-szorzo-input').value = (ntakSzorzoVal ?? '') === null ? '' : (ntakSzorzoVal ?? '');
  document.getElementById('md-ntak-me-input').value = (item.pendingChange ? item.pendingChange.ntakme : item.ntakMe) || '';

  const gongyolegVal = (item.pendingChange ? item.pendingChange.gongyolegazon : item.gongyolegazon) || '';
  populateGongyolegSelect(masterdataPackagingOptions, item.nev, gongyolegVal);

  resetMasterdataPhoto();
  if (item.kepFajlnev) {
    const img = document.getElementById('md-photo-preview');
    img.src = `/api/products/image?fajlnev=${encodeURIComponent(item.kepFajlnev)}`;
    img.hidden = false;
    document.getElementById('md-photo-placeholder').hidden = true;
    document.getElementById('md-photo-remove-btn').hidden = false;
  }

  document.getElementById('masterdata-form-title').textContent = `Szerkesztés: ${item.nev}`;
  document.getElementById('md-cancel-btn').hidden = false;
  document.getElementById('masterdata-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function resetMasterdataForm() {
  masterdataEditingOriginal = null;
  document.getElementById('masterdata-form').reset();
  const nevInput = document.getElementById('md-nev-input');
  nevInput.readOnly = false;
  nevInput.title = '';
  document.getElementById('md-nev-hint').hidden = true;
  document.getElementById('masterdata-form-title').textContent = 'Új cikk / módosítás';
  document.getElementById('md-cancel-btn').hidden = true;
  document.getElementById('md-ntak-fokat-custom-field').hidden = true;
  populateNtakAlkatSelect('', '');
  populateGongyolegSelect(masterdataPackagingOptions, null, '');
  resetMasterdataPhoto();
}
listen('md-cancel-btn', 'click', resetMasterdataForm);

const masterdataPaginator = new Paginator();
let masterdataSort = { key: 'nev', dir: 'asc' };
let masterdataNtakAktiv = false;
let masterdataPackagingOptions = [];

function applyMasterdataNtakVisibility(ntakAktiv) {
  masterdataNtakAktiv = ntakAktiv;
  document.getElementById('md-ntak-section').hidden = !ntakAktiv;
  document.getElementById('md-ntak-fokat-input').required = ntakAktiv;
  document.getElementById('md-ntak-alkat-input').required = ntakAktiv;
  document.querySelectorAll('#masterdata-table .md-ntak-col').forEach((th) => { th.hidden = !ntakAktiv; });
}

async function loadMasterdataView() {
  loadMasterdataGroups();
  const data = await api('/api/products/master');
  applyMasterdataNtakVisibility(data.ntakAktiv);
  masterdataPackagingOptions = data.packagingOptions || [];
  const q = masterdataFilter.q.toLowerCase();
  let items = q ? data.items.filter((it) => it.nev.toLowerCase().includes(q)) : data.items;

  const { key, dir } = masterdataSort;
  items = [...items].sort((a, b) => {
    const av = a[key] ?? '', bv = b[key] ?? '';
    const cmp = typeof av === 'number' && typeof bv === 'number'
      ? av - bv
      : String(av).localeCompare(String(bv), 'hu', { numeric: true });
    return dir === 'asc' ? cmp : -cmp;
  });

  document.querySelectorAll('#masterdata-table .reg-sortable').forEach((th) => {
    th.querySelector('.sort-arrow')?.remove();
    if (th.dataset.sort === key) {
      th.insertAdjacentHTML('beforeend', `<span class="sort-arrow">${dir === 'asc' ? '▲' : '▼'}</span>`);
    }
  });

  const tbody = document.querySelector('#masterdata-table tbody');
  const accList = document.getElementById('masterdata-acc-list');
  tbody.innerHTML = '';
  accList.innerHTML = '';
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">Nincs a keresésnek megfelelő cikk.</td></tr>';
    accList.innerHTML = '<p class="empty-state">Nincs a keresésnek megfelelő cikk.</p>';
    document.getElementById('masterdata-pagination').innerHTML = '';
  } else {
    const pageData = masterdataPaginator.slice(items);
    pageData.forEach((it) => {
      const tr = document.createElement('tr');
      let statusCell;
      if (it.isNewPending) statusCell = '<span class="ntak-badge pending">Új — függőben</span>';
      else if (it.pendingChange) statusCell = `<span class="ntak-badge warn">Függőben: ${fmtHuf(it.pendingChange.bruttoar)}</span>`;
      else statusCell = '<span class="ntak-badge ok">Élő</span>';
      const ntakColStyle = masterdataNtakAktiv ? '' : ' hidden';
      tr.innerHTML = `
        <td>${escapeHtml(it.nev)}</td>
        <td>${escapeHtml(it.csoportNev)}</td>
        <td class="num">${fmtHuf(it.bruttoar)}</td>
        <td>${escapeHtml(it.afakod)}</td>
        <td>${escapeHtml(it.vonalkod || '—')}</td>
        <td class="md-ntak-col"${ntakColStyle}>${escapeHtml(it.fokat || '—')}</td>
        <td class="md-ntak-col"${ntakColStyle}>${escapeHtml(it.alkat || '—')}</td>
        <td>${statusCell}</td>
        <td><button class="btn-tiny md-edit-btn" data-nev="${escapeHtml(it.nev)}">Szerkesztés</button></td>`;
      tbody.appendChild(tr);
      tr.querySelector('.md-edit-btn').addEventListener('click', () => fillMasterdataForm(it));

      // Mobil, lenyíló kártyás sor — alapból csak a név és az ár látszik.
      const row = document.createElement('div');
      row.className = 'acc-row';
      const ntakDetailRows = masterdataNtakAktiv
        ? `<div class="acc-detail-row"><span>NTAK főkategória</span><span>${escapeHtml(it.fokat || '—')}</span></div>
           <div class="acc-detail-row"><span>NTAK alkategória</span><span>${escapeHtml(it.alkat || '—')}</span></div>`
        : '';
      row.innerHTML = `
        <button type="button" class="acc-summary">
          <span class="acc-summary-name">${escapeHtml(it.nev)}</span>
          <span class="acc-summary-value">${fmtHuf(it.bruttoar)}</span>
          <span class="acc-chevron">▾</span>
        </button>
        <div class="acc-details" hidden>
          <div class="acc-detail-row"><span>Csoport</span><span>${escapeHtml(it.csoportNev)}</span></div>
          <div class="acc-detail-row"><span>ÁFA kód</span><span>${escapeHtml(it.afakod)}</span></div>
          <div class="acc-detail-row"><span>Vonalkód</span><span>${escapeHtml(it.vonalkod || '—')}</span></div>
          ${ntakDetailRows}
          <div class="acc-detail-row"><span>Állapot</span>${statusCell}</div>
          <div class="acc-actions"><button class="btn-tiny acc-md-edit-btn">Szerkesztés</button></div>
        </div>`;
      accList.appendChild(row);
      row.querySelector('.acc-md-edit-btn').addEventListener('click', () => fillMasterdataForm(it));
      row.querySelector('.acc-summary').addEventListener('click', () => {
        const details = row.querySelector('.acc-details');
        const isOpen = row.classList.toggle('is-open');
        details.hidden = !isOpen;
      });
    });
    masterdataPaginator.renderControls(document.getElementById('masterdata-pagination'), () => loadMasterdataView());
  }

  const chTbody = document.querySelector('#masterdata-changes-table tbody');
  chTbody.innerHTML = '';
  const changes = await api('/api/products/changes');
  if (!changes.items.length) {
    chTbody.innerHTML = '<tr><td colspan="5" class="empty-state">Még nincs rögzített módosítás.</td></tr>';
  } else {
    changes.items.slice(0, 100).forEach((c) => {
      const tr = document.createElement('tr');
      const statusBadge = c.status === 'delivered' ? '<span class="ntak-badge ok">Leszinkronizálva</span>' : '<span class="ntak-badge warn">Függőben</span>';
      const sourceLabels = { web_form: 'Kézi szerkesztés', web_bulk_price: 'Tömeges árváltoztatás', excel_import: 'CSV import' };
      tr.innerHTML = `
        <td>${fmtDateTime(c.createdAt)}</td>
        <td>${escapeHtml(c.payload.megnevezes || '—')}</td>
        <td class="num">${c.payload.bruttoar != null ? fmtHuf(c.payload.bruttoar) : '—'}</td>
        <td>${escapeHtml(sourceLabels[c.source] || c.source || '—')}</td>
        <td>${statusBadge}</td>`;
      chTbody.appendChild(tr);
    });
  }
  makeSortableTable('masterdata-changes-table');
}
document.querySelectorAll('#masterdata-table .reg-sortable').forEach((th) => {
  th.addEventListener('click', () => {
    if (masterdataSort.key === th.dataset.sort) {
      masterdataSort.dir = masterdataSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      masterdataSort = { key: th.dataset.sort, dir: 'asc' };
    }
    masterdataPaginator.page = 1;
    loadMasterdataView();
  });
});

let masterdataSearchTimer = null;
listen('masterdata-search-input', 'input', (e) => {
  clearTimeout(masterdataSearchTimer);
  masterdataSearchTimer = setTimeout(() => { masterdataFilter.q = e.target.value.trim(); masterdataPaginator.page = 1; loadMasterdataView(); }, 300);
});

listen('masterdata-form', 'submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('md-save-btn');
  const msg = document.getElementById('masterdata-form-msg');
  msg.textContent = ''; msg.className = 'stock-form-msg';
  const megnevezesValue = document.getElementById('md-nev-input').value.trim();
  if (masterdataEditingOriginal && megnevezesValue !== masterdataEditingOriginal) {
    msg.textContent = 'A cikk neve szerkesztés közben nem térhet el az eredetitől. Töröld a "Mégse" gombbal, és kezdd újra.';
    msg.className = 'stock-form-msg error';
    return;
  }
  btn.disabled = true; btn.textContent = 'Mentés…';
  try {
    const fokatSelVal = document.getElementById('md-ntak-fokat-input').value;
    const fokatFinal = fokatSelVal === NTAK_FOKAT_CUSTOM
      ? document.getElementById('md-ntak-fokat-custom-input').value.trim()
      : fokatSelVal;
    const alkatSelVal = document.getElementById('md-ntak-alkat-input').value;
    const alkatFinal = alkatSelVal === NTAK_ALKAT_CUSTOM
      ? document.getElementById('md-ntak-alkat-custom-input').value.trim()
      : alkatSelVal;
    const body = {
      megnevezes: megnevezesValue,
      originalMegnevezes: masterdataEditingOriginal || undefined,
      bruttoar: document.getElementById('md-ar-input').value,
      afakod: document.getElementById('md-afa-input').value.trim(),
      me: document.getElementById('md-me-input').value.trim(),
      csoportNev: document.getElementById('md-csoport-input').value.trim(),
      vonalkod: document.getElementById('md-vonalkod-input').value.trim(),
      afakodElviteli: document.getElementById('md-afakodelv-input').value.trim(),
      fokat: fokatFinal,
      alkat: alkatFinal,
      ntakSzorzo: document.getElementById('md-ntak-szorzo-input').value.trim(),
      ntakMe: document.getElementById('md-ntak-me-input').value.trim(),
      gongyolegAzon: document.getElementById('md-gongyoleg-input').value,
    };
    await api('/api/products/change', { method: 'POST', body: JSON.stringify(body) });

    // A fotó egy KÜLÖN, csak weben tárolt adat — külön hívással mentjük,
    // hogy egy esetleges hiba itt ne akassza meg a tényleges cikk-mentést.
    try {
      if (masterdataPhotoPendingFile) {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(masterdataPhotoPendingFile);
        });
        await api('/api/products/image', { method: 'POST', body: JSON.stringify({ megnevezes: megnevezesValue, fajlAdat: dataUrl }) });
      } else if (masterdataPhotoRemoved) {
        await api('/api/products/image/delete', { method: 'POST', body: JSON.stringify({ megnevezes: megnevezesValue }) });
      }
    } catch (photoErr) {
      msg.textContent = `✓ A cikk mentve, de a fotóval gond volt: ${photoErr.message}`; msg.className = 'stock-form-msg error';
      resetMasterdataForm();
      loadMasterdataView();
      return;
    }

    msg.textContent = '✓ Mentve — a következő androidos szinkronig "függőben" marad.'; msg.className = 'stock-form-msg ok';
    resetMasterdataForm();
    loadMasterdataView();
  } catch (e2) {
    msg.textContent = e2.message; msg.className = 'stock-form-msg error';
  } finally {
    btn.disabled = false; btn.textContent = 'Mentés (függőbe téve)';
  }
});

listen('bulk-price-form', 'submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('bp-submit-btn');
  const msg = document.getElementById('bulk-price-msg');
  msg.textContent = ''; msg.className = 'stock-form-msg';
  const csoportNev = document.getElementById('bp-csoport-select').value;
  if (!csoportNev) { msg.textContent = 'Válassz csoportot.'; msg.className = 'stock-form-msg error'; return; }
  btn.disabled = true; btn.textContent = 'Alkalmazás…';
  try {
    const body = { mode: document.getElementById('bp-mode-select').value, value: document.getElementById('bp-value-input').value, csoportNev };
    const res = await api('/api/products/bulk-price', { method: 'POST', body: JSON.stringify(body) });
    msg.textContent = `✓ ${res.count} cikk ára módosítva (függőben).`; msg.className = 'stock-form-msg ok';
    loadMasterdataView();
  } catch (e2) {
    msg.textContent = e2.message; msg.className = 'stock-form-msg error';
  } finally {
    btn.disabled = false; btn.textContent = 'Alkalmaz a csoportra';
  }
});

listen('md-import-btn', 'click', () => document.getElementById('md-import-file').click());
listen('md-import-file', 'change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const msg = document.getElementById('md-import-msg');
  msg.textContent = 'Importálás…'; msg.className = 'stock-form-msg';
  try {
    const text = await file.text();
    const res = await fetch('/api/products/import', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'text/csv' }, body: text });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ismeretlen hiba');
    msg.textContent = `✓ ${data.count} cikk importálva (függőben)${data.errors.length ? ` — ${data.errors.length} hibás sor kihagyva` : ''}.`;
    msg.className = 'stock-form-msg ok';
    loadMasterdataView();
  } catch (err) {
    msg.textContent = err.message; msg.className = 'stock-form-msg error';
  } finally {
    e.target.value = '';
  }
});

/* ============================================================
   Szinkronizáció nézet
   ============================================================ */
async function loadSyncView() {
  const box = document.getElementById('sync-status-box');
  try {
    const meta = await api('/api/sync/status');
    box.textContent = meta.lastSync
      ? `Utolsó szinkron: ${fmtDateTime(meta.lastSync)}\nForrás: ${meta.source || 'ismeretlen'}${meta.bytes ? '\nMéret: ' + Math.round(meta.bytes / 1024) + ' KB' : ''}`
      : 'Még nem történt élő szinkronizáció.';
  } catch (_) { box.textContent = 'Nem sikerült lekérni a szinkron állapotát.'; }
}
listen('sync-request-btn', 'click', async () => {
  const out = document.getElementById('sync-request-result');
  out.textContent = 'Kérdezés…';
  try {
    const res = await api('/api/sync/request', { method: 'POST' });
    out.textContent = res.message;
    loadSyncView();
  } catch (e) { out.textContent = 'Hiba: ' + e.message; }
});

/* ============================================================
   Profil nézet — céges adatok, email, telephelyek
   ============================================================ */
async function loadProfilView() {
  try {
    const data = await api('/api/profile');
    document.getElementById('profil-nev').textContent = data.cegNev || '—';
    document.getElementById('profil-adoszam').textContent = data.adoszam || '—';
    document.getElementById('profil-varos').textContent = data.varos || '—';
    document.getElementById('profil-cim').textContent = data.cim || '—';
    document.getElementById('profil-email-input').value = data.email || '';
    renderProfilTelephelyek(data.telephelyek, data.role === 'manager');

    // Az üzletvezető csak a saját telephelyén dolgozhat — nem hozhat létre
    // új telephelyt, és nem hívhat meg senkit (ezt a szerver is kikényszeríti,
    // ez itt csak a felhasználói felület tisztasága kedvéért van elrejtve).
    const isManager = data.role === 'manager';
    document.querySelector('.telephely-new-box').hidden = isManager;
    const inviteManagerCard = document.getElementById('profil-invite-manager-form').closest('.card');
    inviteManagerCard.hidden = isManager;
    if (!isManager) {
      const select = document.getElementById('profil-invite-manager-telephely');
      select.innerHTML = data.telephelyek.map((t) => `<option value="${escapeHtml(t.kod)}">${escapeHtml(t.nev)} (${escapeHtml(t.kod)})</option>`).join('');
    }
    loadProfilDeviceList();
    loadProfilSubscription();
    loadProfilNtakSetting(isManager);
    loadProfilFeatures();
    await loadProfilBillingAddress(isManager);
    document.getElementById('profil-telephely-new-address').innerHTML = navAddressFieldsHtml('profil-telephely-new', {}, navKozteruletJellegekCache);
    wireNavAddressJellegCustom('profil-telephely-new', navKozteruletJellegekCache);
  } catch (e) {
    alert('Nem sikerült betölteni a profilt: ' + e.message);
  }
}

async function loadProfilNtakSetting(isManager) {
  const toggle = document.getElementById('profil-ntak-toggle');
  const desc = document.getElementById('profil-ntak-desc');
  try {
    const data = await api('/api/profile/ntak-setting');
    toggle.checked = data.ntakAktiv;
    updateNtakSettingDesc(data.ntakAktiv);
    toggle.disabled = isManager;
    if (isManager) desc.innerHTML += ' <i>(csak a cégtulajdonos módosíthatja)</i>';
  } catch (e) {
    desc.textContent = 'Nem sikerült betölteni: ' + e.message;
  }
}
function updateNtakSettingDesc(ntakAktiv) {
  const desc = document.getElementById('profil-ntak-desc');
  desc.innerHTML = ntakAktiv
    ? '<b>Bekapcsolva</b> — a Cikktörzsben minden cikknél kötelező megadni az NTAK fő- és alkategóriát.'
    : '<b>Kikapcsolva</b> — a Cikktörzsben nem jelennek meg és nem is kötelezők az NTAK-kategória mezők.';
}
listen('profil-ntak-toggle', 'change', async (e) => {
  const toggle = e.target;
  const newValue = toggle.checked;
  toggle.disabled = true;
  try {
    await api('/api/profile/ntak-setting', { method: 'POST', body: JSON.stringify({ ntakAktiv: newValue }) });
    updateNtakSettingDesc(newValue);
  } catch (err) {
    alert('Nem sikerült menteni: ' + err.message);
    toggle.checked = !newValue;
  } finally {
    toggle.disabled = false;
  }
});

let profilFeaturesCart = new Set(); // kiválasztott, de MÉG NEM fizetett fizetős funkciók
let profilFeaturesDataCache = null;

function updateProfilFeaturesCartBar() {
  const bar = document.getElementById('profil-features-cart-bar');
  const summary = document.getElementById('profil-features-cart-summary');
  if (!profilFeaturesCart.size || !profilFeaturesDataCache) { bar.hidden = true; return; }
  const items = [...profilFeaturesCart].map((key) => profilFeaturesDataCache.features.find((f) => f.key === key)).filter(Boolean);
  const total = items.reduce((s, f) => s + f.alapAr, 0);
  summary.textContent = `${items.length} funkció kiválasztva — ${fmtHuf(total)} / hó`;
  bar.hidden = false;
}

function openDemoPaymentModal() {
  const data = profilFeaturesDataCache;
  const items = [...profilFeaturesCart].map((key) => data.features.find((f) => f.key === key)).filter(Boolean);
  if (!items.length) return;
  document.getElementById('demo-payment-telephely').textContent = `${data.telephelyKod} telephely`;
  document.getElementById('demo-payment-items').innerHTML = items.map((f) => `
    <div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;">
      <span>${escapeHtml(f.nev)}</span><span>${fmtHuf(f.alapAr)} / hó</span>
    </div>`).join('');
  const total = items.reduce((s, f) => s + f.alapAr, 0);
  document.getElementById('demo-payment-total').textContent = `${fmtHuf(total)} / hó`;
  const msg = document.getElementById('demo-payment-msg');
  msg.textContent = '';
  const confirmBtn = document.getElementById('demo-payment-confirm-btn');
  confirmBtn.disabled = false;
  confirmBtn.textContent = 'Demo fizetés megerősítése';
  confirmBtn.onclick = async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Feldolgozás…';
    try {
      const result = await api('/api/payment/demo-pay', { method: 'POST', body: JSON.stringify({ featureKeys: [...profilFeaturesCart] }) });
      profilFeaturesCart.clear();
      document.getElementById('demo-payment-modal-backdrop').hidden = true;
      loadProfilFeatures();
      if (result.emailWarning) {
        alert(`A fizetés sikeres volt, a funkciók aktiválva vannak — de a demo-számla emailt NEM sikerült kiküldeni:\n\n${result.emailWarning}\n\nSzólj az üzemeltetőnek, ha ez rendszeresen előfordul.`);
      }
    } catch (err) {
      msg.textContent = err.message;
      msg.style.color = 'var(--brick)';
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Demo fizetés megerősítése';
    }
  };
  document.getElementById('demo-payment-modal-backdrop').hidden = false;
}
listen('demo-payment-modal-close', 'click', () => {
  document.getElementById('demo-payment-modal-backdrop').hidden = true;
});
listen('demo-payment-modal-backdrop', 'click', (e) => {
  if (e.target.id === 'demo-payment-modal-backdrop') e.target.hidden = true;
});
listen('profil-features-pay-btn', 'click', openDemoPaymentModal);

async function loadProfilFeatures() {
  const list = document.getElementById('profil-features-list');
  const subtitle = document.getElementById('profil-features-subtitle');
  profilFeaturesCart.clear();
  try {
    const data = await api('/api/profile/features');
    profilFeaturesDataCache = data;
    subtitle.textContent = `Válaszd ki, mely funkciókra van szükséged a(z) ${data.telephelyKod} telephelyen — a beállítás csak erre a telephelyre vonatkozik, a többi telephelyed külön állítható.`;
    updateProfilFeaturesCartBar();
    if (!data.features.length) {
      list.innerHTML = '<p class="muted">Jelenleg nincs elérhető funkció a katalógusban.</p>';
      return;
    }
    list.innerHTML = data.features.map((f) => `
      <div class="profil-feature-row ${f.kivalasztva ? 'is-on' : ''}" data-key="${escapeHtml(f.key)}">
        <div>
          <div class="profil-feature-name">${escapeHtml(f.nev)}</div>
          ${f.leiras ? `<div class="profil-feature-desc">${escapeHtml(f.leiras)}</div>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          <span class="profil-feature-price">${f.alapAr ? fmtHuf(f.alapAr) + ' / hó' : 'díjmentes'}</span>
          <input type="checkbox" class="profil-feature-toggle" ${f.kivalasztva ? 'checked' : ''}>
        </div>
      </div>`).join('');
    list.querySelectorAll('.profil-feature-toggle').forEach((cb) => {
      cb.addEventListener('change', async (e) => {
        const row = e.target.closest('.profil-feature-row');
        const key = row.dataset.key;
        const feature = data.features.find((f) => f.key === key);
        const kivalasztva = e.target.checked;

        // Fizetős funkció, ami MÉG NINCS ténylegesen aktiválva — csak a
        // kosárba kerül, nem hív azonnal API-t. A tényleges aktiválás a
        // "Fizetés" gombra kattintva, egy összesítő után történik.
        if (feature.alapAr > 0 && !feature.kivalasztva) {
          if (kivalasztva) profilFeaturesCart.add(key); else profilFeaturesCart.delete(key);
          row.classList.toggle('is-pending', kivalasztva);
          updateProfilFeaturesCartBar();
          return;
        }
        // Már aktív, fizetős funkció KIKAPCSOLÁSA — ez azonnali, nem
        // igényel új fizetést, csak a meglévő előfizetést szünteti meg.
        e.target.disabled = true;
        try {
          await api('/api/profile/features/toggle', { method: 'POST', body: JSON.stringify({ featureKey: key, kivalasztva }) });
          row.classList.toggle('is-on', kivalasztva);
        } catch (err) {
          alert('Nem sikerült menteni: ' + err.message);
          e.target.checked = !kivalasztva;
        } finally {
          e.target.disabled = false;
        }
      });
    });
  } catch (e) {
    list.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

const PAYMENT_STATUS_LABELS = { FUGGOBEN: 'függőben', SIKERES: 'sikeres', SIKERTELEN: 'sikertelen' };

async function loadProfilSubscription() {
  const allapotBox = document.getElementById('profil-fizetes-allapot');
  const box = document.getElementById('profil-fizetes-box');
  const historyBox = document.getElementById('profil-fizetes-tortenetet');
  try {
    const data = await api('/api/profile/subscription');
    allapotBox.innerHTML = data.alapElofizetesAktiv
      ? '<span class="licenc-badge licenc-badge--ok">Aktív előfizetés</span>'
      : `<span class="licenc-badge licenc-badge--expired">Az előfizetés szünetel</span>${data.megjegyzes ? ` · ${escapeHtml(data.megjegyzes)}` : ''}`;

    if (!data.myposElerheto) {
      box.innerHTML = '<p class="muted">A bankkártyás fizetés jelenleg nincs beállítva — keresd az üzemeltetőt, ha előfizetnél.</p>';
    } else {
      let html = '';
      if (data.alapElofizetesAra) {
        html += `<button class="btn-primary profil-fizetes-btn" data-cel="alap_elofizetes" style="margin-bottom:10px;">Alap előfizetés fizetése — ${fmtHuf(data.alapElofizetesAra)}</button><br>`;
      }
      html += data.csomagok.map((c) => `
        <button class="btn-secondary profil-fizetes-btn" data-cel="csomag:${c.id}" style="margin:4px 6px 4px 0;">${escapeHtml(c.nev)} — ${fmtHuf(c.ar)}</button>
      `).join('');
      box.innerHTML = html || '<p class="muted">Jelenleg nincs elérhető, önállóan megvásárolható csomag.</p>';
      box.querySelectorAll('.profil-fizetes-btn').forEach((btn) => {
        btn.addEventListener('click', () => startPayment(btn.dataset.cel, btn));
      });
    }

    historyBox.innerHTML = data.fizetesek.length
      ? `<div class="card-subtitle" style="margin-bottom:6px;">Korábbi fizetések</div>` +
        data.fizetesek.map((p) => `
          <div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;font-size:12.5px;border-bottom:1px solid var(--line);">
            <span>${fmtDate(p.letrehozva.slice(0, 10))} · ${escapeHtml(p.cel)}</span>
            <span>${fmtHuf(p.osszeg)} · ${PAYMENT_STATUS_LABELS[p.allapot] || p.allapot}</span>
          </div>`).join('')
      : '';
  } catch (e) {
    box.innerHTML = `<span class="muted">${escapeHtml(e.message)}</span>`;
  }
}

async function startPayment(cel, btn) {
  btn.disabled = true;
  try {
    const data = await api('/api/payment/start', { method: 'POST', body: JSON.stringify({ cel }) });
    // Automatikusan elküldött, rejtett HTML-űrlap — így irányítjuk át a
    // vásárlót a myPOS hosted fizetési oldalára, pontosan úgy, ahogy a
    // myPOS Checkout API dokumentációja előírja.
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = data.checkoutUrl;
    Object.entries(data.fields).forEach(([k, v]) => {
      const input = document.createElement('input');
      input.type = 'hidden'; input.name = k; input.value = v;
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
  } catch (e) {
    alert('Nem sikerült elindítani a fizetést: ' + e.message);
    btn.disabled = false;
  }
}

async function loadProfilDeviceList() {
  const box = document.getElementById('profil-device-list');
  box.innerHTML = 'Betöltés…';
  try {
    const data = await api('/api/profile/devices');
    if (!data.devices.length) { box.innerHTML = '<span class="muted">Még nincs olyan eszköz, ami ezt a funkciót támogatná a szinkronban.</span>'; return; }
    box.innerHTML = data.devices.map((d) => `
      <div style="padding:8px 0;border-bottom:1px solid var(--line);">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
          <input class="profil-device-nev-input" data-id="${d.id}" value="${escapeHtml(d.nev || '')}" placeholder="egyedi név (pl. 1-es kassza)" style="flex:1 1 160px;padding:7px 9px;border:1.5px solid var(--line);border-radius:6px;font-size:13px;">
          <button class="btn-tiny profil-device-nev-save" data-id="${d.id}">Mentés</button>
          <button class="btn-tiny profil-device-remove" data-id="${d.id}">Eltávolítás</button>
        </div>
        <div class="card-subtitle" style="margin-top:4px;" title="első látott: ${escapeHtml(d.elsoLatott)} · utolsó: ${escapeHtml(d.utolsoLatott)}">
          ${d.telephelyKod ? `Telephely: ${escapeHtml(d.telephelyKod)} · ` : ''}${d.progtip ? escapeHtml(d.progtip) : 'programtípus ismeretlen'}${d.verzio ? ` (v${escapeHtml(d.verzio)})` : ''}
        </div>
      </div>`).join('');
    box.querySelectorAll('.profil-device-nev-save').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const input = box.querySelector(`.profil-device-nev-input[data-id="${btn.dataset.id}"]`);
        try {
          await api('/api/profile/devices/rename', { method: 'POST', body: JSON.stringify({ id: Number(btn.dataset.id), nev: input.value }) });
        } catch (e) { alert('Nem sikerült: ' + e.message); }
      });
    });
    box.querySelectorAll('.profil-device-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Eltávolítod ezt az eszközt a listából?')) return;
        try {
          await api('/api/profile/devices/remove', { method: 'POST', body: JSON.stringify({ id: Number(btn.dataset.id) }) });
          loadProfilDeviceList();
        } catch (e) { alert('Nem sikerült: ' + e.message); }
      });
    });
  } catch (e) {
    box.innerHTML = `<span class="muted">${escapeHtml(e.message)}</span>`;
  }
}

listen('profil-invite-manager-form', 'submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('profil-invite-manager-msg');
  msg.textContent = ''; msg.className = 'profile-form-msg';
  try {
    const telephelyKod = document.getElementById('profil-invite-manager-telephely').value;
    const email = document.getElementById('profil-invite-manager-email').value.trim();
    const res = await api('/api/profile/invite-manager', { method: 'POST', body: JSON.stringify({ telephelyKod, email }) });
    document.getElementById('profil-invite-manager-form').reset();
    msg.textContent = res.emailWarning
      ? `✓ Meghívó létrehozva, de az email küldése nem sikerült (${res.emailWarning}). Küldd el kézzel ezt a linket: ${res.inviteLink}`
      : '✓ Meghívó elküldve.';
    msg.className = res.emailWarning ? 'profile-form-msg error' : 'profile-form-msg ok';
  } catch (e2) {
    msg.textContent = e2.message; msg.className = 'profile-form-msg error';
  }
});

function renderProfilTelephelyek(telephelyek, isManager) {
  const tbody = document.querySelector('#profil-telephelyek-table tbody');
  tbody.innerHTML = telephelyek.map((t) => `
    <tr data-kod="${escapeHtml(t.kod)}">
      <td class="ntak-uuid">${escapeHtml(t.kod)}${t.aktiv ? ' <span class="profile-soon-badge" style="background:var(--jade);color:#fff;">aktív</span>' : ''}</td>
      <td class="profil-telephely-nev-cell">${escapeHtml(t.nev)}</td>
      <td class="profil-telephely-cim-cell">${escapeHtml(t.cim || '—')}</td>
      <td>${t.utolsoSzinkron ? fmtDateTime(t.utolsoSzinkron) : (t.vanAdat ? '—' : 'még nincs adat')}</td>
      <td>${(!isManager || t.aktiv) ? '<button class="btn-tiny btn-profil-telephely-edit">Szerkesztés</button>' : ''}</td>
    </tr>`).join('');

  tbody.querySelectorAll('.btn-profil-telephely-edit').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tr = btn.closest('tr');
      const kod = tr.dataset.kod;
      const t = telephelyek.find((x) => x.kod === kod);
      openTelephelyAddressModal(t);
    });
  });
}

function openTelephelyAddressModal(t) {
  document.getElementById('telephely-address-nev').value = t.nev;
  document.getElementById('telephely-address-fields').innerHTML = navAddressFieldsHtml('telephely-address', t.cimReszletek || {}, navKozteruletJellegekCache);
  wireNavAddressJellegCustom('telephely-address', navKozteruletJellegekCache);
  const msg = document.getElementById('telephely-address-msg');
  msg.textContent = ''; msg.className = 'login-footnote';
  document.getElementById('telephely-address-form').onsubmit = async (e) => {
    e.preventDefault();
    const nev = document.getElementById('telephely-address-nev').value.trim();
    if (!nev) { msg.textContent = 'A telephely neve nem lehet üres.'; msg.style.color = 'var(--brick)'; return; }
    const cim = readNavAddressFields('telephely-address');
    try {
      await api('/api/telephely/update', { method: 'POST', body: JSON.stringify({ kod: t.kod, nev, ...cim }) });
      document.getElementById('telephely-address-modal-backdrop').hidden = true;
      loadProfilView();
    } catch (err) {
      msg.textContent = err.message; msg.style.color = 'var(--brick)';
    }
  };
  document.getElementById('telephely-address-modal-backdrop').hidden = false;
}
listen('telephely-address-modal-close', 'click', () => {
  document.getElementById('telephely-address-modal-backdrop').hidden = true;
});
listen('telephely-address-modal-backdrop', 'click', (e) => {
  if (e.target.id === 'telephely-address-modal-backdrop') e.target.hidden = true;
});

listen('profil-email-form', 'submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('profil-email-msg');
  msg.textContent = ''; msg.className = 'profile-form-msg';
  try {
    await api('/api/profile/email', { method: 'POST', body: JSON.stringify({ email: document.getElementById('profil-email-input').value.trim() }) });
    msg.textContent = '✓ Mentve.'; msg.className = 'profile-form-msg ok';
  } catch (e2) {
    msg.textContent = e2.message; msg.className = 'profile-form-msg error';
  }
});

let navKozteruletJellegekCache = [];

async function loadProfilBillingAddress(isManager) {
  const fieldsBox = document.getElementById('profil-billing-address-fields');
  const saveBtn = document.getElementById('profil-billing-address-save-btn');
  try {
    const data = await api('/api/profile/billing-address');
    navKozteruletJellegekCache = data.kozteruletJellegek || [];
    fieldsBox.innerHTML = navAddressFieldsHtml('profil-billing', data, navKozteruletJellegekCache);
    wireNavAddressJellegCustom('profil-billing', navKozteruletJellegekCache);
    saveBtn.hidden = isManager;
    if (isManager) {
      fieldsBox.querySelectorAll('input, select').forEach((el) => { el.disabled = true; });
    }
  } catch (e) {
    fieldsBox.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}
listen('profil-billing-address-form', 'submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('profil-billing-address-msg');
  msg.textContent = ''; msg.className = 'profile-form-msg';
  try {
    const body = readNavAddressFields('profil-billing');
    await api('/api/profile/billing-address', { method: 'POST', body: JSON.stringify(body) });
    msg.textContent = '✓ Számlázási cím mentve.'; msg.className = 'profile-form-msg ok';
  } catch (e2) {
    msg.textContent = e2.message; msg.className = 'profile-form-msg error';
  }
});


listen('profil-telephely-new-form', 'submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('profil-telephely-new-msg');
  msg.textContent = ''; msg.className = 'profile-form-msg';
  try {
    const kod = document.getElementById('profil-telephely-new-kod').value.trim();
    const nev = document.getElementById('profil-telephely-new-nev').value.trim();
    const cim = readNavAddressFields('profil-telephely-new');
    await api('/api/telephely/create', { method: 'POST', body: JSON.stringify({ kod, nev, ...cim }) });
    document.getElementById('profil-telephely-new-form').reset();
    msg.textContent = '✓ Telephely létrehozva.'; msg.className = 'profile-form-msg ok';
    loadProfilView();
  } catch (e2) {
    msg.textContent = e2.message; msg.className = 'profile-form-msg error';
  }
});
