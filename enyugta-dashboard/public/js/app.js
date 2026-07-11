'use strict';

/* ============================================================
   Segédfüggvények
   ============================================================ */
const fmtHuf = (n) => new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 0 }).format(n || 0) + ' Ft';
const fmtDate = (d) => new Date(d).toLocaleDateString('hu-HU', { year: 'numeric', month: 'short', day: 'numeric' });
const fmtDateTime = (d) => new Date(d).toLocaleString('hu-HU');
const todayIso = () => new Date().toISOString().slice(0, 10);
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

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
  if (res.status === 401) { showLogin(); throw new Error('NOT_AUTHENTICATED'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ismeretlen hiba');
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
  range: { from: isoDaysAgo(6), to: todayIso(), preset: '7' },
  group: 'day',
  products: { offset: 0, limit: 50, q: '' },
  receipts: { offset: 0, limit: 25, q: '', fizmod: '', min: '', max: '' },
  pollTimer: null,
};

/* ============================================================
   Bejelentkezés
   ============================================================ */
const loginScreen = document.getElementById('login-screen');
const appScreen = document.getElementById('app-screen');
const adminLoginScreen = document.getElementById('admin-login-screen');
const adminScreen = document.getElementById('admin-screen');

function hideAllScreens() {
  loginScreen.hidden = true;
  appScreen.hidden = true;
  adminLoginScreen.hidden = true;
  adminScreen.hidden = true;
  if (state.pollTimer) clearInterval(state.pollTimer);
}
function showLogin() { hideAllScreens(); loginScreen.hidden = false; }
function showApp() { hideAllScreens(); appScreen.hidden = false; document.getElementById('back-to-admin-btn').hidden = !state.viaAdmin; }
function showAdminLogin() { hideAllScreens(); adminLoginScreen.hidden = false; }
function showAdmin() { hideAllScreens(); adminScreen.hidden = false; }

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');
  err.hidden = true;
  btn.disabled = true; btn.textContent = 'Belépés…';
  try {
    const adoszam = document.getElementById('adoszam-input').value;
    const code = document.getElementById('code-input').value;
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ adoszam, code }) });
    document.getElementById('company-name').textContent = data.company.nev;
    loggedIn = true;
    state.viaAdmin = false;
    stockProductsLoaded = false;
    masterdataGroupsLoaded = false;
    ntakSuggestionsLoaded = false;
    showApp();
    boot();
  } catch (e2) {
    err.textContent = e2.message === 'NOT_AUTHENTICATED' ? 'Munkamenet lejárt.' : e2.message;
    err.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = 'Belépés';
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  loggedIn = false;
  state.viaAdmin = false;
  showLogin();
});
document.getElementById('back-to-admin-btn').addEventListener('click', () => {
  showAdmin();
  loadAdminOverview();
  loadAdminActivity();
});

/* ============================================================
   Admin belépés + panel
   ============================================================ */
document.getElementById('show-admin-login').addEventListener('click', (e) => { e.preventDefault(); showAdminLogin(); });
document.getElementById('show-company-login').addEventListener('click', (e) => { e.preventDefault(); showLogin(); });

document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
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

document.getElementById('admin-logout-btn').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

const NTAK_ADMIN_STATUS_LABELS = { TELJESEN_HIBAS: 'Teljesen hibás', RESZBEN_SIKERES: 'Részben sikeres' };

