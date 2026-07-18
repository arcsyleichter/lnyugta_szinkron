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
  if (res.status === 401) { showLandingScreen(); throw new Error('NOT_AUTHENTICATED'); }
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
const landingScreen = document.getElementById('landing-screen');
const loginScreen = document.getElementById('login-screen');
const telephelyScreen = document.getElementById('telephely-screen');
const telephelyWaitingScreen = document.getElementById('telephely-waiting-screen');
const resellerScreen = document.getElementById('reseller-screen');
const appScreen = document.getElementById('app-screen');
const adminLoginScreen = document.getElementById('admin-login-screen');
const adminScreen = document.getElementById('admin-screen');

function hideAllScreens() {
  landingScreen.hidden = true;
  loginScreen.hidden = true;
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
document.getElementById('admin-mobile-tab-more').addEventListener('click', () => {
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

async function loadLicenseData() {
  await Promise.all([loadLicenseFeatures(), loadLicenseCompanies(), loadLicensePackages()]);
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
document.getElementById('license-package-new-btn').addEventListener('click', () => openLicensePackageModal(null));
document.getElementById('license-package-modal-close').addEventListener('click', () => {
  document.getElementById('license-package-modal-backdrop').hidden = true;
});
document.getElementById('license-package-modal-backdrop').addEventListener('click', (e) => {
  if (e.target.id === 'license-package-modal-backdrop') e.target.hidden = true;
});
document.getElementById('license-package-form').addEventListener('submit', async (e) => {
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
        alert('Nem sikerült törölni: ' + e.message);
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
document.getElementById('license-feature-new-btn').addEventListener('click', () => openLicenseFeatureModal(null));
document.getElementById('license-feature-seed-real-btn').addEventListener('click', async () => {
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
document.getElementById('license-feature-modal-close').addEventListener('click', () => {
  document.getElementById('license-feature-modal-backdrop').hidden = true;
});
document.getElementById('license-feature-modal-backdrop').addEventListener('click', (e) => {
  if (e.target.id === 'license-feature-modal-backdrop') e.target.hidden = true;
});
document.getElementById('license-feature-form').addEventListener('submit', async (e) => {
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
    const kiosztott = c.licenses.filter((l) => l.kiosztva);
    const badges = kiosztott.length
      ? kiosztott.map((l) => `<span class="licenc-badge licenc-badge--${l.allapot}" style="margin:2px 4px 2px 0;">${escapeHtml(l.nev)}</span>`).join('')
      : '<span class="licenc-badge licenc-badge--none">nincs kiosztott funkció</span>';
    const subBadge = c.alapElofizetesAktiv
      ? ''
      : '<span class="licenc-badge licenc-badge--expired" style="margin-right:6px;" title="Az alap havidíj nincs fizetve — minden funkció le van tiltva">⚠ alap regisztráció szünetel</span>';
    const deviceText = c.eszkozLimit != null ? `${c.eszkozSzam} / ${c.eszkozLimit} eszköz` : `${c.eszkozSzam} eszköz (korlátlan)`;
    const deviceFull = c.eszkozLimit != null && c.eszkozSzam >= c.eszkozLimit;
    const deviceBadge = `<span class="licenc-badge licenc-badge--${deviceFull ? 'expired' : 'none'}" style="margin-right:6px;" title="Regisztrált eszközök / korlát">${deviceText}</span>`;
    return `
    <tr data-ceg="${escapeHtml(c.cegKulcs)}">
      <td>${escapeHtml(c.nev)}</td>
      <td class="ntak-uuid">${escapeHtml(c.adoszam)}</td>
      <td>${subBadge}${deviceBadge}${badges}</td>
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
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px solid var(--line);">
        <span title="első látott: ${escapeHtml(d.elsoLatott)} · utolsó: ${escapeHtml(d.utolsoLatott)}">${escapeHtml(d.eszkozAzonosito)}</span>
        <button class="btn-tiny" data-id="${d.id}">Eltávolítás</button>
      </div>`).join('');
    box.querySelectorAll('button[data-id]').forEach((btn) => {
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

function openLicenseGrantModal(c) {
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
  loadLicenseDeviceList(c.cegKulcs);

  const pkgSelect = document.getElementById('license-package-grant-select');
  const activePkgs = licensePackagesCache.filter((p) => p.aktiv);
  pkgSelect.innerHTML = activePkgs.length
    ? activePkgs.map((p) => `<option value="${p.id}">${escapeHtml(p.nev)}${p.ar ? ` (${p.ar.toLocaleString('hu-HU')} Ft)` : ''}</option>`).join('')
    : '<option value="">nincs elérhető csomag</option>';
  document.getElementById('license-package-grant-lejarat').value = '';
  const pkgMsg = document.getElementById('license-package-grant-msg');
  pkgMsg.textContent = '';
  document.getElementById('license-package-grant-btn').onclick = async () => {
    const packageId = Number(pkgSelect.value);
    if (!packageId) return;
    pkgMsg.textContent = 'Kiosztás…'; pkgMsg.style.color = 'var(--text-dim)';
    try {
      const res = await api('/api/admin/license/packages/grant', {
        method: 'POST',
        body: JSON.stringify({ cegKulcs: c.cegKulcs, packageId, lejarat: document.getElementById('license-package-grant-lejarat').value }),
      });
      pkgMsg.textContent = `✓ ${res.featureCount} funkció kiosztva`; pkgMsg.style.color = 'var(--jade-deep)';
      loadLicenseData();
    } catch (e) {
      pkgMsg.textContent = e.message; pkgMsg.style.color = 'var(--brick)';
    }
  };

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
  const list = document.getElementById('license-grant-list');
  list.innerHTML = c.licenses.map((l) => `
    <div class="license-grant-row" data-key="${escapeHtml(l.key)}" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--line);">
      <label style="flex:1 1 220px;display:flex;align-items:center;gap:8px;font-size:13px;">
        <input type="checkbox" class="lg-aktiv" ${l.aktiv ? 'checked' : ''}> ${escapeHtml(l.nev)}
      </label>
      <input type="number" class="lg-ar" min="0" step="100" value="${l.ar != null ? l.ar : l.alapAr}" style="width:100px;padding:6px 8px;border:1.5px solid var(--line);border-radius:6px;" title="Ár (Ft)">
      <input type="date" class="lg-lejarat" value="${l.lejarat || ''}" style="padding:6px 8px;border:1.5px solid var(--line);border-radius:6px;" title="Lejárat (üresen: nincs lejárat)">
      <span class="licenc-badge licenc-badge--${l.allapot}">${escapeHtml(l.allapotSzoveg)}</span>
      <button class="btn-tiny lg-save">Mentés</button>
      ${l.kiosztva ? '<button class="btn-tiny lg-revoke">Visszavonás</button>' : ''}
    </div>`).join('');

  list.querySelectorAll('.license-grant-row').forEach((row) => {
    const featureKey = row.dataset.key;
    row.querySelector('.lg-save').addEventListener('click', async () => {
      try {
        await api('/api/admin/license/grant', {
          method: 'POST',
          body: JSON.stringify({
            cegKulcs: c.cegKulcs,
            featureKey,
            ar: Number(row.querySelector('.lg-ar').value) || 0,
            lejarat: row.querySelector('.lg-lejarat').value || null,
            aktiv: row.querySelector('.lg-aktiv').checked,
          }),
        });
        await loadLicenseCompanies();
        const fresh = licenseCompaniesCache.find((x) => x.cegKulcs === c.cegKulcs);
        openLicenseGrantModal(fresh);
      } catch (e) {
        alert('Nem sikerült menteni: ' + e.message);
      }
    });
    const revokeBtn = row.querySelector('.lg-revoke');
    if (revokeBtn) {
      revokeBtn.addEventListener('click', async () => {
        if (!confirm('Biztosan visszavonod ezt a funkciót ettől a cégtől?')) return;
        try {
          await api('/api/admin/license/revoke', { method: 'POST', body: JSON.stringify({ cegKulcs: c.cegKulcs, featureKey }) });
          await loadLicenseCompanies();
          const fresh = licenseCompaniesCache.find((x) => x.cegKulcs === c.cegKulcs);
          openLicenseGrantModal(fresh);
        } catch (e) {
          alert('Nem sikerült visszavonni: ' + e.message);
        }
      });
    }
  });
  document.getElementById('license-grant-modal-backdrop').hidden = false;
}
document.getElementById('license-grant-modal-close').addEventListener('click', () => {
  document.getElementById('license-grant-modal-backdrop').hidden = true;
});
document.getElementById('license-grant-modal-backdrop').addEventListener('click', (e) => {
  if (e.target.id === 'license-grant-modal-backdrop') e.target.hidden = true;
});

/* ============================================================
   Admin — felhasználó meghívása (viszonteladó / cégtulajdonos / üzletvezető)
   ============================================================ */
/* ============================================================
   Admin — felhasználók listája, csoportosítás, szerkesztés, törlés
   ============================================================ */
let adminUsersCache = [];
let adminUsersGroupMode = 'szerepkor';

async function loadAdminUsers() {
  try {
    const data = await api('/api/admin/users');
    adminUsersCache = data.users;
    document.getElementById('admin-users-count').textContent = data.users.length;
    renderAdminUsers();
  } catch (e) {
    document.getElementById('admin-users-groups').innerHTML = `<p class="muted">Nem sikerült betölteni: ${escapeHtml(e.message)}</p>`;
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
      <td>${escapeHtml(adminUserScopeLabel(u))}</td>
      <td>${escapeHtml(u.invitedBy || '—')}</td>
      <td><span class="licenc-badge licenc-badge--${u.status === 'active' ? 'ok' : u.status === 'pending' ? 'warn' : 'none'}">${ADMIN_STATUS_LABELS[u.status] || u.status}</span></td>
      <td>${fmtDateTime(u.createdAt)}</td>
      <td>
        <button class="btn-tiny btn-admin-user-edit">Szerkesztés</button>
        <button class="btn-tiny btn-admin-user-delete">Törlés</button>
      </td>
    </tr>`;
}

function renderAdminUsers() {
  const container = document.getElementById('admin-users-groups');
  if (!adminUsersCache.length) { container.innerHTML = '<p class="muted">Még nincs egyetlen felhasználó sem.</p>'; return; }

  let groups;
  if (adminUsersGroupMode === 'szerepkor') {
    groups = ['reseller', 'owner', 'manager'].map((role) => ({
      cim: ADMIN_ROLE_LABELS[role],
      users: adminUsersCache.filter((u) => u.role === role),
    })).filter((g) => g.users.length);
  } else {
    const byInviter = new Map();
    for (const u of adminUsersCache) {
      const key = u.invitedBy || '(ismeretlen)';
      if (!byInviter.has(key)) byInviter.set(key, []);
      byInviter.get(key).push(u);
    }
    groups = [...byInviter.entries()].map(([cim, users]) => ({ cim: `Meghívta: ${cim}`, users }));
  }

  container.innerHTML = groups.map((g) => `
    <div class="admin-users-group">
      <div class="admin-users-group-title">${escapeHtml(g.cim)} <span class="profile-soon-badge">${g.users.length}</span></div>
      <table class="data-table">
        <thead><tr><th>Név</th><th>Email</th><th>Hatókör</th><th>Meghívta</th><th>Állapot</th><th>Létrehozva</th><th></th></tr></thead>
        <tbody>${g.users.map(renderAdminUserRow).join('')}</tbody>
      </table>
    </div>`).join('');

  container.querySelectorAll('.btn-admin-user-edit').forEach((btn) => {
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
      document.getElementById('user-edit-modal-backdrop').hidden = false;
    });
  });
  container.querySelectorAll('.btn-admin-user-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.closest('tr').dataset.id);
      const u = adminUsersCache.find((x) => x.id === id);
      if (!confirm(`Biztosan törlöd ezt a felhasználót: ${u.nev} (${u.email})? Ez nem visszavonható.`)) return;
      try {
        await api('/api/admin/users/delete', { method: 'POST', body: JSON.stringify({ id }) });
        loadAdminUsers();
      } catch (e) {
        alert('Nem sikerült törölni: ' + e.message);
      }
    });
  });
}

document.getElementById('admin-users-group-chips').querySelectorAll('.activity-type-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#admin-users-group-chips .activity-type-chip').forEach((c) => c.classList.remove('is-active'));
    chip.classList.add('is-active');
    adminUsersGroupMode = chip.dataset.group;
    renderAdminUsers();
  });
});

document.getElementById('user-edit-modal-close').addEventListener('click', () => {
  document.getElementById('user-edit-modal-backdrop').hidden = true;
});
document.getElementById('user-edit-modal-backdrop').addEventListener('click', (e) => {
  if (e.target.id === 'user-edit-modal-backdrop') e.target.hidden = true;
});
document.getElementById('user-edit-form').addEventListener('submit', async (e) => {
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
document.getElementById('admin-invite-role').addEventListener('change', updateAdminInviteFields);
updateAdminInviteFields();

document.getElementById('admin-invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('admin-invite-msg');
  msg.textContent = ''; msg.className = 'profile-form-msg';
  try {
    const role = document.getElementById('admin-invite-role').value;
    const body = {
      role,
      nev: document.getElementById('admin-invite-nev').value.trim(),
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

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  loggedIn = false;
  state.viaAdmin = false;
  showLandingScreen();
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

/* ============================================================
   Kezdőoldal — 2 csempe
   ============================================================ */
function showLandingScreen() { hideAllScreens(); landingScreen.hidden = false; }
document.getElementById('landing-tile-ugyfel').addEventListener('click', () => showLogin());
document.getElementById('landing-tile-viszontelado').addEventListener('click', () => showResellerLogin());
document.getElementById('back-to-landing-1').addEventListener('click', (e) => { e.preventDefault(); showLandingScreen(); });

document.getElementById('user-login-form').addEventListener('submit', async (e) => {
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
document.getElementById('reseller-back-link').addEventListener('click', (e) => { e.preventDefault(); showLandingScreen(); });

function showResellerDashboard() { hideAllScreens(); resellerScreen.hidden = false; }

async function loadResellerOverview() {
  try {
    const data = await api('/api/reseller/overview');
    document.getElementById('reseller-name').textContent = data.reseller.nev;
    document.getElementById('reseller-company-count').textContent = data.companies.length;
    const tbody = document.querySelector('#reseller-companies-table tbody');
    tbody.innerHTML = data.companies.map((c) => `
      <tr>
        <td>${escapeHtml(c.nev)}</td>
        <td>${escapeHtml(c.telephelyNev || c.telephelyKod)}</td>
        <td class="ntak-uuid">${escapeHtml(c.adoszam)}</td>
        <td>${escapeHtml(c.varos || '—')}</td>
        <td>${c.lastSync ? fmtDateTime(c.lastSync) : '—'}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">Még nincs egyetlen ügyfeled sem.</td></tr>';
  } catch (e) {
    alert('Nem sikerült betölteni: ' + e.message);
  }
}

document.getElementById('reseller-logout-btn').addEventListener('click', async () => {
  await api('/api/auth/reseller-logout', { method: 'POST' }).catch(() => {});
  showResellerLogin();
});

document.getElementById('reseller-invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('reseller-invite-msg');
  msg.textContent = ''; msg.className = 'profile-form-msg';
  try {
    const adoszam = document.getElementById('reseller-invite-adoszam').value.trim();
    const nev = document.getElementById('reseller-invite-nev').value.trim();
    const email = document.getElementById('reseller-invite-email').value.trim();
    const res = await api('/api/reseller/invite-owner', { method: 'POST', body: JSON.stringify({ adoszam, nev, email }) });
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

document.getElementById('reseller-login-form').addEventListener('submit', async (e) => {
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
  const sub = document.getElementById('invite-accept-sub');
  try {
    const info = await api(`/api/invite/info?token=${encodeURIComponent(token)}`);
    sub.textContent = `Szia, ${info.nev}! (${info.roleLabel} jogosultság) — ${info.email}`;
  } catch (e) {
    sub.textContent = e.message;
    document.getElementById('invite-accept-form').hidden = true;
    return true;
  }
  document.getElementById('invite-accept-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('invite-accept-error');
    err.hidden = true;
    const p1 = document.getElementById('invite-password-input').value;
    const p2 = document.getElementById('invite-password-input2').value;
    if (p1 !== p2) { err.textContent = 'A két jelszó nem egyezik.'; err.hidden = false; return; }
    const btn = document.getElementById('invite-accept-btn');
    btn.disabled = true; btn.textContent = 'Mentés…';
    try {
      await api('/api/invite/accept', { method: 'POST', body: JSON.stringify({ token, password: p1 }) });
      document.getElementById('invite-accept-form').hidden = true;
      document.getElementById('invite-accept-success').hidden = false;
    } catch (e2) {
      err.textContent = e2.message; err.hidden = false;
      btn.disabled = false; btn.textContent = 'Fiók aktiválása';
    }
  }, { once: true });
  return true;
}

document.getElementById('show-company-login').addEventListener('click', (e) => { e.preventDefault(); showLandingScreen(); });

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

document.getElementById('telephely-waiting-back-btn').addEventListener('click', () => {
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

document.getElementById('telephely-new-form').addEventListener('submit', async (e) => {
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

document.getElementById('telephely-switch-link').addEventListener('click', (e) => {
  e.preventDefault();
  showTelephelyScreen();
  loadTelephelyPicker();
});

document.getElementById('telephely-logout-link').addEventListener('click', async (e) => {
  e.preventDefault();
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  loggedIn = false;
  showLandingScreen();
});

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
  showLandingScreen();
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
      <td>${escapeHtml(c.telephelyNev || c.telephelyKod || '—')}</td>
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
      <td>
        <select class="admin-reseller-select" data-ceg-kulcs="${escapeHtml(c.cegKulcs)}">
          <option value="">— nincs —</option>
          ${data.resellers.map((r) => `<option value="${r.id}" ${r.id === c.resellerId ? 'selected' : ''}>${escapeHtml(r.nev)}</option>`).join('')}
        </select>
      </td>
      <td>${c.lastSync ? fmtDateTime(c.lastSync) : '—'}</td>
      <td>${escapeHtml(c.source || '—')}</td>
      <td>${c.bytes ? Math.round(c.bytes / 1024) + ' KB' : '—'}</td>
      <td><button class="btn-license-check" data-adoszam="${escapeHtml(c.adoszam)}" title="Adószám vágólapra másolása, majd az lszamla megnyitása">🔗 Licenc</button></td>
      <td>
        <button class="btn-open-company" data-key="${escapeHtml(c.key)}">Megnyitás</button>
        <a class="btn-tiny" href="/api/admin/companies/download-db?key=${encodeURIComponent(c.key)}" title="Legutóbb szinkronizált .db fájl letöltése">⬇ DB</a>
      </td>`;
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
        // res.companyKey a puszta cégkulcs (a kód cég-szinten közös) — az
        // ÖSSZES ehhez a céghez tartozó telephely-sor kódját frissítjük,
        // mert mindegyik ugyanazt a kódot mutatja.
        document.querySelectorAll('.admin-code').forEach((el) => {
          if (el.dataset.key.split(':')[0] === res.companyKey) el.textContent = res.code;
        });
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
        updateTelephelyBadge(data2.company.telephelyNev);
        loggedIn = true;
        state.viaAdmin = true;
        stockProductsLoaded = false;
        showApp();
        boot();
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Megnyitás';
        alert('Nem sikerült megnyitni: ' + e.message);
      }
    });
  });

  // "Licenc" átjáró-gomb — vágólapra másolja az adószámot, majd megnyitja az
  // lszamla rendszert új fülön. Nincs jelszó-tárolás vagy automatikus
  // lekérdezés: az admin a saját, már bejelentkezett munkamenetében nézi meg,
  // csak be kell illesztenie az adószámot a "Név töredék" (vagy hasonló)
  // keresőmezőbe — az lszamla oldal a szűrést POST-kéréssel végzi, ezért
  // közvetlen, előre kitöltött link sajnos nem lehetséges.
  compTbody.querySelectorAll('.btn-license-check').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.adoszam);
        btn.textContent = '✓ Másolva';
        setTimeout(() => { btn.textContent = '🔗 Licenc'; }, 2000);
      } catch (_) { /* ha a vágólap-hozzáférés nem engedélyezett, csendben folytatjuk */ }
      window.open('https://leichter.hu/lszamla/index.php?p=reglistak', '_blank');
    });
  });

  compTbody.querySelectorAll('.admin-reseller-select').forEach((select) => {
    select.addEventListener('change', async () => {
      select.disabled = true;
      try {
        await api('/api/admin/companies/assign-reseller', {
          method: 'POST',
          body: JSON.stringify({ cegKulcs: select.dataset.cegKulcs, resellerId: select.value ? Number(select.value) : null }),
        });
      } catch (e) {
        alert('Nem sikerült menteni: ' + e.message);
        loadAdminOverview(); // állítsuk vissza az eredeti értékre
      } finally {
        select.disabled = false;
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

/* IDEIGLENES, TESZT CÉLÚ — a bejelentkező oldalon megmutatja, milyen teszt-
   fiókokkal lehet éppen belépni. Töröld ezt a függvényt és a hívását,
   mielőtt nyilvánosan élesítesz (lásd megjegyzés az index.html-ben és a
   server.js /api/auth/test-users-hint végpontjánál is). */
async function renderLoginHint() {
  const box = document.getElementById('login-hint');
  const list = document.getElementById('login-hint-list');
  try {
    const data = await apiSilent('/api/auth/test-users-hint');
    if (!data.users || !data.users.length) return;
    list.innerHTML = '';
    data.users.forEach((u) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'login-hint-item';
      const roleLabel = { reseller: 'viszonteladó', owner: 'cégtulajdonos', manager: 'üzletvezető' }[u.role] || u.role;
      btn.innerHTML = `<span class="login-hint-nev">${u.email}</span><span class="login-hint-ado">${roleLabel} · jelszó: ${u.password}</span>`;
      btn.addEventListener('click', () => {
        if (u.role === 'reseller') {
          showResellerLogin();
          document.getElementById('reseller-email-input').value = u.email;
          document.getElementById('reseller-password-input').value = u.password;
        } else {
          showLogin();
          document.getElementById('user-email-input').value = u.email;
          document.getElementById('user-password-input').value = u.password;
        }
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
checkInviteLink().then((wasInvite) => { if (!wasInvite) showLandingScreen(); });

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
document.getElementById('admin-hamburger-btn').addEventListener('click', () => {
  const sidebar = document.getElementById('admin-sidebar');
  if (sidebar.classList.contains('is-open')) closeAdminMobileSidebar(); else openAdminMobileSidebar();
});
document.getElementById('admin-sidebar-overlay').addEventListener('click', closeAdminMobileSidebar);
document.getElementById('admin-sidebar-close-btn').addEventListener('click', closeAdminMobileSidebar);

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
document.getElementById('stock-goto-receipt-btn').addEventListener('click', () => {
  document.querySelector('.nav-item[data-view="stock-receipt"]').click();
});
document.getElementById('stock-reset-btn').addEventListener('click', async () => {
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
document.getElementById('mobile-tab-more').addEventListener('click', () => {
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
document.getElementById('range-pill-more').addEventListener('click', () => {
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
  });
});

// Alapértelmezett vizsgált időszak: utolsó 90 nap — elég hosszú ahhoz, hogy
// minden hét napjából legyen több előfordulás, statisztikailag stabilabb
// átlagot adva, mint egy-két hét.
(function initHoursDefaultRange() {
  const to = todayIso();
  const from = new Date(Date.now() - 89 * 86400000).toISOString().slice(0, 10);
  document.getElementById('hours-to').value = to;
  document.getElementById('hours-from').value = from;
})();

document.getElementById('hours-run-btn').addEventListener('click', async () => {
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

function renderHoursResults(data) {
  hoursAnalysisData = data;
  document.getElementById('hours-global-analysis').textContent = data.globalRecommendation;

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

  const globalMax = Math.max(...data.heatmap.flat(), 1);
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
      const avg = w.hourlyAvg[h] || 0;
      const med = w.hourlyMedian[h] || 0;
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
      const avg = w.hourlyAvg[h] || 0, med = w.hourlyMedian[h] || 0;
      heatmapTip.innerHTML = `<b>${w.label} ${h}:00–${h + 1}:00</b> — átlag: ${fmtHuf(avg)}, medián: ${fmtHuf(med)} (${w.napok} ${w.label.toLowerCase()} alapján)`;
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
  document.getElementById('hours-day-analysis').textContent = w.recommendation || 'Nincs elegendő adat ehhez a naphoz.';
  document.getElementById('hours-day-sub').textContent =
    `Az oszlopok az ÁTLAGOS óránkénti forgalmat mutatják, ${w.napok} db ${w.label.toLowerCase()} alapján; a pont a MEDIÁNT jelzi. Kattints egy oszlopra a pontos értékekért.`;

  const container = document.getElementById('hours-day-chart');
  container.innerHTML = '';
  const oh = w.avgNyitas ? parseInt(w.avgNyitas.slice(0, 2), 10) : null;
  const ch = w.avgZaras ? parseInt(w.avgZaras.slice(0, 2), 10) : null;
  const minH = oh !== null ? Math.max(0, oh - 1) : 6;
  const maxH = ch !== null ? Math.min(23, ch + 1) : 22;
  const hours = [];
  for (let h = minH; h <= maxH; h++) hours.push(h);

  const W = container.clientWidth || 560, H = 240;
  const padL = 58, padR = 16, padT = 20, padB = 32;
  const max = Math.max(...hours.map((h) => Math.max(w.hourlyAvg[h] || 0, w.hourlyMedian[h] || 0)), 1);
  const groupW = (W - padL - padR) / hours.length;
  const barW = groupW * 0.6;
  let bars = '', labels = '', dots = '';
  hours.forEach((h, i) => {
    const avg = w.hourlyAvg[h] || 0;
    const med = w.hourlyMedian[h] || 0;
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
    gridSvg += `<text x="${padL - 8}" y="${gy + 4}" font-size="10" fill="#6C8299" text-anchor="end" font-family="IBM Plex Mono">${formatShort(val)}</text>`;
  }
  const axisLabel = `<text x="${-(H / 2)}" y="14" font-size="10.5" fill="#6C8299" text-anchor="middle" font-family="Inter" transform="rotate(-90)">Átlagos forgalom (Ft)</text>`;
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
      const avg = w.hourlyAvg[h] || 0, med = w.hourlyMedian[h] || 0;
      tooltip.innerHTML = `<strong>${h}:00–${h + 1}:00</strong><br>Átlag: ${fmtHuf(avg)}<br>Medián: ${fmtHuf(med)}<br>${w.napok} nap alapján`;
      const bx = Number(bar.getAttribute('x')) + Number(bar.getAttribute('width')) / 2;
      const by = Number(bar.getAttribute('y'));
      tooltip.style.left = `${(bx / W) * 100}%`;
      tooltip.style.top = `${by}px`;
      tooltip.hidden = false;
    });
  });
  container.addEventListener('click', (e) => { if (!e.target.classList.contains('hours-bar')) tooltip.hidden = true; });
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
document.getElementById('compare-cikk-input').addEventListener('input', () => {
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

document.getElementById('compare-run-btn').addEventListener('click', async () => {
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
  makeSortableTable('products-table');
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
  makeSortableTable('receipts-table');
}

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
    if (d.ntakrms && d.ntakrms.total > 0 && (d.ntakrms.maxDate < from || d.ntakrms.minDate > to)) {
      rows.push(`<b>→ Van adat, de a kiválasztott időszakon (${from} – ${to}) kívül esik — próbálj más dátumtartományt (pl. "Előző év" helyett "Idén" vagy "Egyedi tartomány").</b>`);
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
  makeSortableTable('stock-table');
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
      <td data-no-sort>${r.szamlaFajl ? `<a href="/api/stock/receipt-file?id=${r.id}" target="_blank" class="btn-tiny">📎 Számla</a>` : '—'}</td>
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

document.getElementById('stock-szamla-input').addEventListener('change', () => {
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

document.getElementById('new-group-btn').addEventListener('click', async () => {
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
}
document.getElementById('md-cancel-btn').addEventListener('click', resetMasterdataForm);

async function loadMasterdataView() {
  loadMasterdataGroups();
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
  makeSortableTable('masterdata-table');
  makeSortableTable('masterdata-changes-table');
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
  const megnevezesValue = document.getElementById('md-nev-input').value.trim();
  if (masterdataEditingOriginal && megnevezesValue !== masterdataEditingOriginal) {
    msg.textContent = 'A cikk neve szerkesztés közben nem térhet el az eredetitől. Töröld a "Mégse" gombbal, és kezdd újra.';
    msg.className = 'stock-form-msg error';
    return;
  }
  btn.disabled = true; btn.textContent = 'Mentés…';
  try {
    const body = {
      megnevezes: megnevezesValue,
      bruttoar: document.getElementById('md-ar-input').value,
      afakod: document.getElementById('md-afa-input').value.trim(),
      me: document.getElementById('md-me-input').value.trim(),
      csoportNev: document.getElementById('md-csoport-input').value.trim(),
      vonalkod: document.getElementById('md-vonalkod-input').value.trim(),
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
  } catch (e) {
    alert('Nem sikerült betölteni a profilt: ' + e.message);
  }
}

document.getElementById('profil-invite-manager-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('profil-invite-manager-msg');
  msg.textContent = ''; msg.className = 'profile-form-msg';
  try {
    const telephelyKod = document.getElementById('profil-invite-manager-telephely').value;
    const nev = document.getElementById('profil-invite-manager-nev').value.trim();
    const email = document.getElementById('profil-invite-manager-email').value.trim();
    const res = await api('/api/profile/invite-manager', { method: 'POST', body: JSON.stringify({ telephelyKod, nev, email }) });
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
      const nevCell = tr.querySelector('.profil-telephely-nev-cell');
      const cimCell = tr.querySelector('.profil-telephely-cim-cell');
      const currentNev = nevCell.textContent;
      const currentCim = cimCell.textContent === '—' ? '' : cimCell.textContent;
      nevCell.innerHTML = `<input type="text" class="profil-telephely-edit-nev" value="${escapeHtml(currentNev)}" style="width:100%;">`;
      cimCell.innerHTML = `<input type="text" class="profil-telephely-edit-cim" value="${escapeHtml(currentCim)}" style="width:100%;">`;
      btn.textContent = 'Mentés';
      btn.classList.add('btn-profil-telephely-save');
      btn.classList.remove('btn-profil-telephely-edit');
      btn.onclick = async () => {
        const nev = tr.querySelector('.profil-telephely-edit-nev').value.trim();
        const cim = tr.querySelector('.profil-telephely-edit-cim').value.trim();
        if (!nev) { alert('A telephely neve nem lehet üres.'); return; }
        btn.disabled = true;
        try {
          await api('/api/telephely/update', { method: 'POST', body: JSON.stringify({ kod, nev, cim }) });
          loadProfilView();
        } catch (e) {
          alert('Nem sikerült menteni: ' + e.message);
          btn.disabled = false;
        }
      };
    });
  });
}

document.getElementById('profil-email-form').addEventListener('submit', async (e) => {
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

document.getElementById('profil-telephely-new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('profil-telephely-new-msg');
  msg.textContent = ''; msg.className = 'profile-form-msg';
  try {
    const kod = document.getElementById('profil-telephely-new-kod').value.trim();
    const nev = document.getElementById('profil-telephely-new-nev').value.trim();
    const cim = document.getElementById('profil-telephely-new-cim').value.trim();
    await api('/api/telephely/create', { method: 'POST', body: JSON.stringify({ kod, nev, cim }) });
    document.getElementById('profil-telephely-new-form').reset();
    msg.textContent = '✓ Telephely létrehozva.'; msg.className = 'profile-form-msg ok';
    loadProfilView();
  } catch (e2) {
    msg.textContent = e2.message; msg.className = 'profile-form-msg error';
  }
});
