/**
 * Algo by Excelsior — admin portal API + static UI.
 *
 * Single-file Node.js server. Express + better-sqlite3.
 *
 * Public endpoints (CORS-enabled, no auth):
 *   POST  /api/leads                  — receive form submissions from the marketing site
 *   POST  /api/webhooks/stripe        — receive Stripe checkout.session.completed events
 *   POST  /api/webhooks/calendly      — receive Calendly invitee.created events
 *
 * Admin endpoints (HTTP Basic Auth):
 *   GET   /api/leads                  — list with filter / search / sort
 *   GET   /api/leads/:id              — single lead with linked payments + bookings + timeline
 *   PATCH /api/leads/:id              — update notes / status
 *   DELETE /api/leads/:id             — GDPR delete
 *   GET   /api/payments               — list Stripe payments
 *   GET   /api/bookings               — list Calendly bookings
 *   GET   /api/stats                  — funnel summary
 *   GET   /api/export.csv             — leads as CSV download
 *   GET   /api/lead-data/:id          — full record export for SAR (subject access)
 *
 * Static admin UI:
 *   GET   /                           — public/index.html (auth required)
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const Database = require('better-sqlite3');
const cors = require('cors');
require('dotenv').config();

const PORT = parseInt(process.env.PORT || '4002', 10);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const CALENDLY_WEBHOOK_SECRET = process.env.CALENDLY_WEBHOOK_SECRET || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
const LEAD_RETENTION_DAYS = parseInt(process.env.LEAD_RETENTION_DAYS || '0', 10);

// ──────────────────────────────────────────────────────────────
// Database — SQLite via better-sqlite3 (sync, fast, single file)
// ──────────────────────────────────────────────────────────────
const dbDir = path.join(__dirname, 'db');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(path.join(dbDir, 'algo-admin.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema — each statement applied individually so it's explicit
const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT,
    phone TEXT DEFAULT '',
    account_size TEXT DEFAULT '',
    risk_ack INTEGER DEFAULT 0,
    source TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    referrer TEXT DEFAULT '',
    utm_source TEXT DEFAULT '',
    utm_medium TEXT DEFAULT '',
    utm_campaign TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    status TEXT DEFAULT 'new',
    client_reference_id TEXT DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status)`,
  `CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stripe_session_id TEXT UNIQUE,
    email TEXT,
    amount_cents INTEGER DEFAULT 0,
    currency TEXT DEFAULT 'gbp',
    status TEXT DEFAULT '',
    client_reference_id TEXT DEFAULT '',
    raw_json TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_payments_email ON payments(email)`,
  `CREATE INDEX IF NOT EXISTS idx_payments_ref ON payments(client_reference_id)`,
  `CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    calendly_event_id TEXT UNIQUE,
    email TEXT,
    name TEXT,
    type TEXT DEFAULT 'discovery',
    scheduled_at INTEGER,
    raw_json TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bookings_email ON bookings(email)`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    email TEXT,
    type TEXT,
    detail TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_email ON events(email)`,
  `CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at)`,
];
for (const stmt of schemaStatements) db.prepare(stmt).run();

// Helper — log an event (chronological audit trail per lead)
function logEvent({ lead_id = null, email = '', type, detail = '' }) {
  db.prepare(
    'INSERT INTO events (lead_id, email, type, detail, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(lead_id, email || '', type, detail, Date.now());
}

// ──────────────────────────────────────────────────────────────
// App + middleware
// ──────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// CORS for public POST endpoints
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl / same-origin
    if (ALLOWED_ORIGINS.includes('*')) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'));
  },
  credentials: false
};
app.use(cors(corsOptions));

// Stripe webhook needs the raw body BEFORE the JSON parser eats it.
app.post(
  '/api/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  handleStripeWebhook
);

app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true }));

// ──────────────────────────────────────────────────────────────
// Public endpoint — Marketing-site lead form
// ──────────────────────────────────────────────────────────────
app.post('/api/leads', (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 200);
    const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
    if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'name and valid email required' });
    }
    const phone = String(b.phone || '').trim().slice(0, 50);
    const account_size = String(b.account_size || '').trim().slice(0, 30);
    const risk_ack = b.risk_ack ? 1 : 0;
    const source = String(b.source || 'marketing-site').slice(0, 80);
    const client_reference_id = String(b.client_reference_id || '').slice(0, 100);
    const utm_source = String(b.utm_source || '').slice(0, 80);
    const utm_medium = String(b.utm_medium || '').slice(0, 80);
    const utm_campaign = String(b.utm_campaign || '').slice(0, 120);
    const user_agent = (req.get('user-agent') || '').slice(0, 400);
    const referrer = (b.referrer || req.get('referer') || '').slice(0, 400);

    const result = db.prepare(`
      INSERT INTO leads
        (name, email, phone, account_size, risk_ack, source, user_agent, referrer,
         utm_source, utm_medium, utm_campaign, client_reference_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, email, phone, account_size, risk_ack, source, user_agent, referrer,
      utm_source, utm_medium, utm_campaign, client_reference_id, Date.now()
    );

    logEvent({
      lead_id: result.lastInsertRowid,
      email,
      type: 'form_submitted',
      detail: client_reference_id ? `ref=${client_reference_id}` : ''
    });

    return res.json({ ok: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('POST /api/leads', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// ──────────────────────────────────────────────────────────────
// Stripe webhook
// ──────────────────────────────────────────────────────────────
function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!secret) return true; // signature verification disabled
  if (!sigHeader) return false;
  const parts = Object.fromEntries(
    sigHeader.split(',').map(p => p.split('=').map(s => s.trim()))
  );
  const ts = parts.t;
  const sig = parts.v1;
  if (!ts || !sig) return false;
  const signed = `${ts}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function handleStripeWebhook(req, res) {
  try {
    const sig = req.get('stripe-signature') || '';
    if (!verifyStripeSignature(req.body, sig, STRIPE_WEBHOOK_SECRET)) {
      console.warn('Stripe webhook: signature mismatch');
      return res.status(400).send('signature mismatch');
    }
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const s = event.data.object || {};
      const email = String(s.customer_email || (s.customer_details && s.customer_details.email) || '').toLowerCase();
      const ref = String(s.client_reference_id || '');

      db.prepare(`
        INSERT OR IGNORE INTO payments
          (stripe_session_id, email, amount_cents, currency, status, client_reference_id, raw_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        s.id || '',
        email,
        s.amount_total || 0,
        s.currency || 'gbp',
        s.payment_status || 'paid',
        ref,
        JSON.stringify(s),
        Date.now()
      );

      let leadId = null;
      if (ref) {
        const r = db.prepare('SELECT id FROM leads WHERE client_reference_id = ?').get(ref);
        if (r) leadId = r.id;
      }
      if (!leadId && email) {
        const r = db.prepare('SELECT id FROM leads WHERE email = ? ORDER BY created_at DESC LIMIT 1').get(email);
        if (r) leadId = r.id;
      }
      if (leadId) {
        db.prepare("UPDATE leads SET status = 'paid' WHERE id = ?").run(leadId);
      }
      logEvent({
        lead_id: leadId,
        email,
        type: 'payment_completed',
        detail: `${s.id} · ${(s.amount_total || 0) / 100} ${s.currency || 'gbp'}`
      });
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook error', err);
    res.status(500).json({ error: 'internal error' });
  }
}

// ──────────────────────────────────────────────────────────────
// Calendly webhook
// ──────────────────────────────────────────────────────────────
app.post('/api/webhooks/calendly', (req, res) => {
  try {
    if (CALENDLY_WEBHOOK_SECRET) {
      const raw = JSON.stringify(req.body);
      const sigHeader = req.get('calendly-webhook-signature') || '';
      const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=').map(s => s.trim())));
      if (parts.t && parts.v1) {
        const expected = crypto.createHmac('sha256', CALENDLY_WEBHOOK_SECRET)
          .update(`${parts.t}.${raw}`).digest('hex');
        if (!crypto.timingSafeEqual(Buffer.from(parts.v1, 'hex'), Buffer.from(expected, 'hex'))) {
          return res.status(400).send('signature mismatch');
        }
      } else {
        return res.status(400).send('signature missing');
      }
    }

    const evt = req.body || {};
    const isInvitee = evt.event === 'invitee.created' ||
                      (evt.payload && evt.payload.event_type);
    if (!isInvitee) return res.json({ received: true });

    const p = evt.payload || {};
    const email = String((p.email) || '').toLowerCase();
    const name = String(p.name || '');
    const eventName = (p.event && p.event.name) || (p.scheduled_event && p.scheduled_event.name) || 'discovery';
    const startTime = (p.event && p.event.start_time) ||
                      (p.scheduled_event && p.scheduled_event.start_time) ||
                      Date.now();
    const eventId = String(p.uri || (p.event && p.event.uuid) || (p.invitee && p.invitee.uri) || '');

    db.prepare(`
      INSERT OR IGNORE INTO bookings
        (calendly_event_id, email, name, type, scheduled_at, raw_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      email,
      name,
      /onboard/i.test(eventName) ? 'onboarding' : 'discovery',
      new Date(startTime).getTime() || Date.now(),
      JSON.stringify(p),
      Date.now()
    );

    let leadId = null;
    if (email) {
      const r = db.prepare('SELECT id, status FROM leads WHERE email = ? ORDER BY created_at DESC LIMIT 1').get(email);
      if (r) {
        leadId = r.id;
        if (r.status !== 'paid') {
          db.prepare("UPDATE leads SET status = 'booked' WHERE id = ?").run(r.id);
        }
      }
    }
    logEvent({
      lead_id: leadId,
      email,
      type: 'call_booked',
      detail: `${eventName} · ${new Date(startTime).toISOString()}`
    });

    res.json({ received: true });
  } catch (err) {
    console.error('Calendly webhook error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// ──────────────────────────────────────────────────────────────
// Admin auth — HTTP Basic
// ──────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.get('authorization');
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Algo Admin"');
    return res.status(401).send('Authentication required');
  }
  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  const user = idx >= 0 ? decoded.slice(0, idx) : '';
  const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
  const userOK = crypto.timingSafeEqual(
    Buffer.from((user || '').padEnd(64, '\0').slice(0, 64)),
    Buffer.from(ADMIN_USER.padEnd(64, '\0').slice(0, 64))
  );
  const passOK = crypto.timingSafeEqual(
    Buffer.from((pass || '').padEnd(128, '\0').slice(0, 128)),
    Buffer.from(ADMIN_PASS.padEnd(128, '\0').slice(0, 128))
  );
  if (userOK && passOK) return next();
  res.set('WWW-Authenticate', 'Basic realm="Algo Admin"');
  return res.status(401).send('Invalid credentials');
}

// ──────────────────────────────────────────────────────────────
// Admin endpoints
// ──────────────────────────────────────────────────────────────
app.get('/api/leads', requireAuth, (req, res) => {
  const { status, search, sort = 'created_at', dir = 'desc', limit = '300' } = req.query;
  let sql = 'SELECT * FROM leads WHERE 1=1';
  const params = [];
  if (status && status !== 'all') {
    sql += ' AND status = ?';
    params.push(String(status));
  }
  if (search) {
    sql += ' AND (name LIKE ? OR email LIKE ? OR phone LIKE ? OR notes LIKE ?)';
    const term = `%${String(search)}%`;
    params.push(term, term, term, term);
  }
  const allowedSort = ['created_at', 'name', 'email', 'status'];
  const sortCol = allowedSort.includes(String(sort)) ? sort : 'created_at';
  const sortDir = dir === 'asc' ? 'ASC' : 'DESC';
  sql += ` ORDER BY ${sortCol} ${sortDir} LIMIT ?`;
  params.push(Math.min(1000, Math.max(1, parseInt(String(limit), 10) || 300)));
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

app.get('/api/leads/:id', requireAuth, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  const payments = db.prepare('SELECT * FROM payments WHERE email = ? ORDER BY created_at DESC').all(lead.email);
  const bookings = db.prepare('SELECT * FROM bookings WHERE email = ? ORDER BY scheduled_at DESC').all(lead.email);
  const events = db.prepare(`
    SELECT * FROM events
    WHERE lead_id = ? OR (email != '' AND email = ?)
    ORDER BY created_at ASC
  `).all(lead.id, lead.email);
  res.json({ lead, payments, bookings, events });
});

app.patch('/api/leads/:id', requireAuth, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  const { notes, status } = req.body || {};
  const updates = [];
  const params = [];
  if (typeof notes === 'string') {
    updates.push('notes = ?');
    params.push(notes.slice(0, 5000));
  }
  if (typeof status === 'string') {
    const allowed = ['new', 'contacted', 'booked', 'paid', 'lost'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'invalid status' });
    updates.push('status = ?');
    params.push(status);
  }
  if (!updates.length) return res.status(400).json({ error: 'nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE leads SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  if (typeof status === 'string' && status !== lead.status) {
    logEvent({
      lead_id: lead.id, email: lead.email,
      type: 'status_changed', detail: `${lead.status} → ${status}`
    });
  }
  res.json({ ok: true });
});

app.delete('/api/leads/:id', requireAuth, (req, res) => {
  const lead = db.prepare('SELECT email FROM leads WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  if (lead && lead.email) {
    logEvent({
      lead_id: null, email: lead.email,
      type: 'lead_deleted', detail: `id=${req.params.id}`
    });
  }
  res.json({ ok: true });
});

app.get('/api/payments', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM payments ORDER BY created_at DESC LIMIT 500').all();
  res.json(rows);
});

app.get('/api/bookings', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM bookings ORDER BY scheduled_at DESC LIMIT 500').all();
  res.json(rows);
});

app.get('/api/stats', requireAuth, (req, res) => {
  const totalLeads = db.prepare('SELECT COUNT(*) c FROM leads').get().c;
  const totalPaid = db.prepare("SELECT COUNT(*) c FROM leads WHERE status = 'paid'").get().c;
  const totalBooked = db.prepare("SELECT COUNT(*) c FROM leads WHERE status IN ('booked', 'paid')").get().c;
  const totalLost = db.prepare("SELECT COUNT(*) c FROM leads WHERE status = 'lost'").get().c;
  const totalContacted = db.prepare("SELECT COUNT(*) c FROM leads WHERE status = 'contacted'").get().c;
  const dayMs = Date.now() - 24 * 60 * 60 * 1000;
  const weekMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const last24Leads = db.prepare('SELECT COUNT(*) c FROM leads WHERE created_at > ?').get(dayMs).c;
  const last24Paid = db.prepare('SELECT COUNT(*) c FROM payments WHERE created_at > ?').get(dayMs).c;
  const lastWeekLeads = db.prepare('SELECT COUNT(*) c FROM leads WHERE created_at > ?').get(weekMs).c;
  const totalRevenue = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) s FROM payments").get().s;
  const upcomingBookings = db.prepare('SELECT COUNT(*) c FROM bookings WHERE scheduled_at > ?').get(Date.now()).c;
  res.json({
    totalLeads, totalPaid, totalBooked, totalLost, totalContacted,
    last24Leads, last24Paid, lastWeekLeads,
    upcomingBookings,
    conversionRate: totalLeads ? +(totalPaid / totalLeads * 100).toFixed(1) : 0,
    totalRevenuePence: totalRevenue,
  });
});

app.get('/api/export.csv', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
  const headers = [
    'id', 'name', 'email', 'phone', 'account_size', 'risk_ack',
    'source', 'utm_source', 'utm_medium', 'utm_campaign',
    'status', 'notes', 'client_reference_id', 'created_at'
  ];
  const escape = v => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n\r]/.test(s) ? `"${s}"` : s;
  };
  let csv = headers.join(',') + '\n';
  for (const r of rows) {
    csv += headers.map(h => {
      if (h === 'created_at') return new Date(r[h]).toISOString();
      return escape(r[h]);
    }).join(',') + '\n';
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

// SAR / GDPR — a single buyer's full data record
app.get('/api/lead-data/:id', requireAuth, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  const payments = db.prepare('SELECT * FROM payments WHERE email = ?').all(lead.email);
  const bookings = db.prepare('SELECT * FROM bookings WHERE email = ?').all(lead.email);
  const events = db.prepare(`
    SELECT * FROM events WHERE lead_id = ? OR email = ? ORDER BY created_at ASC
  `).all(lead.id, lead.email);
  res.set('Content-Disposition', `attachment; filename="lead-${lead.id}-data.json"`);
  res.json({ lead, payments, bookings, events, exported_at: new Date().toISOString() });
});

// ──────────────────────────────────────────────────────────────
// Static admin UI (auth-gated)
// ──────────────────────────────────────────────────────────────
app.use('/', requireAuth, express.static(path.join(__dirname, 'public'), {
  maxAge: '0',
  etag: false
}));

// ──────────────────────────────────────────────────────────────
// Daily retention sweep (delete leads older than N days)
// ──────────────────────────────────────────────────────────────
function retentionSweep() {
  if (!LEAD_RETENTION_DAYS || LEAD_RETENTION_DAYS <= 0) return;
  const cutoff = Date.now() - LEAD_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const result = db.prepare('DELETE FROM leads WHERE created_at < ?').run(cutoff);
  if (result.changes > 0) {
    console.log(`Retention sweep: removed ${result.changes} leads older than ${LEAD_RETENTION_DAYS} days`);
  }
}
retentionSweep();
setInterval(retentionSweep, 24 * 60 * 60 * 1000);

// ──────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('───────────────────────────────────────────────');
  console.log(`Algo admin portal · http://localhost:${PORT}`);
  console.log(`Login:    ${ADMIN_USER} / ${ADMIN_PASS}`);
  console.log(`Database: ${path.join(dbDir, 'algo-admin.db')}`);
  console.log(`Stripe webhook secret: ${STRIPE_WEBHOOK_SECRET ? 'set' : 'NOT set (signature skipped)'}`);
  console.log(`Calendly webhook secret: ${CALENDLY_WEBHOOK_SECRET ? 'set' : 'NOT set (signature skipped)'}`);
  console.log(`Retention: ${LEAD_RETENTION_DAYS > 0 ? LEAD_RETENTION_DAYS + ' days' : 'disabled (keep forever)'}`);
  console.log('───────────────────────────────────────────────');
});
