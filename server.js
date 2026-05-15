/**
 * Algo by Excelsior — admin portal API + static UI.
 *
 * Express app. Persistent storage via Turso (libSQL). Locally
 * defaults to a file:./db/algo-admin.db SQLite file; in production
 * set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN env vars.
 *
 * Public endpoints (CORS, no auth):
 *   POST  /api/leads
 *   POST  /api/webhooks/stripe
 *   POST  /api/webhooks/calendly
 *
 * Admin endpoints (HTTP Basic Auth):
 *   GET   /api/leads
 *   GET   /api/leads/:id
 *   PATCH /api/leads/:id
 *   DELETE /api/leads/:id
 *   GET   /api/payments
 *   GET   /api/bookings
 *   GET   /api/stats
 *   GET   /api/export.csv
 *   GET   /api/lead-data/:id
 *
 * Local mode (`node server.js`) also serves /public statically.
 * On Vercel, /public is served by Vercel's CDN automatically.
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const { run, get, all } = require('./lib/db');

const PORT = parseInt(process.env.PORT || '4002', 10);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const CALENDLY_WEBHOOK_SECRET = process.env.CALENDLY_WEBHOOK_SECRET || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
const LEAD_RETENTION_DAYS = parseInt(process.env.LEAD_RETENTION_DAYS || '0', 10);

// ──────────────────────────────────────────────────────────────
// App + middleware
// ──────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes('*')) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'));
  },
  credentials: false,
};
app.use(cors(corsOptions));

// Lightweight request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api/')) {
      const ms = Date.now() - start;
      const o = req.get('origin') || '-';
      console.log(
        `[${new Date().toISOString().slice(11, 19)}] ${req.method} ${req.path} ${res.statusCode} ${ms}ms origin=${o}`
      );
    }
  });
  next();
});

// Stripe webhook needs raw body BEFORE the JSON parser eats it.
app.post(
  '/api/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  handleStripeWebhook
);

app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true }));

// ──────────────────────────────────────────────────────────────
// Helper — log an event row (chronological per lead)
// ──────────────────────────────────────────────────────────────
async function logEvent({ lead_id = null, email = '', type, detail = '' }) {
  await run(
    'INSERT INTO events (lead_id, email, type, detail, created_at) VALUES (?, ?, ?, ?, ?)',
    [lead_id, email || '', type, detail, Date.now()]
  );
}

// ──────────────────────────────────────────────────────────────
// PUBLIC — Marketing-site lead intake
// ──────────────────────────────────────────────────────────────
app.post('/api/leads', async (req, res) => {
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
    const referrer = String(b.referrer || req.get('referer') || '').slice(0, 400);

    const result = await run(
      `INSERT INTO leads
        (name, email, phone, account_size, risk_ack, source, user_agent, referrer,
         utm_source, utm_medium, utm_campaign, client_reference_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name, email, phone, account_size, risk_ack, source, user_agent, referrer,
        utm_source, utm_medium, utm_campaign, client_reference_id, Date.now(),
      ]
    );

    await logEvent({
      lead_id: result.lastInsertRowid,
      email,
      type: 'form_submitted',
      detail: client_reference_id ? `ref=${client_reference_id}` : '',
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
  if (!secret) return true;
  if (!sigHeader) return false;
  const parts = Object.fromEntries(
    sigHeader.split(',').map((p) => p.split('=').map((s) => s.trim()))
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

async function handleStripeWebhook(req, res) {
  try {
    const sig = req.get('stripe-signature') || '';
    if (!verifyStripeSignature(req.body, sig, STRIPE_WEBHOOK_SECRET)) {
      console.warn('Stripe webhook: signature mismatch');
      return res.status(400).send('signature mismatch');
    }
    const event = JSON.parse(req.body.toString('utf8'));
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded'
    ) {
      const s = event.data.object || {};
      const email = String(
        s.customer_email || (s.customer_details && s.customer_details.email) || ''
      ).toLowerCase();
      const ref = String(s.client_reference_id || '');

      await run(
        `INSERT OR IGNORE INTO payments
          (stripe_session_id, email, amount_cents, currency, status, client_reference_id, raw_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          s.id || '',
          email,
          s.amount_total || 0,
          s.currency || 'gbp',
          s.payment_status || 'paid',
          ref,
          JSON.stringify(s),
          Date.now(),
        ]
      );

      let leadId = null;
      if (ref) {
        const r = await get('SELECT id FROM leads WHERE client_reference_id = ?', [ref]);
        if (r) leadId = r.id;
      }
      if (!leadId && email) {
        const r = await get(
          'SELECT id FROM leads WHERE email = ? ORDER BY created_at DESC LIMIT 1',
          [email]
        );
        if (r) leadId = r.id;
      }
      if (leadId) {
        await run("UPDATE leads SET status = 'paid' WHERE id = ?", [leadId]);
      }
      await logEvent({
        lead_id: leadId,
        email,
        type: 'payment_completed',
        detail: `${s.id} · ${(s.amount_total || 0) / 100} ${s.currency || 'gbp'}`,
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
app.post('/api/webhooks/calendly', async (req, res) => {
  try {
    if (CALENDLY_WEBHOOK_SECRET) {
      const raw = JSON.stringify(req.body);
      const sigHeader = req.get('calendly-webhook-signature') || '';
      const parts = Object.fromEntries(
        sigHeader.split(',').map((p) => p.split('=').map((s) => s.trim()))
      );
      if (parts.t && parts.v1) {
        const expected = crypto
          .createHmac('sha256', CALENDLY_WEBHOOK_SECRET)
          .update(`${parts.t}.${raw}`)
          .digest('hex');
        if (
          !crypto.timingSafeEqual(
            Buffer.from(parts.v1, 'hex'),
            Buffer.from(expected, 'hex')
          )
        ) {
          return res.status(400).send('signature mismatch');
        }
      } else {
        return res.status(400).send('signature missing');
      }
    }

    const evt = req.body || {};
    const isInvitee =
      evt.event === 'invitee.created' || (evt.payload && evt.payload.event_type);
    if (!isInvitee) return res.json({ received: true });

    const p = evt.payload || {};
    const email = String(p.email || '').toLowerCase();
    const name = String(p.name || '');
    const eventName =
      (p.event && p.event.name) ||
      (p.scheduled_event && p.scheduled_event.name) ||
      'discovery';
    const startTime =
      (p.event && p.event.start_time) ||
      (p.scheduled_event && p.scheduled_event.start_time) ||
      Date.now();
    const eventId = String(
      p.uri || (p.event && p.event.uuid) || (p.invitee && p.invitee.uri) || ''
    );

    await run(
      `INSERT OR IGNORE INTO bookings
        (calendly_event_id, email, name, type, scheduled_at, raw_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId,
        email,
        name,
        /onboard/i.test(eventName) ? 'onboarding' : 'discovery',
        new Date(startTime).getTime() || Date.now(),
        JSON.stringify(p),
        Date.now(),
      ]
    );

    let leadId = null;
    if (email) {
      const r = await get(
        'SELECT id, status FROM leads WHERE email = ? ORDER BY created_at DESC LIMIT 1',
        [email]
      );
      if (r) {
        leadId = r.id;
        if (r.status !== 'paid') {
          await run("UPDATE leads SET status = 'booked' WHERE id = ?", [r.id]);
        }
      }
    }
    await logEvent({
      lead_id: leadId,
      email,
      type: 'call_booked',
      detail: `${eventName} · ${new Date(startTime).toISOString()}`,
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
// Auth middleware. Returns 401 WITHOUT the WWW-Authenticate header
// so the browser does NOT show its native Basic-Auth prompt — the
// frontend renders our branded sign-in screen instead and supplies
// the Authorization header manually after the user logs in.
function requireAuth(req, res, next) {
  const auth = req.get('authorization');
  if (!auth || !auth.startsWith('Basic ')) {
    return res.status(401).json({ error: 'authentication required' });
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
  return res.status(401).json({ error: 'invalid credentials' });
}

// ──────────────────────────────────────────────────────────────
// Admin endpoints
// ──────────────────────────────────────────────────────────────
app.get('/api/leads', requireAuth, async (req, res) => {
  try {
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
    const rows = await all(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/leads', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/leads/:id', requireAuth, async (req, res) => {
  try {
    const lead = await get('SELECT * FROM leads WHERE id = ?', [req.params.id]);
    if (!lead) return res.status(404).json({ error: 'not found' });
    const payments = await all(
      'SELECT * FROM payments WHERE email = ? ORDER BY created_at DESC',
      [lead.email]
    );
    const bookings = await all(
      'SELECT * FROM bookings WHERE email = ? ORDER BY scheduled_at DESC',
      [lead.email]
    );
    const events = await all(
      `SELECT * FROM events
       WHERE lead_id = ? OR (email != '' AND email = ?)
       ORDER BY created_at ASC`,
      [lead.id, lead.email]
    );
    res.json({ lead, payments, bookings, events });
  } catch (err) {
    console.error('GET /api/leads/:id', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.patch('/api/leads/:id', requireAuth, async (req, res) => {
  try {
    const lead = await get('SELECT * FROM leads WHERE id = ?', [req.params.id]);
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
    await run(`UPDATE leads SET ${updates.join(', ')} WHERE id = ?`, params);
    if (typeof status === 'string' && status !== lead.status) {
      await logEvent({
        lead_id: lead.id,
        email: lead.email,
        type: 'status_changed',
        detail: `${lead.status} → ${status}`,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /api/leads/:id', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.delete('/api/leads/:id', requireAuth, async (req, res) => {
  try {
    const lead = await get('SELECT email FROM leads WHERE id = ?', [req.params.id]);
    await run('DELETE FROM leads WHERE id = ?', [req.params.id]);
    if (lead && lead.email) {
      await logEvent({
        lead_id: null,
        email: lead.email,
        type: 'lead_deleted',
        detail: `id=${req.params.id}`,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/leads/:id', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/payments', requireAuth, async (req, res) => {
  try {
    const rows = await all('SELECT * FROM payments ORDER BY created_at DESC LIMIT 500');
    res.json(rows);
  } catch (err) {
    console.error('GET /api/payments', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/bookings', requireAuth, async (req, res) => {
  try {
    const rows = await all('SELECT * FROM bookings ORDER BY scheduled_at DESC LIMIT 500');
    res.json(rows);
  } catch (err) {
    console.error('GET /api/bookings', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// ──────────────────────────────────────────────────────────────
// Members — read-only window into the member portal's members
// table. The admin never writes here. password_hash is never
// returned. Each row is enriched with lead/payment/booking counts
// (joined by email) so the admin can tell at a glance who's a
// paying customer vs a member who hasn't paid yet.
// ──────────────────────────────────────────────────────────────
app.get('/api/members', requireAuth, async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    let where = '';
    const params = [];
    if (search) {
      where = `WHERE m.email LIKE ? OR m.name LIKE ?`;
      params.push(`%${search}%`, `%${search}%`);
    }
    // password_hash is intentionally excluded.
    // bd.* fields come from the member_broker_details table (the
    // member-portal-owned table) via LEFT JOIN. Members without
    // submitted broker details have NULLs for these fields.
    const rows = await all(
      `SELECT
         m.id,
         m.email,
         m.name,
         m.created_at,
         m.last_login_at,
         (SELECT COUNT(*) FROM leads    WHERE leads.email    = m.email) AS leads_count,
         (SELECT COUNT(*) FROM payments WHERE payments.email = m.email) AS payments_count,
         (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE payments.email = m.email) AS paid_pence,
         (SELECT COUNT(*) FROM bookings WHERE bookings.email = m.email) AS bookings_count,
         (SELECT MAX(scheduled_at) FROM bookings WHERE bookings.email = m.email) AS next_booking_at,
         bd.broker_name         AS broker_name,
         bd.account_number      AS broker_account_number,
         bd.account_type        AS broker_account_type,
         bd.account_size        AS broker_account_size,
         bd.notes               AS broker_notes,
         bd.submitted_at        AS broker_submitted_at,
         bd.updated_at          AS broker_updated_at
       FROM members m
       LEFT JOIN member_broker_details bd ON bd.member_id = m.id
       ${where}
       ORDER BY m.created_at DESC
       LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) {
    // If the members table doesn't exist yet (admin local DB never
    // saw a member-portal write) the schema migrate already created
    // it; this catch is a final safety net.
    if (String(err && err.message).match(/no such table: members/i)) {
      return res.json([]);
    }
    console.error('GET /api/members', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// ──────────────────────────────────────────────────────────────
// Announcements — the ONLY admin↔member shared surface. Admin
// writes here; the member portal reads via its own
// GET /api/announcements (no admin auth there, just the member's
// session cookie). Pinned announcements appear at the top of the
// member's list.
// ──────────────────────────────────────────────────────────────
app.get('/api/announcements', requireAuth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT * FROM announcements
       ORDER BY pinned DESC, published_at DESC
       LIMIT 500`
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/announcements', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/announcements', requireAuth, async (req, res) => {
  try {
    const title = String(req.body?.title || '').trim();
    const body  = String(req.body?.body  || '').trim();
    const pinned = req.body?.pinned ? 1 : 0;
    if (!title || !body) {
      return res.status(400).json({ error: 'title and body are required' });
    }
    if (title.length > 160) {
      return res.status(400).json({ error: 'title must be 160 characters or fewer' });
    }
    if (body.length > 4000) {
      return res.status(400).json({ error: 'body must be 4000 characters or fewer' });
    }
    const now = Date.now();
    const result = await run(
      `INSERT INTO announcements (title, body, pinned, published_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [title, body, pinned, now, now]
    );
    const row = await get('SELECT * FROM announcements WHERE id = ?', [result.lastInsertRowid]);
    res.json(row);
  } catch (err) {
    console.error('POST /api/announcements', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.patch('/api/announcements/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const existing = await get('SELECT * FROM announcements WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'not found' });

    const fields = [];
    const args = [];
    if (typeof req.body?.title === 'string') {
      const t = req.body.title.trim();
      if (!t) return res.status(400).json({ error: 'title cannot be empty' });
      if (t.length > 160) return res.status(400).json({ error: 'title too long' });
      fields.push('title = ?'); args.push(t);
    }
    if (typeof req.body?.body === 'string') {
      const b = req.body.body.trim();
      if (!b) return res.status(400).json({ error: 'body cannot be empty' });
      if (b.length > 4000) return res.status(400).json({ error: 'body too long' });
      fields.push('body = ?'); args.push(b);
    }
    if (typeof req.body?.pinned !== 'undefined') {
      fields.push('pinned = ?'); args.push(req.body.pinned ? 1 : 0);
    }
    if (!fields.length) return res.json(existing);
    args.push(id);
    await run(`UPDATE announcements SET ${fields.join(', ')} WHERE id = ?`, args);
    const row = await get('SELECT * FROM announcements WHERE id = ?', [id]);
    res.json(row);
  } catch (err) {
    console.error('PATCH /api/announcements/:id', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.delete('/api/announcements/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const result = await run('DELETE FROM announcements WHERE id = ?', [id]);
    if (!result.changes) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('DELETE /api/announcements/:id', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// ──────────────────────────────────────────────────────────────
// Overview — the dashboardUI redesign target.
//
// Returns one cohesive payload powering the Overview tab:
//   - pulse:         Pipeline Pulse score (0-100) + 14-day history
//                    + per-component breakdown (leads/bookings/payments)
//   - daysToPaid:    rolling avg days from lead creation → payment
//   - insight:       single rule-based observation (priority sorted)
//   - todaysThree:   1-3 concrete actions for the founder today
//   - equityCurve:   cumulative paid revenue over time
//
// All of this is derived from the existing tables (leads, payments,
// bookings, announcements, members). No new schema needed.
// ──────────────────────────────────────────────────────────────
const PULSE_TARGETS = {
  // Calibrated for a founder-stage business. Hitting all three weekly
  // targets yields Pulse = 100. Half = 50. Adjust as the business
  // grows.
  leadsPerWeek:    10,
  bookingsPerWeek:  5,
  paymentsPerWeek:  3,
};

function calcPulse({ leads, bookings, payments }) {
  const ls = Math.min(40, Math.round(40 * (leads    / PULSE_TARGETS.leadsPerWeek)));
  const bs = Math.min(35, Math.round(35 * (bookings / PULSE_TARGETS.bookingsPerWeek)));
  const ps = Math.min(25, Math.round(25 * (payments / PULSE_TARGETS.paymentsPerWeek)));
  return { score: ls + bs + ps, leads: ls, bookings: bs, payments: ps };
}

async function safeCount(sql, args) {
  try { const r = await get(sql, args); return r ? Number(r.c || 0) : 0; }
  catch (_) { return 0; }
}

async function safeAll(sql, args) {
  try { return await all(sql, args); } catch (_) { return []; }
}

async function generateInsight(now) {
  const day = 24 * 60 * 60 * 1000;
  const week = 7 * day;

  const leadsThisWeek = await safeCount('SELECT COUNT(*) c FROM leads WHERE created_at > ?', [now - week]);
  const leadsLastWeek = await safeCount('SELECT COUNT(*) c FROM leads WHERE created_at > ? AND created_at <= ?', [now - 2*week, now - week]);
  const bookingsThisWeek = await safeCount('SELECT COUNT(*) c FROM bookings WHERE created_at > ?', [now - week]);
  const bookingsLastWeek = await safeCount('SELECT COUNT(*) c FROM bookings WHERE created_at > ? AND created_at <= ?', [now - 2*week, now - week]);
  const paymentsThisWeek = await safeCount('SELECT COUNT(*) c FROM payments WHERE created_at > ?', [now - week]);

  const uncontacted = await safeAll(
    `SELECT id, name, email, created_at FROM leads
       WHERE status = 'new' AND created_at < ?
       ORDER BY created_at ASC LIMIT 5`,
    [now - day]
  );

  const paidNoBooking = await safeAll(
    `SELECT DISTINCT p.email, MIN(p.created_at) AS paid_at
       FROM payments p
       LEFT JOIN bookings b ON b.email = p.email
       WHERE p.status = 'paid' AND b.id IS NULL AND p.created_at > ?
       GROUP BY p.email`,
    [now - 30 * day]
  );

  const lastAnn = await get('SELECT MAX(published_at) ts FROM announcements').catch(() => null);
  const daysSinceAnn = (lastAnn && lastAnn.ts) ? Math.floor((now - lastAnn.ts) / day) : null;

  // Rule priority — most action-needing first
  if (paidNoBooking.length) {
    const n = paidNoBooking.length;
    return {
      text: `${n} paid customer${n > 1 ? "s haven't" : " hasn't"} booked an onboarding call yet. Reach out before they go cold.`,
      actionLabel: 'Open payments',
      actionTab: 'payments',
    };
  }
  if (uncontacted.length >= 2) {
    const oldest = uncontacted[0];
    const days = Math.max(1, Math.floor((now - oldest.created_at) / day));
    const who = (oldest.name || oldest.email || 'a lead').split(' ')[0];
    return {
      text: `${uncontacted.length} leads from the last week haven't been contacted. The oldest, ${who}, has been waiting ${days} day${days !== 1 ? 's' : ''}.`,
      actionLabel: 'Open leads',
      actionTab: 'leads',
    };
  }
  // Booking-rate drop (only if there's enough lead volume to be meaningful)
  if (leadsThisWeek >= 3 && leadsLastWeek >= 3) {
    const thisRate = bookingsThisWeek / leadsThisWeek;
    const lastRate = bookingsLastWeek / leadsLastWeek;
    if (lastRate > 0 && thisRate < lastRate * 0.7) {
      const dropPct = Math.round((1 - thisRate / lastRate) * 100);
      return {
        text: `Lead-to-booking conversion dropped ${dropPct}% this week. Forms are filling but calls aren't booking.`,
        actionLabel: 'Open bookings',
        actionTab: 'bookings',
      };
    }
  }
  if (daysSinceAnn !== null && daysSinceAnn > 7) {
    return {
      text: `Last member announcement was ${daysSinceAnn} days ago. A weekly cadence keeps members engaged on the portal.`,
      actionLabel: 'Open announcements',
      actionTab: 'announcements',
    };
  }
  if (daysSinceAnn === null) {
    return {
      text: `No announcements published yet. Members see this on every login, the first one anchors the cadence.`,
      actionLabel: 'Open announcements',
      actionTab: 'announcements',
    };
  }

  // Steady-state default
  if (leadsThisWeek === 0 && paymentsThisWeek === 0) {
    return {
      text: `Quiet week. No new leads or payments yet. Time to push outbound or refresh the lead-magnet copy.`,
      actionLabel: 'Open leads',
      actionTab: 'leads',
    };
  }
  return {
    text: `Steady week. ${leadsThisWeek} new lead${leadsThisWeek !== 1 ? 's' : ''}, ${bookingsThisWeek} booking${bookingsThisWeek !== 1 ? 's' : ''}, ${paymentsThisWeek} payment${paymentsThisWeek !== 1 ? 's' : ''}.`,
    actionLabel: 'Open leads',
    actionTab: 'leads',
  };
}

async function generateTodaysThree(now) {
  const day = 24 * 60 * 60 * 1000;
  const tasks = [];

  // Task 1: oldest uncontacted lead
  const oldLead = await get(
    `SELECT id, name, email, created_at FROM leads
      WHERE status = 'new' AND created_at < ?
      ORDER BY created_at ASC LIMIT 1`,
    [now - day]
  ).catch(() => null);
  if (oldLead) {
    const days = Math.max(1, Math.floor((now - oldLead.created_at) / day));
    tasks.push({
      action: `Reply to ${oldLead.name || oldLead.email}`,
      evidence: `submitted ${days} day${days !== 1 ? 's' : ''} ago, no reply logged`,
      tab: 'leads',
    });
  }

  // Task 2: most recent paid customer without a booking
  const paidNoBooking = await get(
    `SELECT p.email, p.created_at FROM payments p
      WHERE p.status = 'paid'
        AND p.email NOT IN (SELECT email FROM bookings WHERE email IS NOT NULL)
      ORDER BY p.created_at DESC LIMIT 1`
  ).catch(() => null);
  if (paidNoBooking && paidNoBooking.email) {
    const hours = Math.max(1, Math.floor((now - paidNoBooking.created_at) / (60 * 60 * 1000)));
    const since = hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
    tasks.push({
      action: `Confirm onboarding with ${paidNoBooking.email}`,
      evidence: `paid ${since}, no booking yet`,
      tab: 'payments',
    });
  }

  // Task 3: publish an announcement if stale
  const lastAnn = await get('SELECT MAX(published_at) ts FROM announcements').catch(() => null);
  const annTs = lastAnn && lastAnn.ts;
  if (!annTs) {
    tasks.push({
      action: 'Publish your first announcement',
      evidence: 'members see this on login',
      tab: 'announcements',
    });
  } else {
    const days = Math.floor((now - annTs) / day);
    if (days > 7) {
      tasks.push({
        action: 'Publish a weekly update',
        evidence: `last announcement was ${days} days ago`,
        tab: 'announcements',
      });
    }
  }

  // Pad to three with a member-investigate task if we have headroom
  if (tasks.length < 3) {
    const signup = await get(
      `SELECT m.email, m.name, m.created_at FROM members m
        WHERE m.email NOT IN (SELECT email FROM leads WHERE email != '')
        ORDER BY m.created_at DESC LIMIT 1`
    ).catch(() => null);
    if (signup && signup.email) {
      tasks.push({
        action: `Investigate ${signup.email}`,
        evidence: 'member signup without matching lead',
        tab: 'members',
      });
    }
  }

  // Final fallback so the card never renders empty
  if (!tasks.length) {
    tasks.push({
      action: 'Review today\'s lead inflow',
      evidence: 'no urgent items detected, sweep the funnel',
      tab: 'leads',
    });
  }

  return tasks.slice(0, 3);
}

app.get('/api/overview', requireAuth, async (req, res) => {
  try {
    const now = Date.now();
    const day  = 24 * 60 * 60 * 1000;
    const week = 7 * day;

    // Current Pulse window
    const leadsLast7d    = await safeCount('SELECT COUNT(*) c FROM leads WHERE created_at > ?', [now - week]);
    const bookingsNext7d = await safeCount('SELECT COUNT(*) c FROM bookings WHERE scheduled_at > ? AND scheduled_at <= ?', [now, now + week]);
    const paymentsLast7d = await safeCount("SELECT COUNT(*) c FROM payments WHERE status = 'paid' AND created_at > ?", [now - week]);

    const pulse = calcPulse({ leads: leadsLast7d, bookings: bookingsNext7d, payments: paymentsLast7d });

    // 14-day history — recompute Pulse for each daily snapshot.
    // Small data, so the loop is cheap; revisit if leads ever spike.
    const history = [];
    for (let d = 13; d >= 0; d--) {
      const t = now - d * day;
      const l = await safeCount('SELECT COUNT(*) c FROM leads WHERE created_at > ? AND created_at <= ?', [t - week, t]);
      const b = await safeCount('SELECT COUNT(*) c FROM bookings WHERE scheduled_at > ? AND scheduled_at <= ?', [t, t + week]);
      const p = await safeCount("SELECT COUNT(*) c FROM payments WHERE status = 'paid' AND created_at > ? AND created_at <= ?", [t - week, t]);
      history.push(calcPulse({ leads: l, bookings: b, payments: p }).score);
    }

    // Days-to-paid: avg lead-creation → first-payment for the last 60 days
    const conversions = await safeAll(
      `SELECT l.created_at AS lead_at, MIN(p.created_at) AS paid_at
         FROM leads l
         JOIN payments p ON p.email = l.email AND p.status = 'paid'
         WHERE p.created_at > ?
         GROUP BY l.id
         HAVING paid_at >= lead_at`,
      [now - 60 * day]
    );
    const daysToPaid = conversions.length
      ? +(conversions.reduce((s, r) => s + (r.paid_at - r.lead_at), 0) / conversions.length / day).toFixed(1)
      : null;

    // Equity curve — cumulative paid revenue over time
    const payments = await safeAll(
      "SELECT created_at, amount_cents FROM payments WHERE status = 'paid' ORDER BY created_at ASC LIMIT 500"
    );
    let cum = 0;
    const equityCurve = payments.map((p) => {
      cum += Number(p.amount_cents || 0);
      return { t: p.created_at, v: cum };
    });

    // Insight + today's three
    const [insight, todaysThree] = await Promise.all([
      generateInsight(now),
      generateTodaysThree(now),
    ]);

    res.json({
      generated_at: now,
      pulse: { ...pulse, history },
      daysToPaid,
      equityCurve,
      insight,
      todaysThree,
      // Bare numbers kept for any code still hitting this for sanity
      leadsLast7d,
      bookingsNext7d,
      paymentsLast7d,
      currency: 'gbp',
    });
  } catch (err) {
    console.error('GET /api/overview', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const dayMs = Date.now() - 24 * 60 * 60 * 1000;
    const weekMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const totalLeads = (await get('SELECT COUNT(*) c FROM leads')).c;
    const totalPaid = (await get("SELECT COUNT(*) c FROM leads WHERE status = 'paid'")).c;
    const totalBooked = (await get("SELECT COUNT(*) c FROM leads WHERE status IN ('booked', 'paid')")).c;
    const totalLost = (await get("SELECT COUNT(*) c FROM leads WHERE status = 'lost'")).c;
    const totalContacted = (await get("SELECT COUNT(*) c FROM leads WHERE status = 'contacted'")).c;
    const last24Leads = (await get('SELECT COUNT(*) c FROM leads WHERE created_at > ?', [dayMs])).c;
    const last24Paid = (await get('SELECT COUNT(*) c FROM payments WHERE created_at > ?', [dayMs])).c;
    const lastWeekLeads = (await get('SELECT COUNT(*) c FROM leads WHERE created_at > ?', [weekMs])).c;
    const totalRevenue = (await get('SELECT COALESCE(SUM(amount_cents), 0) s FROM payments')).s;
    const upcomingBookings = (await get('SELECT COUNT(*) c FROM bookings WHERE scheduled_at > ?', [Date.now()])).c;
    res.json({
      totalLeads, totalPaid, totalBooked, totalLost, totalContacted,
      last24Leads, last24Paid, lastWeekLeads,
      upcomingBookings,
      conversionRate: totalLeads ? +((totalPaid / totalLeads) * 100).toFixed(1) : 0,
      totalRevenuePence: totalRevenue,
    });
  } catch (err) {
    console.error('GET /api/stats', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/export.csv', requireAuth, async (req, res) => {
  try {
    const rows = await all('SELECT * FROM leads ORDER BY created_at DESC');
    const headers = [
      'id', 'name', 'email', 'phone', 'account_size', 'risk_ack',
      'source', 'utm_source', 'utm_medium', 'utm_campaign',
      'status', 'notes', 'client_reference_id', 'created_at',
    ];
    const escape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n\r]/.test(s) ? `"${s}"` : s;
    };
    let csv = headers.join(',') + '\n';
    for (const r of rows) {
      csv += headers
        .map((h) => (h === 'created_at' ? new Date(r[h]).toISOString() : escape(r[h])))
        .join(',') + '\n';
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set(
      'Content-Disposition',
      `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`
    );
    res.send(csv);
  } catch (err) {
    console.error('GET /api/export.csv', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/lead-data/:id', requireAuth, async (req, res) => {
  try {
    const lead = await get('SELECT * FROM leads WHERE id = ?', [req.params.id]);
    if (!lead) return res.status(404).json({ error: 'not found' });
    const payments = await all('SELECT * FROM payments WHERE email = ?', [lead.email]);
    const bookings = await all('SELECT * FROM bookings WHERE email = ?', [lead.email]);
    const events = await all(
      'SELECT * FROM events WHERE lead_id = ? OR email = ? ORDER BY created_at ASC',
      [lead.id, lead.email]
    );
    res.set('Content-Disposition', `attachment; filename="lead-${lead.id}-data.json"`);
    res.json({ lead, payments, bookings, events, exported_at: new Date().toISOString() });
  } catch (err) {
    console.error('GET /api/lead-data/:id', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Healthcheck — useful in production for uptime monitoring
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// On Vercel the static admin UI lives in /public, but Vercel's
// auto-static-serving doesn't resolve `/` → `/index.html` for an
// Express-detected project. Redirect it explicitly.
app.get('/', (req, res) => res.redirect(302, '/index.html'));

// ──────────────────────────────────────────────────────────────
// Local mode only — static UI + retention sweep + listen()
// On Vercel, /public is served by Vercel's CDN automatically
// (so the auth-gated express.static block is skipped).
// ──────────────────────────────────────────────────────────────
if (require.main === module) {
  // Static admin UI — no auth gate on the static files. The login
  // screen (rendered by index.html → admin.js) handles auth, and
  // every /api/* request is still gated by requireAuth.
  app.use('/', express.static(path.join(__dirname, 'public'), {
    maxAge: '0',
    etag: false,
  }));

  if (LEAD_RETENTION_DAYS > 0) {
    const sweep = async () => {
      try {
        const cutoff = Date.now() - LEAD_RETENTION_DAYS * 24 * 60 * 60 * 1000;
        const result = await run('DELETE FROM leads WHERE created_at < ?', [cutoff]);
        if (result.changes > 0) {
          console.log(`Retention sweep: removed ${result.changes} leads`);
        }
      } catch (err) {
        console.error('Retention sweep error', err);
      }
    };
    sweep();
    setInterval(sweep, 24 * 60 * 60 * 1000);
  }

  app.listen(PORT, () => {
    console.log('───────────────────────────────────────────────');
    console.log(`Algo admin portal · http://localhost:${PORT}`);
    console.log(`Login:    ${ADMIN_USER} / ${ADMIN_PASS}`);
    console.log(`DB URL:   ${process.env.TURSO_DATABASE_URL || 'file:db/algo-admin.db'}`);
    console.log(`Stripe webhook secret: ${STRIPE_WEBHOOK_SECRET ? 'set' : 'NOT set'}`);
    console.log(`Calendly webhook secret: ${CALENDLY_WEBHOOK_SECRET ? 'set' : 'NOT set'}`);
    console.log('───────────────────────────────────────────────');
  });
}

// Vercel imports this module and uses the exported app as a request handler.
module.exports = app;
