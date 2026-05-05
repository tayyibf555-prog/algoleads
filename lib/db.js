/**
 * lib/db.js — Turso (libSQL) client + schema setup.
 *
 * Locally:    TURSO_DATABASE_URL=file:db/algo-admin.db (default)
 * On Vercel:  TURSO_DATABASE_URL=libsql://your-db.turso.io
 *             TURSO_AUTH_TOKEN=eyJhbGc...
 *
 * The schema is identical to the previous SQLite version — libSQL
 * IS SQLite, just over HTTP for the hosted variant.
 *
 * Helpers (run / get / all) mirror the better-sqlite3 API but are
 * async, so existing routes only need a `await` in front of each call.
 */

const { createClient } = require('@libsql/client');

const SCHEMA = [
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
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_email ON events(email)`,
  `CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at)`,

  // ──────────────────────────────────────────────────────────────
  // Announcements — the ONLY table the admin and member portals
  // share writes/reads on. Admin writes (this portal). Member portal
  // only reads. Same DDL as the member portal's lib/db.js so the
  // CREATE IF NOT EXISTS is a no-op when the member portal already
  // ran first. Don't add columns here without mirroring there.
  // ──────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    pinned INTEGER DEFAULT 0,
    published_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_announcements_published ON announcements(published_at)`,
];

let _client = null;
let _initPromise = null;

function _resolveConfig() {
  const url = process.env.TURSO_DATABASE_URL || 'file:db/algo-admin.db';
  const authToken = process.env.TURSO_AUTH_TOKEN || undefined;
  return { url, authToken };
}

function _newClient() {
  const { url, authToken } = _resolveConfig();
  // intMode: 'number' returns plain JS Numbers for integers that fit
  // safely (well within our id/timestamp ranges). Avoids BigInt
  // serialization headaches when JSON-encoding rows.
  return createClient({ url, authToken, intMode: 'number' });
}

async function _initSchema(client) {
  for (const stmt of SCHEMA) {
    await client.execute(stmt);
  }
}

function getClient() {
  if (!_client) _client = _newClient();
  return _client;
}

async function ready() {
  if (_initPromise) return _initPromise;
  const client = getClient();
  _initPromise = _initSchema(client).catch((err) => {
    // Reset so a future request can retry (transient failure)
    _initPromise = null;
    throw err;
  });
  return _initPromise;
}

// ──────────────────────────────────────────────────────────────
// Helpers — mirror better-sqlite3 API but async
// ──────────────────────────────────────────────────────────────

// Convert a libsql Row (array-like + named props) into a plain
// POJO so JSON.stringify produces { col: val } rather than [val].
function _rowToObject(row, columns) {
  const out = {};
  for (let i = 0; i < columns.length; i++) {
    out[columns[i]] = row[i];
  }
  return out;
}

async function run(sql, args = []) {
  await ready();
  const client = getClient();
  const result = await client.execute({ sql, args });
  return {
    lastInsertRowid:
      result.lastInsertRowid != null ? Number(result.lastInsertRowid) : null,
    changes: result.rowsAffected,
  };
}

async function get(sql, args = []) {
  await ready();
  const client = getClient();
  const result = await client.execute({ sql, args });
  if (!result.rows.length) return null;
  return _rowToObject(result.rows[0], result.columns);
}

async function all(sql, args = []) {
  await ready();
  const client = getClient();
  const result = await client.execute({ sql, args });
  return result.rows.map((r) => _rowToObject(r, result.columns));
}

module.exports = { ready, run, get, all, getClient };
