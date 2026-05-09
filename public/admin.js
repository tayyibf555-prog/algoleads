/* ──────────────────────────────────────────────────────────────
   AUTH GATE — before anything else runs, check sessionStorage
   for credentials and verify them. If invalid or missing, show
   the login overlay and stop. Once verified, `_authHeader` is
   set and api() uses it for every request.
   ────────────────────────────────────────────────────────────── */
const AUTH_STORAGE_KEY = 'algoAdmin.auth';
let _authHeader = null;

function _setAuth(user, pass) {
  _authHeader = 'Basic ' + btoa(user + ':' + pass);
  try { sessionStorage.setItem(AUTH_STORAGE_KEY, _authHeader); } catch (e) {}
}
function _loadAuth() {
  try { _authHeader = sessionStorage.getItem(AUTH_STORAGE_KEY) || null; } catch (e) {}
  return _authHeader;
}
function _clearAuth() {
  _authHeader = null;
  try { sessionStorage.removeItem(AUTH_STORAGE_KEY); } catch (e) {}
}

async function _probeAuth(headerValue) {
  const res = await fetch('/api/stats', {
    headers: { 'Accept': 'application/json', 'Authorization': headerValue }
  });
  return res.ok;
}

function _showLogin(errorText) {
  const screen = document.getElementById('loginScreen');
  const err = document.getElementById('loginError');
  if (screen) screen.setAttribute('aria-hidden', 'false');
  document.body.classList.add('locked');
  if (err) err.textContent = errorText || '';
  const u = document.getElementById('loginUser');
  if (u) setTimeout(() => u.focus(), 30);
}
function _hideLogin() {
  const screen = document.getElementById('loginScreen');
  if (screen) screen.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('locked');
}

// Wire the login form
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('loginForm');
  const submit = document.getElementById('loginSubmit');
  const err = document.getElementById('loginError');

  if (form) form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (err) err.textContent = '';
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    const u = document.getElementById('loginUser').value.trim();
    const p = document.getElementById('loginPass').value;
    const candidate = 'Basic ' + btoa(u + ':' + p);
    try {
      const ok = await _probeAuth(candidate);
      if (ok) {
        _setAuth(u, p);
        _hideLogin();
        // Boot the admin
        if (typeof setTab === 'function') {
          const initial = (location.hash || '#overview').replace('#', '');
          const valid = ['overview', 'leads', 'payments', 'bookings', 'members', 'announcements'];
          setTab(valid.indexOf(initial) >= 0 ? initial : 'overview');
        }
      } else {
        if (err) err.textContent = 'Invalid username or password.';
      }
    } catch (e) {
      if (err) err.textContent = 'Network error — try again.';
    } finally {
      submit.disabled = false;
      submit.textContent = 'Sign in →';
    }
  });

  // Sign-out button in topbar
  const signout = document.getElementById('signoutBtn');
  if (signout) signout.addEventListener('click', () => {
    _clearAuth();
    location.reload();
  });

  // Make Export CSV pass auth via blob download (Authorization
  // can't be set on a plain <a download> link — fetch + blob it)
  const exportLink = document.getElementById('exportLink');
  if (exportLink) exportLink.addEventListener('click', async (ev) => {
    ev.preventDefault();
    try {
      const res = await fetch('/api/export.csv', {
        headers: { 'Authorization': _authHeader || '' }
      });
      if (!res.ok) throw new Error(res.status + '');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'leads-' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Export failed', e);
    }
  });
});

// Probe stored creds on page load. If valid, hide the login screen
// and let the existing bootstrap run. If not, show the login.
(async () => {
  const stored = _loadAuth();
  if (stored && (await _probeAuth(stored).catch(() => false))) {
    _hideLogin();
    // Existing bootstrap runs at the bottom of admin.js
  } else {
    _clearAuth();
    _showLogin('');
  }
})();

/* Algo Admin · single-file vanilla JS
   ───────────────────────────────────
   - Tab routing (Overview / Leads / Payments / Bookings)
   - Stats + funnel rendering
   - Leads table with filter / search / sort + drawer detail
   - Payments + bookings tables
   - Drawer: status updates, notes, timeline, lead-data export, delete
   - Click-to-copy helpers, toast notifications

   All dynamic strings inserted into the DOM are escaped via
   fmt.esc() before interpolation. The data comes from a server
   we control, but we still treat it as untrusted (e.g. notes /
   names / emails could contain HTML-like characters).
*/

const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

const fmt = {
  date: ts => {
    if (!ts) return '—';
    const d = new Date(typeof ts === 'string' ? ts : Number(ts));
    if (isNaN(d.getTime())) return '—';
    const sameDay = d.toDateString() === new Date().toDateString();
    if (sameDay) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' · ' +
           d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  },
  ago: ts => {
    if (!ts) return '—';
    const diff = Date.now() - Number(ts);
    const mins = Math.floor(diff / 60000);
    if (mins < 1)   return 'just now';
    if (mins < 60)  return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs  < 24)  return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    if (days < 30)  return days + 'd ago';
    const months = Math.floor(days / 30);
    return months + 'mo ago';
  },
  money: (cents, currency) => {
    if (typeof cents !== 'number') return '—';
    const cur = (currency || 'gbp').toLowerCase();
    const sym = cur === 'gbp' ? '£' : cur === 'usd' ? '$' : cur === 'eur' ? '€' : '';
    const v = (cents / 100).toFixed(2);
    return sym + v.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  },
  esc: str => String(str == null ? '' : str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c])),
};

