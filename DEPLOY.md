# Deploying to Vercel + Turso

Single deploy target: **Vercel** (admin function + static UI). Database: **Turso** (hosted libSQL — free tier covers this comfortably). Whole flow takes ~10 minutes the first time.

## What goes where

```
┌── Vercel ──────────────────────────────────────────┐
│  /                       → public/index.html       │
│  /admin.css, /admin.js   → public/* (CDN cached)   │
│  /api/*                  → api/index.js (function) │
└────────────────────────────────────────────────────┘
                          │
                          ▼
                ┌── Turso ──────┐
                │  libSQL DB    │  (hosted SQLite)
                └───────────────┘
```

## 1. Create the Turso database

```bash
brew install tursodatabase/tap/turso     # one-time
turso auth signup                         # browser opens, no card
turso db create algoleads                 # creates a hosted DB in lhr region
turso db show algoleads --url             # → libsql://algoleads-<you>.turso.io
turso db tokens create algoleads          # → eyJhbGc... (long token)
```

Copy both values aside — you'll paste them into Vercel in step 3.

## 2. Push to GitHub (already done)

Repo: https://github.com/tayyibf555-prog/algoleads

Vercel auto-deploys whenever you push to `main`.

## 3. Connect to Vercel

1. https://vercel.com/new
2. Import the `algoleads` repo
3. Framework preset: **Other** (Vercel will detect `vercel.json`)
4. Before clicking **Deploy**, add **Environment Variables**:

| Name | Value |
|---|---|
| `TURSO_DATABASE_URL` | the `libsql://…` URL from step 1 |
| `TURSO_AUTH_TOKEN` | the `eyJhbGc…` token from step 1 |
| `ADMIN_USER` | `admin` (or whatever username) |
| `ADMIN_PASS` | a strong random password |
| `ALLOWED_ORIGINS` | `*` for now, tighten later (e.g. `https://algobyexcelsior.vercel.app`) |

5. Click **Deploy**. ~60 seconds later your URL is live, e.g. `https://algoleads.vercel.app`.

## 4. Test

- Visit `https://algoleads.vercel.app/`
- Browser prompts for HTTP Basic Auth → use the credentials from step 3
- Overview panel loads (zeros across the board — fresh DB)

```bash
# also verify the public lead intake works:
curl -X POST https://algoleads.vercel.app/api/leads \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"test@example.com","risk_ack":true}'
# → {"ok":true,"id":1}
```

Refresh the admin → 1 lead appears.

## 5. Wire the marketing site

Update `LEADS_API_URL` in the marketing site's `index.html`:

```js
const LEADS_API_URL = 'https://algoleads.vercel.app/api/leads';
```

Push to GitHub → if the marketing site auto-deploys (Vercel/GitHub Pages), it goes live. Done.

## 6. Stripe webhook (when you have a Stripe Checkout link)

1. Stripe Dashboard → Developers → Webhooks → **Add endpoint**
2. Endpoint URL: `https://algoleads.vercel.app/api/webhooks/stripe`
3. Subscribe to `checkout.session.completed`
4. Copy the signing secret (`whsec_...`)
5. Vercel → Project → Settings → Environment Variables → add:
   - `STRIPE_WEBHOOK_SECRET` = `whsec_...`
6. Redeploy (push any commit, or use Vercel's "Redeploy" button)

## 7. Calendly webhook (optional)

Same pattern. Endpoint: `https://algoleads.vercel.app/api/webhooks/calendly`. Set `CALENDLY_WEBHOOK_SECRET` if you used a signing key.

## Custom domain

Vercel project → Settings → Domains → add your domain (e.g. `admin.algobyexcelsior.co.uk`). Vercel walks you through the DNS records and provisions TLS automatically.

After adding, update `ALLOWED_ORIGINS` to use the production marketing-site domain.

## Local dev

Local dev uses a SQLite file by default (no Turso needed):

```bash
cp .env.example .env
# (default TURSO_DATABASE_URL=file:db/algo-admin.db works as-is)
npm install
npm start
# → http://localhost:4002 — log in with admin / changeme
```

If you want to develop against the **same hosted Turso DB** as production, set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in `.env` to your production values.

## Backing up the production DB

```bash
turso db shell algoleads ".dump" > "backup-$(date +%Y%m%d).sql"
```

Restore by replaying the SQL into a fresh DB.

## Resetting

To wipe production data:

```bash
turso db shell algoleads "DELETE FROM leads; DELETE FROM payments; DELETE FROM bookings; DELETE FROM events;"
```

## If a deploy breaks

Vercel keeps every deploy. Roll back:
- Vercel project → Deployments → find the last working one → "Promote to Production"

Or check function logs:
- Vercel project → Logs → filter to your function

## Cost

- Vercel: free tier (Hobby plan) covers this comfortably — single user, low traffic.
- Turso: free tier — 9 GB storage, 1B row reads/month, 25M row writes/month. Plenty.
- Total monthly cost: **£0**.
