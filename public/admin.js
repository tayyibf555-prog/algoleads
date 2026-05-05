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
    opts.headers || {}
  );
  const res = await fetch(path, Object.assign({}, opts, { headers }));
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
  if (name === 'overview')  await loadOverview();
  if (name === 'leads')     await loadLeads();
  if (name === 'payments')  await loadPayments();
  if (name === 'bookings')  await loadBookings();
}

// ──────────────────────────────────────────────────────────────
// OVERVIEW
// ──────────────────────────────────────────────────────────────
async function loadOverview() {
  try {
    const stats = await api('/api/stats');
    $$('[data-stat]').forEach(el => {
      const key = el.dataset.stat;
      const suffix = el.dataset.suffix || '';
      const v = stats[key];
      if (v === undefined || v === null) {
        el.textContent = '—';
      } else if (typeof v === 'number') {
        el.textContent = (v.toLocaleString ? v.toLocaleString('en-GB') : String(v)) + suffix;
      } else {
        el.textContent = String(v) + suffix;
      }
    });
    $('#revenueValue').textContent = fmt.money(stats.totalRevenuePence || 0, 'gbp');

    const total = stats.totalLeads || 0;
    const order = [
      { key: 'new',       label: 'New' },
      { key: 'contacted', label: 'Contacted' },
      { key: 'booked',    label: 'Booked' },
      { key: 'paid',      label: 'Paid' },
      { key: 'lost',      label: 'Lost' }
    ];
    const counts = {
      new:       stats.totalLeads - stats.totalContacted - stats.totalBooked - stats.totalLost,
      contacted: stats.totalContacted,
      booked:    stats.totalBooked - stats.totalPaid,
      paid:      stats.totalPaid,
      lost:      stats.totalLost
    };
    counts.new = Math.max(0, counts.new);
    counts.booked = Math.max(0, counts.booked);

    const max = Math.max(1, Math.max.apply(null, Object.values(counts)));
    const html = order.map(o => {
      const c = counts[o.key] || 0;
      const pct = total > 0 ? Math.round((c / total) * 100) : 0;
      const w = Math.round((c / max) * 100);
      return '<div class="funnel-row">' +
        '<span class="key">' + fmt.esc(o.label) + '</span>' +
        '<div class="bar"><div class="bar-fill" style="width:' + w + '%"></div></div>' +
        '<span class="count">' + c + '</span>' +
        '<span class="pct">' + pct + '%</span>' +
      '</div>';
    }).join('');
    setHTML($('#funnelRows'), html);
  } catch (err) {
    toast('Failed to load stats', 'error');
    console.error(err);
  }
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
  setHTML(body, '<tr><td colspan="7" class="muted center">Loading…</td></tr>');
  try {
    const params = new URLSearchParams();
    if (leadState.status && leadState.status !== 'all') params.set('status', leadState.status);
    if (leadState.search) params.set('search', leadState.search);
    if (leadState.sort) params.set('sort', leadState.sort);
    if (leadState.dir) params.set('dir', leadState.dir);
    const rows = await api('/api/leads?' + params.toString());
    if (!rows.length) {
      setHTML(body, '<tr><td colspan="7" class="muted center">No leads yet.</td></tr>');
      return;
    }
    setHTML(body, rows.map(r => (
      '<tr data-id="' + fmt.esc(r.id) + '">' +
        '<td>' + (fmt.esc(r.name) || '<span class="muted">—</span>') + '</td>' +
        '<td class="mono">' + fmt.esc(r.email) + '</td>' +
        '<td class="mono">' + (fmt.esc(r.phone) || '<span class="muted">—</span>') + '</td>' +
        '<td class="mono">' + (fmt.esc(r.account_size) || '<span class="muted">—</span>') + '</td>' +
        '<td><span class="status ' + fmt.esc(r.status) + '">' + fmt.esc(STATUS_LABELS[r.status] || r.status) + '</span></td>' +
        '<td class="mono muted">' + fmt.esc(r.utm_source || r.source || '—') + '</td>' +
        '<td class="r mono">' + fmt.esc(fmt.ago(r.created_at)) + '</td>' +
      '</tr>'
    )).join(''));
    $$('#leadsBody tr[data-id]').forEach(tr => tr.addEventListener('click', () => {
      openDrawer(tr.dataset.id);
    }));
  } catch (err) {
    setHTML(body, '<tr><td colspan="7" class="muted center">Error: ' + fmt.esc(err.message) + '</td></tr>');
  }
}