const STATUS_LABELS = {
  new: 'New',
  contacted: 'Contacted',
  booked: 'Booked',
  paid: 'Paid',
  lost: 'Lost'
};

// ──────────────────────────────────────────────────────────────
// API
// ──────────────────────────────────────────────────────────────
async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign(
    { 'Accept': 'application/json' },
    opts.body ? { 'Content-Type': 'application/json' } : {},
    _authHeader ? { 'Authorization': _authHeader } : {},
    opts.headers || {}
  );
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (res.status === 401) {
    // Session expired or credentials revoked — clear and re-prompt.
    _clearAuth();
    _showLogin('Session expired — please sign in again.');
    throw new Error('401 unauthorised');
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) {}
    throw new Error(res.status + ' ' + msg);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.indexOf('application/json') >= 0) return res.json();
  return res.text();
}

// ──────────────────────────────────────────────────────────────
// Toast
// ──────────────────────────────────────────────────────────────
let toastTimer;
function toast(message, kind) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.className = 'toast show ' + (kind || '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function copyToClipboard(text) {
  if (!text) return;
  navigator.clipboard.writeText(String(text))
    .then(() => toast('Copied'))
    .catch(() => toast('Copy failed', 'error'));
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-btn');
  if (btn) {
    e.preventDefault();
    e.stopPropagation();
    copyToClipboard(btn.dataset.copy);
  }
});

function copyChip(text) {
  if (!text) return '';
  return '<button class="copy-btn" data-copy="' + fmt.esc(text) + '" title="Copy">copy</button>';
}

// ──────────────────────────────────────────────────────────────
// TABS
// ──────────────────────────────────────────────────────────────
const tabs = $$('#tabs .tab');
const panels = $$('.panel');
function setTab(name) {
  tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  panels.forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  loadPanel(name);
}
tabs.forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));
// ──────────────────────────────────────────────────────────────
// PANEL LOADERS
// ──────────────────────────────────────────────────────────────
async function loadPanel(name) {
  if (name === 'overview')      await loadOverview();
  if (name === 'leads')         await loadLeads();
  if (name === 'payments')      await loadPayments();
  if (name === 'bookings')      await loadBookings();
  if (name === 'members')       await loadMembers();
  if (name === 'announcements') await loadAnnouncements();
}

// ──────────────────────────────────────────────────────────────
// OVERVIEW
// ──────────────────────────────────────────────────────────────
async function loadOverview() {
  try {
    const data = await api('/api/overview');
    paintGreeting();
    paintInsight(data.insight, data.pulse, data.daysToPaid);
    paintPulse(data.pulse);
    paintDaysToPaid(data.daysToPaid);
    paintEquityCurve(data.equityCurve, data.currency);
    paintTodaysThree(data.todaysThree);
  } catch (err) {
    toast('Failed to load overview', 'error');
    console.error(err);
  }
}

function paintGreeting() {
  const h = new Date().getHours();
  const greet =
    h < 5  ? 'Up early.' :
    h < 12 ? 'Good morning.' :
    h < 17 ? 'Good afternoon.' :
    h < 22 ? 'Good evening.' : 'Late shift.';
  const el = $('#ovGreeting');
  if (el) el.textContent = greet;
  const ctx = $('#ovContext');
  if (ctx) {
    const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    ctx.textContent = today + ' · the one screen you read every morning.';
  }
}

function paintInsight(insight, pulse, daysToPaid) {
  if (!insight) return;
  const text = $('#insightText');
  const action = $('#insightAction');
  if (text) text.textContent = insight.text;
  if (action) {
    action.textContent = insight.actionLabel || 'Open';
    action.dataset.targetTab = insight.actionTab || 'leads';
    action.onclick = () => {
      if (typeof setTab === 'function') setTab(insight.actionTab || 'leads');
    };
  }
}