async function loadAdminOverview() {
  const data = await api('/api/admin/overview');

  document.getElementById('admin-kpi-companies').textContent = data.companies.length;
  document.getElementById('admin-kpi-ntak-problems').textContent = data.ntak.reduce((s, n) => s + n.warn + n.error, 0);

  document.getElementById('admin-email-warning').hidden = !!data.emailReady;

  document.getElementById('admin-company-count').textContent = data.companies.length;
  const compTbody = document.querySelector('#admin-companies-table tbody');
  compTbody.innerHTML = '';
  data.companies.forEach((c) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(c.nev)}</td>
      <td class="ntak-uuid">${escapeHtml(c.adoszam)}</td>
      <td>${escapeHtml(c.varos || '—')}</td>
      <td>
        <span class="admin-code" data-key="${escapeHtml(c.key)}">${escapeHtml(c.code || '—')}</span>
        <button class="btn-regen-code" data-key="${escapeHtml(c.key)}" title="Új kód generálása">⟳</button>
      </td>
      <td>
        <div class="admin-email-cell">
          <input type="email" class="admin-email-input" data-key="${escapeHtml(c.key)}" value="${escapeHtml(c.email || '')}" placeholder="cég@email.hu">
          <button class="btn-send-code" data-key="${escapeHtml(c.key)}" ${data.emailReady ? '' : 'disabled'}>Küldés</button>
        </div>
        <div class="admin-email-status" id="admin-email-status-${escapeHtml(c.key)}"></div>
      </td>
      <td>${c.lastSync ? fmtDateTime(c.lastSync) : '—'}</td>
      <td>${escapeHtml(c.source || '—')}</td>
      <td>${c.bytes ? Math.round(c.bytes / 1024) + ' KB' : '—'}</td>
      <td><button class="btn-open-company" data-key="${escapeHtml(c.key)}">Megnyitás</button></td>`;
    compTbody.appendChild(tr);
  });
  compTbody.querySelectorAll('.btn-send-code').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.key;
      const emailInput = compTbody.querySelector(`.admin-email-input[data-key="${key}"]`);
      const status = document.getElementById(`admin-email-status-${key}`);
      const email = emailInput.value.trim();
      if (!email || !email.includes('@')) { status.textContent = 'Adj meg érvényes email címet.'; status.className = 'admin-email-status error'; return; }
      btn.disabled = true; btn.textContent = 'Küldés…';
      status.textContent = ''; status.className = 'admin-email-status';
      try {
        await api('/api/admin/send-code', { method: 'POST', body: JSON.stringify({ companyKey: key, email }) });
        status.textContent = '✓ Elküldve';
        status.className = 'admin-email-status ok';
      } catch (e) {
        status.textContent = e.message;
        status.className = 'admin-email-status error';
      } finally {
        btn.disabled = false; btn.textContent = 'Küldés';
      }
    });
  });
  compTbody.querySelectorAll('.btn-regen-code').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Biztosan új kódot generálsz? A régi kód azonnal érvénytelenné válik.')) return;
      btn.disabled = true;
      try {
        const res = await api('/api/admin/regenerate-code', { method: 'POST', body: JSON.stringify({ companyKey: btn.dataset.key }) });
        document.querySelector(`.admin-code[data-key="${res.companyKey}"]`).textContent = res.code;
      } catch (e) {
        alert('Nem sikerült új kódot generálni: ' + e.message);
      } finally {
        btn.disabled = false;
      }
    });
  });
  compTbody.querySelectorAll('.btn-open-company').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Nyitás…';
      try {
        const data2 = await api('/api/admin/impersonate', { method: 'POST', body: JSON.stringify({ companyKey: btn.dataset.key }) });
        document.getElementById('company-name').textContent = data2.company.nev;
        loggedIn = true;
        state.viaAdmin = true;
        stockProductsLoaded = false;
        masterdataGroupsLoaded = false;
        ntakSuggestionsLoaded = false;
        showApp();
        boot();
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Megnyitás';
        alert('Nem sikerült megnyitni: ' + e.message);
      }
    });
  });

  const ntakTbody = document.querySelector('#admin-ntak-table tbody');
  ntakTbody.innerHTML = '';
  if (!data.ntak.length) {
    ntakTbody.innerHTML = '<tr><td colspan="6" class="empty-state">Egyik cégnek sincs NTAK adata.</td></tr>';
  } else {
    data.ntak.forEach((n) => {
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
  }
}

/* ============================================================
   Tevékenység-napló (admin)
   ============================================================ */
const ACTIVITY_TYPE_LABELS = {
  company_login: 'Céges belépés',
  company_logout: 'Céges kilépés',
  admin_login: 'Admin belépés',
  admin_logout: 'Admin kilépés',
  admin_impersonate: 'Admin: cég megnyitása',
  admin_regen_code: 'Kód újragenerálva',
  admin_send_code: 'Kód kiküldve emailben',
  sync_upload: 'Szinkron feltöltés',
  sync_request: 'Szinkron kérve',
  ntak_setting_change: 'NTAK-beállítás módosítva',
  product_change_add: 'Cikk módosítás rögzítve',
  product_group_add: 'Új termékcsoport',
  product_bulk_price: 'Tömeges árváltoztatás',
  product_import: 'CSV cikktörzs-import',
  stock_receipt_add: 'Bevételezés rögzítve',
  stock_receipt_delete: 'Bevételezés törölve',
  stock_threshold_set: 'Riasztási küszöb beállítva',
  stock_threshold_delete: 'Riasztási küszöb törölve',
};
const activityFilter = { company: '', type: '' };

async function loadAdminActivity() {
  const data = await api('/api/admin/activity');
  document.getElementById('admin-kpi-failed').textContent = data.entries.filter((e) => e.type === 'sync_upload' && !e.ok).length;

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
    return;
  }
  entries.slice(0, 300).forEach((e) => {
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
}

document.getElementById('activity-company-select').addEventListener('change', (e) => {
  activityFilter.company = e.target.value;
  loadAdminActivity();
});

/* IDEIGLENES, TESZT CÉLÚ — a bejelentkező oldalon megmutatja, milyen
   adószámokkal lehet éppen belépni. Töröld ezt a függvényt és a hívását,
   mielőtt nyilvánosan élesítesz (lásd megjegyzés az index.html-ben és a
   server.js /api/auth/companies-hint végpontjánál is). */
async function renderLoginHint() {
  const box = document.getElementById('login-hint');
  const list = document.getElementById('login-hint-list');
  try {
    const data = await apiSilent('/api/auth/companies-hint');
    if (!data.companies || !data.companies.length) return;
    list.innerHTML = '';
    data.companies.forEach((c) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'login-hint-item';
      btn.innerHTML = `<span class="login-hint-nev">${c.nev}</span><span class="login-hint-ado">${c.adoszam} · kód: ${c.code}</span>`;
      btn.addEventListener('click', () => {
        document.getElementById('adoszam-input').value = c.adoszam;
        document.getElementById('code-input').value = c.code;
        document.getElementById('code-input').focus();
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
    box.hidden = false;
  } catch (_) { /* csendben elnyeljük — ez csak egy kényelmi teszt-segédlet */ }
}
renderLoginHint();

/* induláskor: mindig a bejelentkező képernyő jelenjen meg, még akkor is, ha
   a böngészőben van érvényes session-cookie egy korábbi belépésből. A link
   megnyitásakor tehát sosem ugrunk automatikusan a dashboardra — csak a
   ténylegesen beküldött belépési űrlap után. */
let loggedIn = false;
showLogin();

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
document.getElementById('hamburger-btn').addEventListener('click', () => {
  const sidebar = document.getElementById('sidebar');
  if (sidebar.classList.contains('is-open')) closeMobileSidebar(); else openMobileSidebar();
});
document.getElementById('sidebar-overlay').addEventListener('click', closeMobileSidebar);
document.getElementById('sidebar-close-btn').addEventListener('click', closeMobileSidebar);

/* ============================================================
   Navigáció / nézetváltás
   ============================================================ */
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    const view = btn.dataset.view;
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
    document.getElementById('main-topbar').hidden = (view === 'stock' || view === 'stock-receipt' || view === 'masterdata');
    if (view === 'revenue') loadRevenueView();
    if (view === 'products') loadProductsView(true);
    if (view === 'masterdata') loadMasterdataView();
    if (view === 'receipts') loadReceiptsView(true);
    if (view === 'ntak') loadNtakView();
    if (view === 'stock') loadStockView();
    if (view === 'stock-receipt') { loadStockProductList(); loadStockReceiptLog(); }
    if (view === 'sync') loadSyncView();
    closeMobileSidebar(); // mobilon navigáció után zárja a kihúzható menüt
  });
});
document.getElementById('stock-goto-receipt-btn').addEventListener('click', () => {
  document.querySelector('.nav-item[data-view="stock-receipt"]').click();
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
document.getElementById('range-select').addEventListener('change', (e) => {
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
document.getElementById('apply-range-btn').addEventListener('click', () => {
  const from = document.getElementById('from-input').value;
  const to = document.getElementById('to-input').value;
  if (from && to) applyRange({ from, to, preset: 'custom' });
});
document.getElementById('apply-single-day-btn').addEventListener('click', () => {
  const day = document.getElementById('single-day-input').value;
  if (day) applyRange({ from: day, to: day, preset: 'single-day' });
});
document.getElementById('refresh-btn').addEventListener('click', () => refreshAll(true));

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

  const series = await api(`/api/revenue-series?from=${from}&to=${to}&group=day`);
  renderLineChart(document.getElementById('overview-chart'), series.points);

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
  const dots = points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.revenue)}" r="2.6" fill="#3D71A8"><title>${shortDate(p.d)}: ${fmtHuf(p.revenue)}</title></circle>`).join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg">
      ${gridSvg}
      <path d="${area}" fill="rgba(90,147,201,0.18)" stroke="none"/>
      <path d="${path}" fill="none" stroke="#3D71A8" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      ${labelsSvg}
    </svg>`;
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
}

/* ============================================================
   Cikk eladások nézet
   ============================================================ */
let productsSearchTimer;
document.getElementById('products-search').addEventListener('input', (e) => {
  clearTimeout(productsSearchTimer);
  productsSearchTimer = setTimeout(() => {
    state.products.q = e.target.value; state.products.offset = 0; loadProductsView(false);
  }, 300);
});
document.getElementById('products-prev').addEventListener('click', () => { state.products.offset = Math.max(0, state.products.offset - state.products.limit); loadProductsView(false); });
document.getElementById('products-next').addEventListener('click', () => { state.products.offset += state.products.limit; loadProductsView(false); });

async function loadProductsView() {
  const { from, to } = state.range;
  const { q, limit, offset } = state.products;
  const data = await api(`/api/products?from=${from}&to=${to}&q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`);
  const tbody = document.querySelector('#products-table tbody');
  tbody.innerHTML = '';
  if (!data.items.length) tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Nincs találat.</td></tr>';
  data.items.forEach((it) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(it.nev)}</td><td class="num">${it.mennyiseg} ${escapeHtml(it.me || '')}</td><td class="num">${it.nyugtaszam}</td><td class="num">${fmtHuf(it.arbevetel)}</td>`;
    tbody.appendChild(tr);
  });
  document.getElementById('products-count').textContent = `${data.total} termék · ${offset + 1}–${Math.min(offset + limit, data.total)}`;
  document.getElementById('products-prev').disabled = offset === 0;
  document.getElementById('products-next').disabled = offset + limit >= data.total;
}