// ──────────────────────────────────────────────────────────────
// PAYMENTS
// ──────────────────────────────────────────────────────────────
async function loadPayments() {
  if (!$('#panel-payments').classList.contains('active')) return;
  const body = $('#paymentsBody');
  setHTML(body, '<tr><td colspan="6" class="muted center">Loading…</td></tr>');
  try {
    const rows = await api('/api/payments');
    if (!rows.length) {
      setHTML(body, '<tr><td colspan="6" class="muted center">No payments yet.</td></tr>');
      return;
    }
    setHTML(body, rows.map(r => {
      const sid = r.stripe_session_id || '';
      const ref = r.client_reference_id || '';
      return '<tr>' +
        '<td class="mono">' + (fmt.esc(r.email) || '<span class="muted">—</span>') + '</td>' +
        '<td class="r mono">' + fmt.esc(fmt.money(r.amount_cents, r.currency || 'gbp')) + '</td>' +
        '<td><span class="status ' + (r.status === 'paid' ? 'paid' : 'new') + '">' + fmt.esc(r.status) + '</span></td>' +
        '<td class="mono muted">' + fmt.esc(sid.slice(0, 22)) + (sid.length > 22 ? '…' : '') + copyChip(sid) + '</td>' +
        '<td class="mono muted">' + fmt.esc(ref.slice(0, 22)) + copyChip(ref) + '</td>' +
        '<td class="r mono">' + fmt.esc(fmt.ago(r.created_at)) + '</td>' +
      '</tr>';
    }).join(''));
  } catch (err) {
    setHTML(body, '<tr><td colspan="6" class="muted center">Error: ' + fmt.esc(err.message) + '</td></tr>');
  }
}

// ──────────────────────────────────────────────────────────────
// BOOKINGS
// ──────────────────────────────────────────────────────────────
async function loadBookings() {
  if (!$('#panel-bookings').classList.contains('active')) return;
  const body = $('#bookingsBody');
  setHTML(body, '<tr><td colspan="5" class="muted center">Loading…</td></tr>');
  try {
    const rows = await api('/api/bookings');
    if (!rows.length) {
      setHTML(body, '<tr><td colspan="5" class="muted center">No bookings yet.</td></tr>');
      return;
    }
    setHTML(body, rows.map(r => (
      '<tr>' +
        '<td>' + (fmt.esc(r.name) || '<span class="muted">—</span>') + '</td>' +
        '<td class="mono">' + fmt.esc(r.email) + '</td>' +
        '<td class="mono"><span class="status ' + (r.type === 'onboarding' ? 'paid' : 'booked') + '">' + fmt.esc(r.type) + '</span></td>' +
        '<td class="r mono">' + fmt.esc(fmt.date(r.scheduled_at)) + '</td>' +
        '<td class="r mono muted">' + fmt.esc(fmt.ago(r.created_at)) + '</td>' +
      '</tr>'
    )).join(''));
  } catch (err) {
    setHTML(body, '<tr><td colspan="5" class="muted center">Error: ' + fmt.esc(err.message) + '</td></tr>');
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
{
  const initial = (location.hash || '#overview').replace('#', '');
  const valid = ['overview', 'leads', 'payments', 'bookings'];
  setTab(valid.indexOf(initial) >= 0 ? initial : 'overview');
}