function paintPulse(pulse) {
  if (!pulse) return;
  const v = $('#pulseValue');
  if (v) v.textContent = String(pulse.score);
  const tk = $('#pulseTakeaway');
  if (tk) {
    if (pulse.score >= 70) {
      tk.textContent = 'Strong week. The pipeline is hitting most of its weekly targets.';
    } else if (pulse.score >= 40) {
      tk.textContent = 'Steady pipeline. Room to push on the lowest-scoring component below.';
    } else {
      tk.textContent = 'Pipeline is light this week. Inflow, bookings, or payments are below target.';
    }
  }
  const lEl = $('#pulseLeads');
  const bEl = $('#pulseBookings');
  const pEl = $('#pulsePayments');
  if (lEl) lEl.textContent = (pulse.leads || 0) + ' / 40';
  if (bEl) bEl.textContent = (pulse.bookings || 0) + ' / 35';
  if (pEl) pEl.textContent = (pulse.payments || 0) + ' / 25';

  const hist = (pulse.history || []).slice(-14);
  if (!hist.length) return;
  const W = 200, H = 36, pad = 1;
  const max = 100;
  const stepX = hist.length > 1 ? (W - pad * 2) / (hist.length - 1) : 0;
  const pts = hist.map((y, i) => {
    const x = pad + i * stepX;
    const yy = pad + (1 - y / max) * (H - pad * 2);
    return [x, yy];
  });
  const line = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const fill = line + ' L' + (W - pad).toFixed(1) + ',' + (H - pad).toFixed(1) +
               ' L' + pad.toFixed(1) + ',' + (H - pad).toFixed(1) + ' Z';
  const lineEl = $('#pulseSparkLine');
  const fillEl = $('#pulseSparkFill');
  if (lineEl) lineEl.setAttribute('d', line);
  if (fillEl) fillEl.setAttribute('d', fill);
}

function paintDaysToPaid(daysToPaid) {
  const v = $('#d2pValue');
  const tk = $('#d2pTakeaway');
  if (daysToPaid === null || daysToPaid === undefined) {
    if (v) v.textContent = '—';
    if (tk) tk.textContent = 'No paid conversions in the last 60 days yet. Once a lead converts, the average lands here.';
    return;
  }
  if (v) v.textContent = String(daysToPaid);
  if (tk) {
    if (daysToPaid <= 5)      tk.textContent = 'Fast funnel. Leads are converting in under a week on average.';
    else if (daysToPaid <= 14) tk.textContent = 'Healthy velocity. Most leads close inside two weeks.';
    else                       tk.textContent = 'Funnel is slow. Worth checking where leads sit longest before paying.';
  }
}

