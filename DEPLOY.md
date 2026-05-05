# Deploying the admin portal

Single deploy target: **Fly.io**. Free, persistent SQLite, auto-TLS, London region. Whole flow takes ~15 minutes the first time.

## One-time setup

### 1. Install flyctl

**macOS:**
```bash
brew install flyctl
```

Other OSes: https://fly.io/docs/hands-on/install-flyctl/

### 2. Sign up for Fly

```bash
fly auth signup
```

Browser opens. **No credit card is required for the free tier.** A Fly account gives you 3 small VMs and 3 GB of persistent volumes free forever.

If you already have an account: `fly auth login`.

## Deploy

From the `algo-admin-portal/` folder:

### 3. Initialise the app (once)

```bash
fly launch --no-deploy
```

When prompted:
- **Use existing fly.toml?** → Yes
- **App name** → accept default (`algo-admin-portal`) or pick your own
- **Region** → `lhr` (London)
- **Postgres?** → No
- **Redis?** → No
- **Tigris?** → No

(If the app name `algo-admin-portal` is taken, Fly will suggest one with a suffix. Note it down — you'll need it.)

### 4. Create the persistent volume

```bash
fly volumes create algo_admin_data --region lhr --size 1
```

1 GB SQLite holds tens of thousands of leads. Free tier covers up to 3 GB total.

### 5. Set your admin password and CORS origin

Replace `<long-random-password>` with something serious — this is the only thing protecting the portal:

```bash
fly secrets set \
  ADMIN_USER=admin \
  ADMIN_PASS='<long-random-password>' \
  ALLOWED_ORIGINS='*'
```

You can tighten `ALLOWED_ORIGINS` later, e.g.:
```bash
fly secrets set ALLOWED_ORIGINS='https://tayyibf555-prog.github.io,https://www.algobyexcelsior.co.uk'
```

### 6. Deploy

```bash
fly deploy
```

Takes ~60 seconds the first time. The output shows your URL — typically `https://algo-admin-portal.fly.dev` (or whatever name you picked in step 3).

### 7. Test

Open the URL in a browser. Log in with `admin / <your password>`. The Overview tab loads — you're live.

## Wire the marketing site

Once the admin URL is live, update `LEADS_API_URL` in the marketing site's `index.html`:

```js
const LEADS_API_URL = 'https://algo-admin-portal.fly.dev/api/leads';
```

Push to GitHub. If the marketing site is on GitHub Pages, it redeploys in ~30 seconds.

Now form submissions on the marketing site land in the admin in real time.

## Stripe webhook (whenever Stripe is wired up)

1. Stripe Dashboard → Developers → Webhooks → **Add endpoint**
2. Endpoint URL: `https://algo-admin-portal.fly.dev/api/webhooks/stripe`
3. Events to send: `checkout.session.completed` (and optionally `checkout.session.async_payment_succeeded`)
4. Copy the signing secret (`whsec_...`)
5. Set it on Fly:
   ```bash
   fly secrets set STRIPE_WEBHOOK_SECRET='whsec_...'
   ```

Test with the Stripe CLI:
```bash
stripe listen --forward-to https://algo-admin-portal.fly.dev/api/webhooks/stripe
stripe trigger checkout.session.completed
```

A test payment should appear in the admin's **Payments** panel within seconds.

## Calendly webhook (optional)

Same pattern — point Calendly at `https://algo-admin-portal.fly.dev/api/webhooks/calendly`, set `CALENDLY_WEBHOOK_SECRET` if you used a signing key.

## Subsequent deploys

Just:
```bash
fly deploy
```

Takes ~30 seconds. The persistent volume is preserved across deploys.

## Custom domain (later)

When you own `algobyexcelsior.co.uk`:

```bash
fly certs add admin.algobyexcelsior.co.uk
```

Fly prints the DNS records to add — typically a CNAME pointing `admin.algobyexcelsior.co.uk` → `algo-admin-portal.fly.dev`. Set that at your DNS provider, wait a few minutes, and Fly provisions Let's Encrypt TLS automatically.

Then update `LEADS_API_URL` and `ALLOWED_ORIGINS`.

## Backup

The SQLite file is at `/app/db/algo-admin.db` inside the Fly machine. To pull a backup to your laptop:

```bash
fly ssh console -C "sqlite3 /app/db/algo-admin.db .dump" > "backup-$(date +%Y%m%d-%H%M%S).sql"
```

Restoring from a backup requires SSH'ing in and replaying the SQL. Worth scripting if you want regular backups — but for one client at small scale, a weekly manual run is fine.

## Cost monitoring

Fly's free tier: 3 shared-cpu-1x machines, 256 MB RAM each, 3 GB persistent volumes. The admin uses one machine + one volume, well inside free.

If you ever do exceed free, you'd see an alert from Fly, not a surprise bill.

## Reset (wipe all data)

```bash
fly ssh console
rm /app/db/algo-admin.db /app/db/algo-admin.db-wal /app/db/algo-admin.db-shm 2>/dev/null
exit
fly deploy
```

Database recreates empty on next boot.

## If something breaks

Check the live logs:
```bash
fly logs
```

Restart the machine:
```bash
fly machine restart
```

Or kill and redeploy:
```bash
fly machine destroy --select
fly deploy
```
