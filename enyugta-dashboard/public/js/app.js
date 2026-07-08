'use strict';

/* ============================================================
   Segédfüggvények
   ============================================================ */
const fmtHuf = (n) => new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 0 }).format(n || 0) + ' Ft';
const fmtDate = (d) => new Date(d).toLocaleDateString('hu-HU', { year: 'numeric', month: 'short', day: 'numeric' });
const fmtDateTime = (d) => new Date(d).toLocaleString('hu-HU');
const todayIso = () => new Date().toISOString().slice(0, 10);
const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

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

function showLogin() {
  loginScreen.hidden = false;
  appScreen.hidden = true;
  if (state.pollTimer) clearInterval(state.pollTimer);
}
function showApp() {
  loginScreen.hidden = true;
  appScreen.hidden = false;
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');
  err.hidden = true;
  btn.disabled = true; btn.textContent = 'Belépés…';
  try {
    const adoszam = document.getElementById('adoszam-input').value;
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ adoszam }) });
    document.getElementById('company-name').textContent = data.company.nev;
    loggedIn = true;
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
  showLogin();
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
      btn.innerHTML = `<span class="login-hint-nev">${c.nev}</span><span class="login-hint-ado">${c.adoszam}</span>`;
      btn.addEventListener('click', () => {
        document.getElementById('adoszam-input').value = c.adoszam;
        document.getElementById('adoszam-input').focus();
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
   Navigáció / nézetváltás
   ============================================================ */
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    const view = btn.dataset.view;
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
    if (view === 'revenue') loadRevenueView();
    if (view === 'products') loadProductsView(true);
    if (view === 'receipts') loadReceiptsView(true);
    if (view === 'sync') loadSyncView();
  });
});

/* ============================================================
   Dátumtartomány vezérlő
   ============================================================ */
document.querySelectorAll('.range-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.range-chip').forEach((c) => c.classList.remove('is-active'));
    chip.classList.add('is-active');
    const r = chip.dataset.range;
    document.getElementById('range-custom-inputs').hidden = r !== 'custom';
    if (r !== 'custom') {
      state.range = { from: isoDaysAgo(parseInt(r, 10) - 1), to: todayIso(), preset: r };
      refreshAll();
    }
  });
});
document.getElementById('apply-range-btn').addEventListener('click', () => {
  const from = document.getElementById('from-input').value;
  const to = document.getElementById('to-input').value;
  if (from && to) { state.range = { from, to, preset: 'custom' }; refreshAll(); }
});
document.getElementById('refresh-btn').addEventListener('click', () => refreshAll(true));

/* ============================================================
   Boot / élő frissítés
   ============================================================ */
function boot() {
  document.getElementById('from-input').value = state.range.from;
  document.getElementById('to-input').value = state.range.to;
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
  const dots = points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.revenue)}" r="2.6" fill="#4A87C4"><title>${shortDate(p.d)}: ${fmtHuf(p.revenue)}</title></circle>`).join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg">
      ${gridSvg}
      <path d="${area}" fill="rgba(111,168,220,0.16)" stroke="none"/>
      <path d="${path}" fill="none" stroke="#4A87C4" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      ${labelsSvg}
    </svg>`;
}
function shortDate(d) { const dt = new Date(d); return dt.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' }); }
function formatShort(v) { if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M'; if (v >= 1000) return Math.round(v / 1000) + 'e'; return String(v); }

/* ============================================================
   Forgalom nézet
   ============================================================ */
document.querySelectorAll('#group-toggle .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#group-toggle .chip').forEach((c) => c.classList.remove('is-active'));
    chip.classList.add('is-active');
    state.group = chip.dataset.group;
    loadRevenueView();
  });
});

async function loadRevenueView() {
  const { from, to } = state.range;
  const series = await api(`/api/revenue-series?from=${from}&to=${to}&group=${state.group}`);
  renderLineChart(document.getElementById('revenue-chart'), series.points);

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
document.getElementById('sync-request-btn').addEventListener('click', async () => {
  const out = document.getElementById('sync-request-result');
  out.textContent = 'Kérdezés…';
  try {
    const res = await api('/api/sync/request', { method: 'POST' });
    out.textContent = res.message;
    loadSyncView();
  } catch (e) { out.textContent = 'Hiba: ' + e.message; }
});