function paintEquityCurve(curve, currency) {
  const lineEl  = $('#equityLine');
  const fillEl  = $('#equityFill');
  const emptyEl = $('#equityEmpty');
  const meta    = $('#ecMeta');
  const tk      = $('#ecTakeaway');
  if (!lineEl) return;

  if (!curve || !curve.length) {
    if (emptyEl) emptyEl.classList.remove('hidden');
    if (lineEl) lineEl.setAttribute('d', '');
    if (fillEl) fillEl.setAttribute('d', '');
    if (tk) tk.textContent = 'No paid customers yet. Your first payment will draw the first segment.';
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');

  const totalPence = curve[curve.length - 1].v;
  const ccy = (currency || 'gbp').toUpperCase();
  if (meta) meta.textContent = curve.length + ' payment' + (curve.length !== 1 ? 's' : '') + ' · ' + ccy;
  if (tk) {
    tk.textContent = 'Cumulative gross paid: ' + fmt.money(totalPence, currency || 'gbp') +
      ' across ' + curve.length + ' payment' + (curve.length !== 1 ? 's' : '') + '.';
  }

  // Map points into the SVG's 800×220 canvas (matches viewBox)
  const W = 800, H = 220, padX = 8, padY = 14;
  const tMin = curve[0].t;
  const tMax = curve[curve.length - 1].t;
  const tSpan = Math.max(1, tMax - tMin);
  const vMax = curve[curve.length - 1].v;
  const pts = curve.map(p => {
    const x = padX + ((p.t - tMin) / tSpan) * (W - padX * 2);
    const y = padY + (1 - (p.v / Math.max(1, vMax))) * (H - padY * 2);
    return [x, y];
  });
  // Step path so each new payment shows as a vertical riser then flat — reads as
  // "discrete events" rather than continuous interpolation
  let dLine = 'M' + pts[0][0].toFixed(1) + ',' + (H - padY).toFixed(1);
  dLine += ' L' + pts[0][0].toFixed(1) + ',' + pts[0][1].toFixed(1);
  for (let i = 1; i < pts.length; i++) {
    dLine += ' L' + pts[i][0].toFixed(1) + ',' + pts[i - 1][1].toFixed(1);
    dLine += ' L' + pts[i][0].toFixed(1) + ',' + pts[i][1].toFixed(1);
  }
  // Carry the last value forward to the right edge so the line doesn't end mid-canvas
  dLine += ' L' + (W - padX).toFixed(1) + ',' + pts[pts.length - 1][1].toFixed(1);
  const dFill = dLine + ' L' + (W - padX).toFixed(1) + ',' + (H - padY).toFixed(1) +
                ' L' + padX.toFixed(1) + ',' + (H - padY).toFixed(1) + ' Z';

  lineEl.setAttribute('d', dLine);
  if (fillEl) fillEl.setAttribute('d', dFill);
}

function paintTodaysThree(tasks) {
  const list = $('#todoList');
  if (!list) return;
  if (!tasks || !tasks.length) {
    setHTML(list, '<li class="todo-empty">No items detected.</li>');
    return;
  }
  setHTML(list, tasks.map((t, i) => (
    '<li data-target-tab="' + fmt.esc(t.tab || 'leads') + '">' +
      '<span class="todo-num">' + String(i + 1).padStart(2, '0') + '</span>' +
      '<div class="todo-text">' +
        '<div class="todo-action">' + fmt.esc(t.action) + '</div>' +
        '<div class="todo-evidence">' + fmt.esc(t.evidence) + '</div>' +
      '</div>' +
      '<svg class="todo-arrow" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
        '<path d="M5 3 L11 8 L5 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>' +
    '</li>'
  )).join(''));
  list.querySelectorAll('li[data-target-tab]').forEach(li => {
    li.addEventListener('click', () => {
      const t = li.getAttribute('data-target-tab');
      if (t && typeof setTab === 'function') setTab(t);
    });
  });
}

// safe innerHTML wrapper — values must already be escaped
function setHTML(el, html) {
  if (el) el.innerHTML = html;
}

// ──────────────────────────────────────────────────────────────
// LEADS
// ──────────────────────────────────────────────────────────────
const leadState = { status: 'all', search: '', sort: 'created_at', dir: 'desc' };
let leadSearchTimer;

$$('#leadFilters .chip').forEach(c => c.addEventListener('click', () => {
  $$('#leadFilters .chip').forEach(x => x.classList.toggle('active', x === c));
  leadState.status = c.dataset.status;
  loadLeads();
}));

$('#leadSearch').addEventListener('input', (e) => {
  clearTimeout(leadSearchTimer);
  leadSearchTimer = setTimeout(() => {
    leadState.search = e.target.value.trim();
    loadLeads();
  }, 220);
});

$$('.data thead th.sortable').forEach(th => th.addEventListener('click', () => {
  const col = th.dataset.sort;
  if (leadState.sort === col) {
    leadState.dir = leadState.dir === 'asc' ? 'desc' : 'asc';
  } else {
    leadState.sort = col;
    leadState.dir = (col === 'name' || col === 'email') ? 'asc' : 'desc';
  }
  $$('#panel-leads .data thead th.sortable').forEach(t => t.classList.toggle('sorted', t === th));
  loadLeads();
}));

async function loadLeads() {
  if (!$('#panel-leads').classList.contains('active')) return;
  const body = $('#leadsBody');
  setHTML(body, '<tr><td colspan="7" class="muted center" data-label="">Loading…</td></tr>');
  try {
    const params = new URLSearchParams();
    if (leadState.status && leadState.status !== 'all') params.set('status', leadState.status);
    if (leadState.search) params.set('search', leadState.search);
    if (leadState.sort) params.set('sort', leadState.sort);
    if (leadState.dir) params.set('dir', leadState.dir);
    const rows = await api('/api/leads?' + params.toString());
    if (!rows.length) {
      setHTML(body, '<tr><td colspan="7" class="muted center" data-label="">No leads yet.</td></tr>');
      return;
    }
    setHTML(body, rows.map(r => (
      '<tr data-id="' + fmt.esc(r.id) + '">' +
        '<td data-label="Name">' + (fmt.esc(r.name) || '<span class="muted">—</span>') + '</td>' +
        '<td data-label="Email" class="mono">' + fmt.esc(r.email) + '</td>' +
        '<td data-label="Phone" class="mono">' + (fmt.esc(r.phone) || '<span class="muted">—</span>') + '</td>' +
        '<td data-label="Account size" class="mono">' + (fmt.esc(r.account_size) || '<span class="muted">—</span>') + '</td>' +
        '<td data-label="Status"><span class="status ' + fmt.esc(r.status) + '">' + fmt.esc(STATUS_LABELS[r.status] || r.status) + '</span></td>' +
        '<td data-label="Source" class="mono muted">' + fmt.esc(r.utm_source || r.source || '—') + '</td>' +
        '<td data-label="Submitted" class="r mono">' + fmt.esc(fmt.ago(r.created_at)) + '</td>' +
      '</tr>'
    )).join(''));
    $$('#leadsBody tr[data-id]').forEach(tr => tr.addEventListener('click', () => {
      openDrawer(tr.dataset.id);
    }));
  } catch (err) {
    setHTML(body, '<tr><td colspan="7" class="muted center" data-label="">Error: ' + fmt.esc(err.message) + '</td></tr>');
  }
}

// ──────────────────────────────────────────────────────────────
// PAYMENTS
// ──────────────────────────────────────────────────────────────
async function loadPayments() {
  if (!$('#panel-payments').classList.contains('active')) return;
  const body = $('#paymentsBody');
  setHTML(body, '<tr><td colspan="6" class="muted center" data-label="">Loading…</td></tr>');
  try {
    const rows = await api('/api/payments');
    if (!rows.length) {
      setHTML(body, '<tr><td colspan="6" class="muted center" data-label="">No payments yet.</td></tr>');
      return;
    }
    setHTML(body, rows.map(r => {
      const sid = r.stripe_session_id || '';
      const ref = r.client_reference_id || '';
      return '<tr>' +
        '<td data-label="Email" class="mono">' + (fmt.esc(r.email) || '<span class="muted">—</span>') + '</td>' +
        '<td data-label="Amount" class="r mono">' + fmt.esc(fmt.money(r.amount_cents, r.currency || 'gbp')) + '</td>' +
        '<td data-label="Status"><span class="status ' + (r.status === 'paid' ? 'paid' : 'new') + '">' + fmt.esc(r.status) + '</span></td>' +
        '<td data-label="Stripe session" class="mono muted">' + fmt.esc(sid.slice(0, 22)) + (sid.length > 22 ? '…' : '') + copyChip(sid) + '</td>' +
        '<td data-label="Reference" class="mono muted">' + fmt.esc(ref.slice(0, 22)) + copyChip(ref) + '</td>' +
        '<td data-label="Received" class="r mono">' + fmt.esc(fmt.ago(r.created_at)) + '</td>' +
      '</tr>';
    }).join(''));
  } catch (err) {
    setHTML(body, '<tr><td colspan="6" class="muted center" data-label="">Error: ' + fmt.esc(err.message) + '</td></tr>');
  }
}

// ──────────────────────────────────────────────────────────────
// BOOKINGS
// ──────────────────────────────────────────────────────────────
async function loadBookings() {
  if (!$('#panel-bookings').classList.contains('active')) return;
  const body = $('#bookingsBody');
  setHTML(body, '<tr><td colspan="5" class="muted center" data-label="">Loading…</td></tr>');
  try {
    const rows = await api('/api/bookings');
    if (!rows.length) {
      setHTML(body, '<tr><td colspan="5" class="muted center" data-label="">No bookings yet.</td></tr>');
      return;
    }
    setHTML(body, rows.map(r => (
      '<tr>' +
        '<td data-label="Name">' + (fmt.esc(r.name) || '<span class="muted">—</span>') + '</td>' +
        '<td data-label="Email" class="mono">' + fmt.esc(r.email) + '</td>' +
        '<td data-label="Type" class="mono"><span class="status ' + (r.type === 'onboarding' ? 'paid' : 'booked') + '">' + fmt.esc(r.type) + '</span></td>' +
        '<td data-label="Scheduled" class="r mono">' + fmt.esc(fmt.date(r.scheduled_at)) + '</td>' +
        '<td data-label="Created" class="r mono muted">' + fmt.esc(fmt.ago(r.created_at)) + '</td>' +
      '</tr>'
    )).join(''));
  } catch (err) {
    setHTML(body, '<tr><td colspan="5" class="muted center" data-label="">Error: ' + fmt.esc(err.message) + '</td></tr>');
  }
}

// ──────────────────────────────────────────────────────────────
// MEMBERS — read-only mirror of the member portal's signups,
// joined to lead/payment/booking counts so the admin sees who's
// a paying customer vs who's just signed up. The admin never
// writes to the members table — that's owned by the member
// portal.
// ──────────────────────────────────────────────────────────────
let _memberSearchWired = false;
let _memberSearchTimer = null;

async function loadMembers(search) {
  if (!$('#panel-members').classList.contains('active')) return;
  if (!_memberSearchWired) {
    const box = $('#memberSearch');
    if (box) {
      box.addEventListener('input', () => {
        clearTimeout(_memberSearchTimer);
        _memberSearchTimer = setTimeout(() => loadMembers(box.value.trim()), 250);
      });
    }
    _memberSearchWired = true;
  }
  const body = $('#membersBody');
  setHTML(body, '<tr><td colspan="7" class="muted center" data-label="">Loading…</td></tr>');
  try {
    const url = '/api/members' + (search ? ('?search=' + encodeURIComponent(search)) : '');
    const rows = await api(url);

    // Mini-stats above the table
    const total = rows.length;
    const paid    = rows.filter(r => (r.payments_count || 0) > 0).length;
    const booked  = rows.filter(r => (r.bookings_count || 0) > 0).length;
    const week    = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const active7 = rows.filter(r => (r.last_login_at || 0) >= week).length;
    $('#memStatTotal .v').textContent = String(total);
    $('#memStatPaid .v').textContent = String(paid);
    $('#memStatBooking .v').textContent = String(booked);
    $('#memStatActive7 .v').textContent = String(active7);

    if (!rows.length) {
      setHTML(body, '<tr><td colspan="7" class="muted center" data-label="">' + (search ? 'No matches.' : 'No members yet. The first signup at algomembers.vercel.app will appear here.') + '</td></tr>');
      return;
    }
    setHTML(body, rows.map(r => {
      const linkBadge = r.payments_count > 0
        ? '<span class="member-link linked-paid">Paid</span>'
        : r.bookings_count > 0
          ? '<span class="member-link linked-booked">Booked</span>'
          : r.leads_count > 0
            ? '<span class="member-link linked-lead">Lead only</span>'
            : '<span class="member-link linked-none">Signup only</span>';
      const paidStr = r.paid_pence > 0
        ? fmt.money(r.paid_pence, 'gbp')
        : '<span class="muted">—</span>';
      const bookingsStr = r.bookings_count > 0
        ? String(r.bookings_count)
        : '<span class="muted">—</span>';
      const lastLogin = r.last_login_at
        ? fmt.esc(fmt.ago(r.last_login_at))
        : '<span class="muted">never</span>';
      return (
        '<tr>' +
          '<td data-label="Name">' + (fmt.esc(r.name) || '<span class="muted">—</span>') + '</td>' +
          '<td data-label="Email" class="mono">' + fmt.esc(r.email) + '</td>' +
          '<td data-label="Status" class="r">' + linkBadge + '</td>' +
          '<td data-label="Paid" class="r mono">' + paidStr + '</td>' +
          '<td data-label="Bookings" class="r mono">' + bookingsStr + '</td>' +
          '<td data-label="Last login" class="r mono muted">' + lastLogin + '</td>' +
          '<td data-label="Signed up" class="r mono muted">' + fmt.esc(fmt.ago(r.created_at)) + '</td>' +
        '</tr>'
      );
    }).join(''));
  } catch (err) {
    setHTML(body, '<tr><td colspan="7" class="muted center" data-label="">Error: ' + fmt.esc(err.message) + '</td></tr>');
  }
}

// ──────────────────────────────────────────────────────────────
// ANNOUNCEMENTS — admin composes; the SAME table is read by the
// member portal (read-only there). This is the only data surface
// shared between admin and members. Nothing else cross-contaminates.
// ──────────────────────────────────────────────────────────────
let _annWiringDone = false;

async function loadAnnouncements() {
  if (!$('#panel-announcements').classList.contains('active')) return;
  if (!_annWiringDone) wireAnnouncements();
  await refreshAnnouncementsList();
}

function wireAnnouncements() {
  const form    = $('#announcementForm');
  const title   = $('#annTitle');
  const body    = $('#annBody');
  const pinned  = $('#annPinned');
  const submit  = $('#annSubmit');
  const error   = $('#annError');
  const tCount  = $('#annTitleCount');
  const bCount  = $('#annBodyCount');
  if (!form) return;

  const updateCounts = () => {
    tCount.textContent = title.value.length + ' / 160';
    bCount.textContent = body.value.length + ' / 4000';
  };
  title.addEventListener('input', updateCounts);
  body.addEventListener('input', updateCounts);
  updateCounts();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    const t = title.value.trim();
    const b = body.value.trim();
    if (!t || !b) { error.textContent = 'Title and body are required.'; return; }
    submit.disabled = true; submit.textContent = 'Publishing…';
    try {
      await api('/api/announcements', {
        method: 'POST',
        body: JSON.stringify({ title: t, body: b, pinned: pinned.checked }),
      });
      title.value = ''; body.value = ''; pinned.checked = false;
      updateCounts();
      await refreshAnnouncementsList();
    } catch (err) {
      error.textContent = (err.message || 'Failed to publish.').replace(/^4\d\d /, '');
    } finally {
      submit.disabled = false; submit.textContent = 'Publish to all members →';
    }
  });

  _annWiringDone = true;
}

