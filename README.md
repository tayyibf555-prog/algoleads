# Algo by Excelsior · Admin Portal

Lightweight admin portal for the Algo by Excelsior trading product. Tracks every lead, payment, and discovery-call booking. Same brand language as the marketing site (black + antique gold).

Single-file Node.js server. SQLite database. Vanilla-JS frontend, no build step.

## Quick start

```bash
npm install
cp .env.example .env       # edit ADMIN_USER / ADMIN_PASS first
npm start                  # → http://localhost:4002
```

Open `http://localhost:4002`, log in with the credentials in your `.env` (default `admin / changeme`).

## What's inside

| Panel | What it shows |
|---|---|
| **Overview** | Today's leads, paid customers, conversion rate, lifetime revenue, upcoming calls, this-week leads, plus a funnel bar (new → contacted → booked → paid · lost). |
| **Leads** | Searchable table of every form submission. Filter chips (All / New / Contacted / Booked / Paid / Lost). Sort by name / email / status / submitted. Click any row → drawer with full detail. |
| **Lead detail drawer** | All fields, status updater, auto-saving notes, full activity timeline (form-fill → checkout → payment → booking), linked Stripe payments + Calendly bookings, **mailto** link with prefilled subject + body, **WhatsApp** link if phone is international, **download data (JSON)** for SAR requests, **delete** for GDPR removal. |
| **Payments** | Every Stripe `checkout.session.completed` event captured by the webhook. Email, amount, status, Stripe session ID (copy-to-clipboard), client reference ID, time received. |
| **Bookings** | Every Calendly `invitee.created` event. Name, email, type (discovery / onboarding), scheduled time, created time. |

Plus:

- **CSV export** — full leads dump from the top-bar button.
- **Auto-refresh** every 30 seconds on the active panel (paused while a drawer is open so you don't lose unsaved notes).
- **Click-to-copy** chips next to emails, Stripe session IDs, reference IDs.
- **Mobile-responsive** (the topbar tabs scroll horizontally; tables get horizontal scroll under 720px).
- **Reduced-motion** respect.

## Architecture

```
algo-admin-portal/
├── server.js              Express + SQLite, all endpoints in one file
├── package.json
├── .env.example           copy to .env, fill in ADMIN_PASS at minimum
├── db/
│   └── algo-admin.db      created on first run; WAL mode SQLite
└── public/
    ├── index.html         single-page admin UI
    ├── admin.css          black + gold, matches the marketing site
    └── admin.js           vanilla JS — no framework, no build
```

## API

### Public (CORS-enabled, no auth)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/leads` | Marketing-site form submission. Body: `{ name, email, phone?, account_size?, risk_ack?, client_reference_id?, utm_source?, utm_medium?, utm_campaign?, source? }` |
| `POST` | `/api/webhooks/stripe` | Stripe `checkout.session.completed` events. Verifies signature if `STRIPE_WEBHOOK_SECRET` is set in `.env`. |
| `POST` | `/api/webhooks/calendly` | Calendly `invitee.created` events. Verifies signature if `CALENDLY_WEBHOOK_SECRET` is set. |

### Admin (HTTP Basic Auth)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/leads?status=&search=&sort=&dir=&limit=` | List leads |
| `GET` | `/api/leads/:id` | Single lead with linked payments, bookings, events |
| `PATCH` | `/api/leads/:id` | Body: `{ notes?, status? }` (status ∈ `new, contacted, booked, paid, lost`) |
| `DELETE` | `/api/leads/:id` | GDPR delete |
| `GET` | `/api/payments` | Stripe payments (latest 500) |
| `GET` | `/api/bookings` | Calendly bookings (latest 500) |
| `GET` | `/api/stats` | Funnel summary |
| `GET` | `/api/export.csv` | Full leads export |
| `GET` | `/api/lead-data/:id` | Subject access record (JSON download — single lead's full record) |

## Wiring up the marketing site

Set this constant near the top of the marketing site's `<script>` block in `index.html`:

```js
const LEADS_API_URL = 'http://localhost:4002/api/leads';   // local
// or
const LEADS_API_URL = 'https://admin.algobyexcelsior.co.uk/api/leads';   // production
```

When the visitor fills the checkout form and clicks Next, the form data is sent to the admin via `navigator.sendBeacon` (fire-and-forget — never blocks the redirect to Stripe). The same `client_reference_id` is sent to both the admin and the Stripe Checkout URL, so the Stripe webhook can match the eventual payment back to the form submission.

If the constant is empty, no POST happens — the marketing site keeps working unchanged.

## Wiring up Stripe webhooks

1. In Stripe → Developers → Webhooks, create an endpoint pointing to:
   ```
   https://your-admin-domain/api/webhooks/stripe
   ```
   Subscribe to `checkout.session.completed` (and optionally `checkout.session.async_payment_succeeded`).
2. Copy the **Signing secret** (`whsec_...`) and paste into `.env` as `STRIPE_WEBHOOK_SECRET`.
3. Restart the admin server.

For local testing without a public URL, use the Stripe CLI:

```bash
stripe listen --forward-to localhost:4002/api/webhooks/stripe
# copy the displayed signing secret into .env, then:
stripe trigger checkout.session.completed
```

## Wiring up Calendly webhooks

1. Use the Calendly API to create a webhook subscription pointing at:
   ```
   https://your-admin-domain/api/webhooks/calendly
   ```
   Subscribe to the `invitee.created` event.
2. If you set a signing key when creating the subscription, paste it into `.env` as `CALENDLY_WEBHOOK_SECRET`.

## Deploying to production

This portal works fine on any host that runs Node 18+. Suggestions in order of simplicity:

- **Fly.io / Railway / Render** — `npm start` works as-is, mount a persistent volume on `/app/db` so the SQLite file survives restarts.
- **A small VPS** with `pm2 start server.js`, behind nginx with TLS via Let's Encrypt.
- **Vercel** — works for the Express app, but SQLite needs `/tmp` (ephemeral). Use Postgres or Turso instead. (Out of scope for v1.)

Whichever host you pick:

- Set `ADMIN_USER` and a long random `ADMIN_PASS` via env vars.
- Set `ALLOWED_ORIGINS=https://www.algobyexcelsior.co.uk` (or your real domain) so only the marketing site can POST leads.
- Set `STRIPE_WEBHOOK_SECRET` and `CALENDLY_WEBHOOK_SECRET` to enable signature verification.
- Decide on `LEAD_RETENTION_DAYS` for GDPR — `730` (two years) is a reasonable default; `0` disables auto-deletion.

## Compliance notes

- HTTP Basic Auth is **not encrypted in transit**. Always serve the portal over HTTPS in production.
- The portal stores PII (names, emails, phone numbers). Make sure your privacy policy on the marketing site mentions data is collected and how long it's kept.
- The `/api/lead-data/:id` endpoint produces a JSON record suitable for fulfilling a UK Subject Access Request.
- The DELETE endpoint hard-deletes the lead; payments and bookings keyed by email are kept (financial records) but no longer linked.

## Resetting

To wipe all data and start fresh:

```bash
rm db/algo-admin.db db/algo-admin.db-wal db/algo-admin.db-shm
npm start
```