/* ============================================================
   Nyugták nézet
   ============================================================ */
let receiptsSearchTimer;
document.getElementById('receipts-search').addEventListener('input', (e) => {
  clearTimeout(receiptsSearchTimer);
  receiptsSearchTimer = setTimeout(() => { state.receipts.q = e.target.value; state.receipts.offset = 0; loadReceiptsView(false); }, 300);
});
document.getElementById('receipts-filter-btn').addEventListener('click', () => {
  state.receipts.fizmod = document.getElementById('receipts-fizmod').value;
  state.receipts.min = document.getElementById('receipts-min').value;
  state.receipts.max = document.getElementById('receipts-max').value;
  state.receipts.offset = 0;
  loadReceiptsView(false);
});
document.getElementById('receipts-prev').addEventListener('click', () => { state.receipts.offset = Math.max(0, state.receipts.offset - state.receipts.limit); loadReceiptsView(false); });
document.getElementById('receipts-next').addEventListener('click', () => { state.receipts.offset += state.receipts.limit; loadReceiptsView(false); });

async function loadReceiptsView() {
  const { from, to } = state.range;
  const { q, fizmod, min, max, limit, offset } = state.receipts;
  const params = new URLSearchParams({ from, to, q, fizmod, limit, offset });
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
    tr.innerHTML = `<td>${escapeHtml(r.bsz)}</td><td>${fmtDate(r.keltdat)}</td><td>${names[r.fizmod] || r.fizmod}</td><td class="num">${fmtHuf(r.osszeg)}</td>`;
    tr.addEventListener('click', () => openReceiptModal(r.bsz));
    tbody.appendChild(tr);
  });
  document.getElementById('receipts-count').textContent = `${data.total} nyugta · ${offset + 1}–${Math.min(offset + limit, data.total)}`;
  document.getElementById('receipts-prev').disabled = offset === 0;
  document.getElementById('receipts-next').disabled = offset + limit >= data.total;
}