async function refreshAnnouncementsList() {
  const list = $('#announcementsList');
  const count = $('#annCount');
  setHTML(list, '<div class="muted center" style="padding:2rem 0">Loading…</div>');
  try {
    const rows = await api('/api/announcements');
    count.textContent = rows.length
      ? rows.length + ' published · visible to every member'
      : 'No announcements yet';
    if (!rows.length) {
      setHTML(list, '<div class="muted center" style="padding:2.5rem 0">Nothing published yet. The first post you publish above will appear on every member dashboard immediately.</div>');
      return;
    }
    setHTML(list, rows.map((r) => (
      '<article class="ann-item' + (r.pinned ? ' pinned' : '') + '" data-ann-id="' + r.id + '">' +
        '<header class="ann-item-head">' +
          '<h3 class="ann-item-title">' + fmt.esc(r.title) + '</h3>' +
          '<div class="ann-item-meta">' +
            (r.pinned ? '<span class="ann-pin-tag">Pinned</span>' : '') +
            '<span>' + fmt.esc(fmt.ago(r.published_at)) + '</span>' +
          '</div>' +
        '</header>' +
        '<div class="ann-item-body">' + fmt.esc(r.body) + '</div>' +
        '<div class="ann-item-actions">' +
          '<button class="btn btn-ghost" data-ann-toggle-pin="' + r.id + '" data-pinned="' + (r.pinned ? '1' : '0') + '">' + (r.pinned ? 'Unpin' : 'Pin to top') + '</button>' +
          '<button class="btn btn-ghost danger" data-ann-delete="' + r.id + '">Delete</button>' +
        '</div>' +
      '</article>'
    )).join(''));

    // Pin/unpin
    $$('[data-ann-toggle-pin]').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-ann-toggle-pin');
      const wasPinned = btn.getAttribute('data-pinned') === '1';
      btn.disabled = true;
      try {
        await api('/api/announcements/' + encodeURIComponent(id), {
          method: 'PATCH',
          body: JSON.stringify({ pinned: !wasPinned }),
        });
        await refreshAnnouncementsList();
      } catch (err) {
        btn.disabled = false;
        alert('Failed: ' + err.message);
      }
    }));

    // Delete
    $$('[data-ann-delete]').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-ann-delete');
      if (!confirm('Delete this announcement? It will disappear from every member dashboard.')) return;
      btn.disabled = true;
      try {
        await api('/api/announcements/' + encodeURIComponent(id), { method: 'DELETE' });
        await refreshAnnouncementsList();
      } catch (err) {
        btn.disabled = false;
        alert('Failed: ' + err.message);
      }
    }));
  } catch (err) {
    setHTML(list, '<div class="muted center" style="padding:2rem 0">Error: ' + fmt.esc(err.message) + '</div>');
    count.textContent = '';
  }
}