async function openReceiptModal(bsz) {
  const data = await api(`/api/receipt?bsz=${encodeURIComponent(bsz)}`);
  const names = { kp: 'Készpénz', 'bankkártya': 'Bankkártya', 'egyéb': 'Egyéb' };
  const content = document.getElementById('receipt-modal-content');
  const total = data.header.bruttokp + data.header.bruttoafr + data.header.bruttokartya;
  content.innerHTML = `
    <h3>${escapeHtml(data.header.bsz)}</h3>
    <div class="receipt-meta">${fmtDate(data.header.keltdat)} · ${names[data.header.fizmod] || data.header.fizmod}</div>
    ${data.items.map((it) => `
      <div class="receipt-line">
        <span>${it.menny} × ${escapeHtml(it.megnevezes)}</span>
        <span>${fmtHuf(it.sorbrutto)}</span>
      </div>`).join('')}
    <div class="receipt-total"><span>Összesen</span><span>${fmtHuf(total)}</span></div>`;
  document.getElementById('receipt-modal-backdrop').hidden = false;
}
document.getElementById('receipt-modal-close').addEventListener('click', () => { document.getElementById('receipt-modal-backdrop').hidden = true; });
document.getElementById('receipt-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'receipt-modal-backdrop') e.currentTarget.hidden = true; });

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
const NTAK_TYPE_LABELS = { 'napi-zaras': 'Napi zárás', 'rendeles-osszesito': 'Rendelés összesítő' };

function ntakStatusBadge(status) {
  const meta = NTAK_STATUS_LABELS[status] || { label: status, cls: 'pending' };
  return `<span class="ntak-badge ${meta.cls}">${escapeHtml(meta.label)}</span>`;
}

async function loadNtakView() {
  const { from, to } = state.range;

  try {
    const incomplete = await api('/api/ntak/incomplete-products');
    const card = document.getElementById('ntak-incomplete-card');
    card.hidden = !incomplete.ntakEnabled || !incomplete.items.length;
    if (!card.hidden) {
      const tbody = document.querySelector('#ntak-incomplete-table tbody');
      tbody.innerHTML = incomplete.items.map((it) => `
        <tr>
          <td>${escapeHtml(it.nev)}</td>
          <td>${escapeHtml(it.fokategoria || '—')}</td>
          <td>${escapeHtml(it.alkategoria || '—')}</td>
          <td>${escapeHtml(it.ntakme || '—')}</td>
          <td class="num">${it.ntakszorzo || '—'}</td>
        </tr>`).join('');
    }
  } catch (_) { /* nem kritikus, csak a figyelmeztetés marad el */ }

  const data = await api(`/api/ntak/summary?from=${from}&to=${to}`);

  const statusBox = document.getElementById('ntak-status-summary');
  if (!data.submissionsByStatus.length) {
    statusBox.innerHTML = '<div class="empty-state">Nincs NTAK adatküldés a kiválasztott időszakban.</div>';
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
    subTbody.innerHTML = '<tr><td colspan="5" class="empty-state">Nincs adatküldés a kiválasztott időszakban.</td></tr>';
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
    napTbody.innerHTML = '<tr><td colspan="5" class="empty-state">Nincs napi nyitás-zárás adat a kiválasztott időszakban.</td></tr>';
  } else {
    data.napzarasok.forEach((r) => {
      const tr = document.createElement('tr');
      const nyitasIdo = r.nyitas ? r.nyitas.slice(11, 16) : '—';
      const zarasIdo = r.zaras ? r.zaras.slice(11, 16) : '—';
      tr.innerHTML = `
        <td>${fmtDate(r.targynap)}</td>
        <td>${nyitasIdo}</td>
        <td>${zarasIdo}</td>
        <td>${escapeHtml(r.naptipus || '—')}</td>
        <td class="num">${fmtHuf(r.borravalo)}</td>`;
      napTbody.appendChild(tr);
    });
  }
}

/* ============================================================
   Készlet nézet
   ============================================================ */
let stockProductsLoaded = false;
const stockFilter = { q: '', csoport: '' };

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
  tbody.innerHTML = '';
  if (!stock.items.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Nincs a szűrésnek megfelelő cikk.</td></tr>';
  } else {
    stock.items.forEach((it) => {
      const tr = document.createElement('tr');
      const keszletCls = it.keszlet < 0 ? 'stock-negative' : '';
      tr.innerHTML = `
        <td>${escapeHtml(it.nev)} ${it.alacsony ? '<span class="ntak-badge warn">Alacsony!</span>' : ''}</td>
        <td>${escapeHtml(it.csoportNev)}</td>
        <td class="num">${it.bevetelezve} ${escapeHtml(it.me || '')}</td>
        <td class="num">${it.eladva} ${escapeHtml(it.me || '')}</td>
        <td class="num ${keszletCls}">${it.keszlet} ${escapeHtml(it.me || '')}</td>
        <td>${it.utolsoBevetelezes ? fmtDate(it.utolsoBevetelezes) : '—'}</td>
        <td><input type="number" min="0" class="stock-threshold-input" value="${it.kuszob != null ? it.kuszob : ''}" placeholder="—" data-nev="${escapeHtml(it.nev)}"></td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('.stock-threshold-input').forEach((inp) => {
      inp.addEventListener('change', () => saveThreshold('cikk', inp.dataset.nev, inp.value, inp));
    });
  }
}

let stockSearchTimer = null;
document.getElementById('stock-search-input').addEventListener('input', (e) => {
  clearTimeout(stockSearchTimer);
  stockSearchTimer = setTimeout(() => { stockFilter.q = e.target.value.trim(); loadStockView(); }, 300);
});

/* ============================================================
   Bevételezés nézet
   ============================================================ */
async function loadStockReceiptLog() {
  const receipts = await api('/api/stock/receipts?limit=50');
  const logTbody = document.querySelector('#stock-log-table tbody');
  logTbody.innerHTML = '';
  if (!receipts.items.length) {
    logTbody.innerHTML = '<tr><td colspan="6" class="empty-state">Még nincs rögzített bevételezés.</td></tr>';
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
}

document.getElementById('stock-receipt-form').addEventListener('submit', async (e) => {
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
    await api('/api/stock/receipt', { method: 'POST', body: JSON.stringify(body) });
    msg.textContent = '✓ Bevételezés rögzítve.'; msg.className = 'stock-form-msg ok';
    document.getElementById('stock-receipt-form').reset();
    document.getElementById('stock-datum-input').value = todayIso();
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
let ntakEnabled = false;
let ntakSuggestionsLoaded = false;

async function loadNtakToggleState() {
  try {
    const data = await api('/api/ntak/settings');
    ntakEnabled = data.ntakEnabled;
    document.getElementById('ntak-toggle-checkbox').checked = ntakEnabled;
    document.getElementById('ntak-toggle-hint').hidden = !ntakEnabled;
    document.getElementById('ntak-fields-group').hidden = !ntakEnabled;
    if (ntakEnabled) loadNtakSuggestions();
  } catch (_) { /* nem kritikus */ }
}
async function loadNtakSuggestions() {
  if (ntakSuggestionsLoaded) return;
  try {
    const data = await api('/api/ntak/category-suggestions');
    document.getElementById('ntak-fokategoria-list').innerHTML = data.fokategoriak.map((v) => `<option value="${escapeHtml(v)}">`).join('');
    document.getElementById('ntak-alkategoria-list').innerHTML = data.alkategoriak.map((v) => `<option value="${escapeHtml(v)}">`).join('');
    document.getElementById('ntak-me-list').innerHTML = data.mennyisegiEgysegek.map((v) => `<option value="${escapeHtml(v)}">`).join('');
    ntakSuggestionsLoaded = true;
  } catch (_) { /* nem kritikus */ }
}
document.getElementById('ntak-toggle-checkbox').addEventListener('change', async (e) => {
  const checked = e.target.checked;
  try {
    await api('/api/ntak/settings', { method: 'POST', body: JSON.stringify({ ntakEnabled: checked }) });
    ntakEnabled = checked;
    document.getElementById('ntak-toggle-hint').hidden = !checked;
    document.getElementById('ntak-fields-group').hidden = !checked;
    if (checked) loadNtakSuggestions();
    loadMasterdataView();
  } catch (err) {
    e.target.checked = !checked;
    alert('Nem sikerült menteni: ' + err.message);
  }
});

async function loadMasterdataGroups() {
  if (masterdataGroupsLoaded) return;
  try {
    const data = await api('/api/products/groups');
    const list = document.getElementById('md-csoport-list');
    list.innerHTML = data.items.map((g) => `<option value="${escapeHtml(g.nev)}">`).join('');
    const select = document.getElementById('bp-csoport-select');
    select.innerHTML = '<option value="">— válassz —</option>' + data.items.map((g) => `<option value="${escapeHtml(g.nev)}">${escapeHtml(g.nev)}</option>`).join('');
    masterdataGroupsLoaded = true;
  } catch (_) { /* nem kritikus */ }
}

function fillMasterdataForm(item) {
  masterdataEditingOriginal = item.nev;
  document.getElementById('md-nev-input').value = item.nev;
  document.getElementById('md-ar-input').value = item.pendingChange ? item.pendingChange.bruttoar : item.bruttoar;
  document.getElementById('md-afa-input').value = item.pendingChange ? item.pendingChange.afakod : item.afakod;
  document.getElementById('md-me-input').value = item.me || '';
  document.getElementById('md-csoport-input').value = (item.pendingChange ? item.pendingChange.csoportNev : item.csoportNev) || '';
  document.getElementById('md-vonalkod-input').value = item.vonalkod || '';
  document.getElementById('md-fokategoria-input').value = (item.pendingChange ? item.pendingChange.fokategoria : item.fokategoria) || '';
  document.getElementById('md-alkategoria-input').value = (item.pendingChange ? item.pendingChange.alkategoria : item.alkategoria) || '';
  document.getElementById('md-ntakme-input').value = (item.pendingChange ? item.pendingChange.ntakMe : item.ntakme) || '';
  document.getElementById('md-ntakszorzo-input').value = (item.pendingChange ? item.pendingChange.ntakSzorzo : item.ntakszorzo) || '';
  document.getElementById('md-afakodelv-input').value = (item.pendingChange ? item.pendingChange.afakodElviteli : item.afakodElviteli) || '';
  document.getElementById('masterdata-form-title').textContent = `Szerkesztés: ${item.nev}`;
  document.getElementById('md-cancel-btn').hidden = false;
  document.getElementById('masterdata-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function resetMasterdataForm() {
  masterdataEditingOriginal = null;
  document.getElementById('masterdata-form').reset();
  document.getElementById('masterdata-form-title').textContent = 'Új cikk / módosítás';
  document.getElementById('md-cancel-btn').hidden = true;
}
document.getElementById('md-cancel-btn').addEventListener('click', resetMasterdataForm);

async function loadMasterdataView() {
  loadMasterdataGroups();
  loadNtakToggleState();
  const data = await api('/api/products/master');
  const q = masterdataFilter.q.toLowerCase();
  const items = q ? data.items.filter((it) => it.nev.toLowerCase().includes(q)) : data.items;

  const tbody = document.querySelector('#masterdata-table tbody');
  tbody.innerHTML = '';
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Nincs a keresésnek megfelelő cikk.</td></tr>';
  } else {
    items.forEach((it) => {
      const tr = document.createElement('tr');
      let statusCell;
      if (it.isNewPending) statusCell = '<span class="ntak-badge pending">Új — függőben</span>';
      else if (it.pendingChange) statusCell = `<span class="ntak-badge warn">Függőben: ${fmtHuf(it.pendingChange.bruttoar)}</span>`;
      else statusCell = '<span class="ntak-badge ok">Élő</span>';
      if (it.ntakHianyos) statusCell += ' <span class="ntak-badge error">NTAK hiányos</span>';
      tr.innerHTML = `
        <td>${escapeHtml(it.nev)}</td>
        <td>${escapeHtml(it.csoportNev)}</td>
        <td class="num">${fmtHuf(it.bruttoar)}</td>
        <td>${escapeHtml(it.afakod)}</td>
        <td>${escapeHtml(it.vonalkod || '—')}</td>
        <td>${statusCell}</td>
        <td><button class="btn-tiny md-edit-btn" data-nev="${escapeHtml(it.nev)}">Szerkesztés</button></td>`;
      tbody.appendChild(tr);
      tr.querySelector('.md-edit-btn').addEventListener('click', () => fillMasterdataForm(it));
    });
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
}

let masterdataSearchTimer = null;
document.getElementById('masterdata-search-input').addEventListener('input', (e) => {
  clearTimeout(masterdataSearchTimer);
  masterdataSearchTimer = setTimeout(() => { masterdataFilter.q = e.target.value.trim(); loadMasterdataView(); }, 300);
});

document.getElementById('masterdata-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('md-save-btn');
  const msg = document.getElementById('masterdata-form-msg');
  msg.textContent = ''; msg.className = 'stock-form-msg';
  btn.disabled = true; btn.textContent = 'Mentés…';
  try {
    const body = {
      megnevezes: document.getElementById('md-nev-input').value.trim(),
      bruttoar: document.getElementById('md-ar-input').value,
      afakod: document.getElementById('md-afa-input').value.trim(),
      me: document.getElementById('md-me-input').value.trim(),
      csoportNev: document.getElementById('md-csoport-input').value.trim(),
      vonalkod: document.getElementById('md-vonalkod-input').value.trim(),
      fokategoria: document.getElementById('md-fokategoria-input').value.trim(),
      alkategoria: document.getElementById('md-alkategoria-input').value.trim(),
      ntakMe: document.getElementById('md-ntakme-input').value.trim(),
      ntakSzorzo: document.getElementById('md-ntakszorzo-input').value,
      afakodElviteli: document.getElementById('md-afakodelv-input').value.trim(),
    };
    await api('/api/products/change', { method: 'POST', body: JSON.stringify(body) });
    msg.textContent = '✓ Mentve — a következő androidos szinkronig "függőben" marad.'; msg.className = 'stock-form-msg ok';
    resetMasterdataForm();
    loadMasterdataView();
  } catch (e2) {
    msg.textContent = e2.message; msg.className = 'stock-form-msg error';
  } finally {
    btn.disabled = false; btn.textContent = 'Mentés (függőbe téve)';
  }
});

document.getElementById('bulk-price-form').addEventListener('submit', async (e) => {
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

document.getElementById('md-import-btn').addEventListener('click', () => document.getElementById('md-import-file').click());
document.getElementById('md-import-file').addEventListener('change', async (e) => {
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
    let text = meta.lastSync
      ? `Utolsó szinkron: ${fmtDateTime(meta.lastSync)}\nForrás: ${meta.source || 'ismeretlen'}${meta.bytes ? '\nMéret: ' + Math.round(meta.bytes / 1024) + ' KB' : ''}`
      : 'Még nem történt élő szinkronizáció.';
    if (meta.syncRequested) text += `\n\n⏳ Szinkron-kérés jelezve (${fmtDateTime(meta.syncRequestedAt)}) — az androidos appra vár.`;
    box.textContent = text;
  } catch (_) { box.textContent = 'Nem sikerült lekérni a szinkron állapotát.'; }
}
document.getElementById('sync-request-btn').addEventListener('click', async () => {
  const out = document.getElementById('sync-request-result');
  out.textContent = 'Kérdezés…';
  try {
    const res = await api('/api/sync/request', { method: 'POST' });
    out.textContent = res.message;
    loadSyncView();
  } catch (e) { out.textContent = 'Hiba: ' + e.message; }
});