// ──────────────────────────────────────────────────────────────
// DRAWER (lead detail)
// ──────────────────────────────────────────────────────────────
const drawer = $('#drawer');
$$('[data-close-drawer]').forEach(el => el.addEventListener('click', closeDrawer));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
});

function closeDrawer() {
  drawer.setAttribute('aria-hidden', 'true');
}

let drawerLead = null;

async function openDrawer(id) {
  drawer.setAttribute('aria-hidden', 'false');
  $('#drawerTitle').textContent = 'Loading…';
  setHTML($('#drawerBody'), '<div class="muted center" style="padding:2rem">Loading…</div>');
  try {
    const data = await api('/api/leads/' + encodeURIComponent(id));
    drawerLead = data.lead;
    renderDrawer(data);
  } catch (err) {
    setHTML($('#drawerBody'), '<div class="muted center" style="padding:2rem">Error: ' + fmt.esc(err.message) + '</div>');
  }
}

function renderDrawer(data) {
  const lead = data.lead;
  const payments = data.payments || [];
  const bookings = data.bookings || [];
  const events = data.events || [];

  $('#drawerTitle').textContent = lead.name || lead.email || ('Lead #' + lead.id);

  const mailtoSubject = encodeURIComponent('Following up on Algo by Excelsior');
  const mailtoBody = encodeURIComponent('Hi ' + (lead.name || '') + ',\n\nThanks for reaching out about Algo by Excelsior. ');
  const emailLink = lead.email
    ? '<a href="mailto:' + fmt.esc(lead.email) + '?subject=' + mailtoSubject + '&body=' + mailtoBody + '">' + fmt.esc(lead.email) + '</a>' + copyChip(lead.email)
    : '<span class="muted">—</span>';

  let phoneLink = '<span class="muted">—</span>';
  if (lead.phone) {
    const cleanTel = lead.phone.replace(/\s/g, '');
    const cleanWa = lead.phone.replace(/[^0-9]/g, '');
    phoneLink = '<a href="tel:' + fmt.esc(cleanTel) + '">' + fmt.esc(lead.phone) + '</a>' + copyChip(lead.phone);
    if (lead.phone.indexOf('+') === 0) {
      phoneLink += ' <a class="copy-btn" target="_blank" rel="noopener" href="https://wa.me/' + fmt.esc(cleanWa) + '">whatsapp ↗</a>';
    }
  }

  const utmJoined = [lead.utm_source, lead.utm_medium, lead.utm_campaign].filter(Boolean).join(' / ');

  const fields =
    '<div class="field-grid">' +
      '<span class="k">Email</span><span class="v mono">' + emailLink + '</span>' +
      '<span class="k">Phone</span><span class="v mono">' + phoneLink + '</span>' +
      '<span class="k">Acct size</span><span class="v mono">' + (fmt.esc(lead.account_size) || '<span class="muted">not provided</span>') + '</span>' +
      '<span class="k">Risk ack</span><span class="v mono">' + (lead.risk_ack ? '<span class="pos">✓ acknowledged</span>' : '<span class="neg">not acknowledged</span>') + '</span>' +
      '<span class="k">Source</span><span class="v mono">' + fmt.esc(lead.source || '—') + '</span>' +
      (lead.utm_source ? '<span class="k">UTM</span><span class="v mono">' + fmt.esc(utmJoined) + '</span>' : '') +
      '<span class="k">Reference</span><span class="v mono">' + fmt.esc(lead.client_reference_id || '—') + (lead.client_reference_id ? copyChip(lead.client_reference_id) : '') + '</span>' +
      '<span class="k">Submitted</span><span class="v mono">' + fmt.esc(fmt.date(lead.created_at)) + '</span>' +
    '</div>';

  const statusRow = '<div class="status-row">' +
    ['new', 'contacted', 'booked', 'paid', 'lost'].map(s =>
      '<button class="chip ' + (s === lead.status ? 'active' : '') + '" data-set-status="' + s + '">' + STATUS_LABELS[s] + '</button>'
    ).join('') + '</div>';

  const paymentsHTML = payments.length
    ? payments.map(p => (
      '<div class="timeline-item">' +
        '<div class="when">' + fmt.esc(fmt.date(p.created_at)) + '</div>' +
        '<div class="what"><span class="type">payment</span> ' + fmt.esc(fmt.money(p.amount_cents, p.currency)) + ' · <span class="' + (p.status === 'paid' ? 'pos' : '') + '">' + fmt.esc(p.status) + '</span></div>' +
        (p.stripe_session_id ? '<div class="detail">' + fmt.esc(p.stripe_session_id) + copyChip(p.stripe_session_id) + '</div>' : '') +
      '</div>'
    )).join('')
    : '<div class="muted" style="font-size:0.8125rem">No payments yet.</div>';

  const bookingsHTML = bookings.length
    ? bookings.map(b => (
      '<div class="timeline-item">' +
        '<div class="when">' + fmt.esc(fmt.date(b.scheduled_at)) + '</div>' +
        '<div class="what"><span class="type">' + fmt.esc(b.type) + '</span> ' + fmt.esc(b.name || b.email) + '</div>' +
      '</div>'
    )).join('')
    : '<div class="muted" style="font-size:0.8125rem">No bookings yet.</div>';

  const timelineHTML = events.length
    ? '<div class="timeline">' + events.map(ev => (
        '<div class="timeline-item">' +
          '<div class="when">' + fmt.esc(fmt.date(ev.created_at)) + '</div>' +
          '<div class="what"><span class="type">' + fmt.esc(ev.type) + '</span></div>' +
          (ev.detail ? '<div class="detail">' + fmt.esc(ev.detail) + '</div>' : '') +
        '</div>'
      )).join('') + '</div>'
    : '<div class="muted" style="font-size:0.8125rem">No activity logged.</div>';

  setHTML($('#drawerBody'),
    '<div class="drawer-section">' + fields + '</div>' +
    '<div class="drawer-section"><h3>Status</h3>' + statusRow + '</div>' +
    '<div class="drawer-section"><h3>Notes</h3>' +
      '<textarea class="notes-input" id="notesInput" placeholder="Add private notes — saved automatically when you click outside.">' + fmt.esc(lead.notes || '') + '</textarea>' +
    '</div>' +
    '<div class="drawer-section"><h3>Activity</h3>' + timelineHTML + '</div>' +
    '<div class="drawer-section"><h3>Stripe payments</h3>' + paymentsHTML + '</div>' +
    '<div class="drawer-section"><h3>Calendly bookings</h3>' + bookingsHTML + '</div>' +
    '<div class="drawer-actions">' +
      '<a class="btn btn-ghost" href="/api/lead-data/' + encodeURIComponent(lead.id) + '" download>Download data (JSON)</a>' +
      '<button class="btn btn-danger" id="deleteLeadBtn">Delete lead</button>' +
    '</div>'
  );

  $$('#drawerBody .status-row .chip').forEach(c => {
    c.addEventListener('click', async () => {
      const newStatus = c.dataset.setStatus;
      if (newStatus === lead.status) return;
      try {
        await api('/api/leads/' + encodeURIComponent(lead.id), {
          method: 'PATCH',
          body: JSON.stringify({ status: newStatus })
        });
        toast('Status updated');
        $$('#drawerBody .status-row .chip').forEach(x => x.classList.toggle('active', x === c));
        drawerLead.status = newStatus;
        loadLeads();
      } catch (err) {
        toast('Failed: ' + err.message, 'error');
      }
    });
  });

  const notesInput = $('#notesInput');
  if (notesInput) {
    notesInput.addEventListener('blur', async () => {
      const value = notesInput.value;
      if (value === (drawerLead.notes || '')) return;
      try {
        await api('/api/leads/' + encodeURIComponent(lead.id), {
          method: 'PATCH',
          body: JSON.stringify({ notes: value })
        });
        drawerLead.notes = value;
        toast('Notes saved');
      } catch (err) {
        toast('Save failed: ' + err.message, 'error');
      }
    });
  }

  const delBtn = $('#deleteLeadBtn');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm('Delete lead "' + (lead.name || lead.email) + '"? This is permanent.')) return;
    try {
      await api('/api/leads/' + encodeURIComponent(lead.id), { method: 'DELETE' });
      toast('Lead deleted');
      closeDrawer();
      loadLeads();
      loadOverview();
    } catch (err) {
      toast('Delete failed: ' + err.message, 'error');
    }
  });
}

// ──────────────────────────────────────────────────────────────
// Auto-refresh every 30s on the active panel (no refresh while
// the drawer is open — user is editing).
// ──────────────────────────────────────────────────────────────
setInterval(() => {
  const active = document.querySelector('.tab.active');
  if (!active || document.hidden) return;
  if (drawer.getAttribute('aria-hidden') === 'false') return;
  loadPanel(active.dataset.tab);
}, 30 * 1000);

// ──────────────────────────────────────────────────────────────
// BOOTSTRAP — runs last so every const above is initialized
// before setTab triggers the first loadPanel() call.
// ──────────────────────────────────────────────────────────────
if (_authHeader) {
  const initial = (location.hash || '#overview').replace('#', '');
  const valid = ['overview', 'leads', 'payments', 'bookings'];
  setTab(valid.indexOf(initial) >= 0 ? initial : 'overview');
}
