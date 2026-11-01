# Hosting a copy of the system

This is how to put a copy of the system on a server so that other people can use it from a browser — first as a **test copy** (for example for PayFast to try the payment steps), later, when you decide, as the real thing.

Everything runs from one folder on one server with Docker: the database, the system itself, and a web server that gets and renews the HTTPS certificate by itself. Nothing else needs installing.

## What you need

1. **A server.** Any Linux server (a "VPS") with Docker installed, 2 GB of memory or more, and ports 22, 80 and 443 open. Any provider will do; where it is located decides where the data physically lives, which matters before any real guest data goes on it.
2. **A domain name** (for example `test.yourdomain.com`) with an "A record" pointing at the server's address. The HTTPS certificate cannot be issued without it, and the system will not let you sign in over plain http (the session cookie is HTTPS-only).
3. About 20 minutes.

## A test copy, step by step

On the server:

```bash
git clone https://github.com/irfan-clickysoft/hospitality-os.git hos && cd hos
cp deploy/.env.example deploy/.env
```

Edit `deploy/.env` and fill in:

| Setting | What to put |
|---|---|
| `SITE_ADDRESS` | your domain, e.g. `test.yourdomain.com` |
| `POSTGRES_PASSWORD`, `HOS_OWNER_PASSWORD`, `HOS_APP_PASSWORD`, `HOS_ADMIN_PASSWORD` | four different passwords: run `openssl rand -hex 24` four times |
| `APP_ENCRYPTION_KEY` | run `openssl rand -base64 32`. **Keep a copy somewhere safe**: without it the stored second-factor secrets cannot be read |
| `HOS_TEST_COPY` | `1` |
| `DEMO_PASSWORD` | a password you choose (12 or more characters) that the demo users will share |

Then:

```bash
chmod 600 deploy/.env
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

The first start takes a few minutes (it builds the images, creates the database, applies all migrations and loads the Sunset demo business). Watch it with `docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs -f api`. When you see the line "starting api", open `https://your-domain`.

Sign in with company code `sunset`, one of the demo users (`manager@sunset.local`, `hira@sunset.local`, `accountant@sunset.local`, …) and the `DEMO_PASSWORD`.

### Rules for a test copy

- **Test data only.** Never put real guests, real payments or real company details on it. The demo users share one password.
- **Give a visitor a limited login**, such as `manager@sunset.local` or `hira@sunset.local`. Not `owner@sunset.local`.
- **Restarting never resets it**; the demo business is loaded only into an empty database.
- **To wipe it and start again:** `docker compose -f deploy/docker-compose.yml --env-file deploy/.env down -v` (this deletes the data), then `up -d --build`.
- **To take it down** when the meeting is over: `docker compose -f deploy/docker-compose.yml --env-file deploy/.env down`.

## A server that already runs other sites (shared staging)

When the server already has a web server on ports 80/443 (other sites, other stagings), do **not** use `deploy/docker-compose.yml`: its web part would fight for those ports. Use `deploy/docker-compose.shared.yml`: the same system, but the staff app and API are published only on `127.0.0.1:8081` (plain http, nothing reachable from outside), the database has no published port and a volume of its own, memory is capped (database 768 MB, API 768 MB, web 128 MB), and the **existing proxy** sends your domain to it and does the HTTPS.

```bash
git clone https://github.com/irfan-clickysoft/hospitality-os.git hos-pms && cd hos-pms
cp deploy/.env.example deploy/.env      # fill in as in the steps above: SITE_ADDRESS=pms-s.sunsetbb.com, four passwords, APP_ENCRYPTION_KEY, HOS_TEST_COPY=1, DEMO_PASSWORD
# if 8081 is taken, add HOS_LOCAL_PORT=8082 (or another free port) to deploy/.env and use it below
chmod 600 deploy/.env
C="docker compose -p hos-pms -f deploy/docker-compose.shared.yml --env-file deploy/.env"
$C up -d --build
$C logs -f api            # wait for "starting api"
curl -s http://127.0.0.1:8081/healthz     # answered by the system through the web part (the page at http://127.0.0.1:8081/ should also load)
```
`-p hos-pms` keeps this project's containers, network and volume apart from every other stack on the machine; always use the same `C=` line (also for `down`, `logs`, updates and backups).

Then add **one block** to the existing proxy (nothing else is touched), and reload it:

*Caddy* (`/etc/caddy/Caddyfile`; reload with `sudo systemctl reload caddy`):
```
pms-s.sunsetbb.com {
	reverse_proxy 127.0.0.1:8081
}
```
*nginx* (a new file in `/etc/nginx/sites-available/`, linked into `sites-enabled/`; a certificate from `sudo certbot --nginx -d pms-s.sunsetbb.com`; test with `sudo nginx -t`, reload with `sudo systemctl reload nginx`):
```
server {
	server_name pms-s.sunsetbb.com;
	location / {
		proxy_pass http://127.0.0.1:8081;
		proxy_set_header Host $host;
		proxy_set_header X-Forwarded-For $remote_addr;
		proxy_set_header X-Forwarded-Proto $scheme;
		client_max_body_size 12m;
	}
	listen 80;   # certbot adds the 443 / certificate lines itself
}
```
If the existing proxy itself runs **in Docker**, `127.0.0.1` inside it is *itself*: point it at the host instead (`host.docker.internal:8081` with `extra_hosts: ["host.docker.internal:host-gateway"]`, or the Docker bridge address, usually `172.17.0.1:8081`) and set `HOS_BIND=0.0.0.0` in `deploy/.env` so the port is reachable from that bridge. Keep 8081 **closed** in the cloud firewall (only 22, 80 and 443 open), so it is still not reachable from the internet.

The address in the browser must be exactly `https://pms-s.sunsetbb.com` (that is what the system accepts as its origin; change `ALLOWED_ORIGINS` in `deploy/.env` if you serve it from another name). Updating, backups and restore work as above with the `C=` line instead of the long command; for backups use `COMPOSE="$C" bash scripts/backup-prod.sh`, which makes the script talk to this project's database.

**Not tested:** this shared layout has been validated (the compose file resolves, publishes only on 127.0.0.1, sets the right origin) but not run on a server; the images were only partly built here (Docker Hub rate limits).

## Turning on email (Amazon SES)

Guest messages and company statements can be sent by email from the staff app. It stays off until the server has these settings in `deploy/.env`:

1. **SES**, in the AWS console, in the region you will use (for example `ap-south-1`):
   - Verified identities → create one for the domain `sunsetbb.com` (add the DKIM records it shows to your DNS) or for the single address `guestcare@sunsetbb.com`.
   - Account dashboard → **Request production access**. Until it is granted, SES only delivers to addresses you have verified.
2. **An IAM user** for the server (Lightsail instances cannot take an IAM role): create a user with no console access and a policy allowing only `ses:SendEmail` (and `ses:SendRawEmail`), then create an access key for it.
3. **`deploy/.env`** on the server:
   ```
   MAIL_FROM=guestcare@sunsetbb.com
   MAIL_REPLY_TO=guestcare@sunsetbb.com
   SES_REGION=ap-south-1
   PUBLIC_BASE_URL=https://pms.sunsetbb.com   # the address staff open the app at; scheduled-report emails link to it
   AWS_ACCESS_KEY_ID=...
   AWS_SECRET_ACCESS_KEY=...
   ```
   Never commit this file or paste the keys into chat.
4. Restart the API only: `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d api` (use your `-p hos-pms -f deploy/docker-compose.shared.yml` form on a shared server).
5. Check: open a booking → a guest message → **Write an email**, send it to your own address. If the button is missing, email is still off (`MAIL_FROM` or `SES_REGION` empty). If sending fails, **Reports → email log** is not built yet; ask for `GET /v1/properties/<id>/email/recent`, which shows the reason SES gave.

### Bounces and spam complaints

So that a wrong address is not tried again and the staff can see what became of each email:

1. In SNS (same region) create a **Standard topic**, e.g. `hos-mail`. Copy its ARN into `SES_SNS_TOPIC_ARN` in `deploy/.env`, and restart the API.
2. In SES → Verified identities → your domain/address → **Notifications** → set **Bounce**, **Complaint** and (optional) **Delivery** feedback to that topic.
3. In SNS, on the topic, **Create subscription**: protocol **HTTPS**, endpoint `https://<your site>/v1/hooks/ses`. The API confirms the subscription by itself; the status turns **Confirmed** within a few seconds. (The site must be reachable from the internet over HTTPS.)
4. Staff see the result under Administration → Guest messages → **Emails sent**: Delivered, Bounced or Marked as spam. A permanent bounce or a complaint puts the address on a "not emailed any more" list; a manager can allow it again there.

Only messages signed by Amazon for exactly that topic are believed; anything else gets a 403.

## Updating it

```bash
git pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

Database changes are applied automatically when the system starts.

## Backups

```bash
bash scripts/backup-prod.sh
```

Run it by hand or nightly from cron (`0 2 * * *  cd /srv/hos && bash scripts/backup-prod.sh`). It keeps 30 days of dumps in `backups/`. **A backup on the same server is not enough**: copy the files to another machine or to cloud storage.

### Restoring

Stop the system, make an empty database, load the dump, start again:

```bash
C="docker compose -f deploy/docker-compose.yml --env-file deploy/.env"
$C stop api
$C exec -T db psql -U postgres -c "DROP DATABASE hos" -c "CREATE DATABASE hos OWNER hos_owner"
for e in btree_gist pgcrypto pg_trgm citext; do $C exec -T db psql -U postgres -d hos -c "CREATE EXTENSION IF NOT EXISTS $e"; done
$C exec -T db pg_restore -U postgres -d hos --exit-on-error < backups/hos-YYYYMMDD-HHMMSS.dump
$C start api
```

## Going from a test copy to the real business

Do not turn the test copy into the real thing. Make a new, empty copy with `HOS_TEST_COPY` left at `0` and `DEMO_PASSWORD` empty, then create your business and its owner's one-time sign-up link with
`docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec api node apps/api/dist/cli/provision-tenant.js --slug sunset --name "Sunset Hospitality" --owner-email you@example.com --owner-name "Your Name" --site https://your-domain`
(the link is shown once; send it to the owner yourself), and enter your real details, rooms and rates on screen. Before real guest data goes anywhere: decide where the server lives, set up the nightly backup *and* the copy off the server, keep a safe copy of `APP_ENCRYPTION_KEY`, and open only ports 22, 80 and 443 in the firewall (the database is not exposed to the internet by this setup).

## What has and has not been tested

Tested (on a build machine, not a real server): both images build from a clean checkout; the full stack starts; roles, migrations and the demo business are created; restarting does not reseed; you can sign in through the web server; **the full owner browser test (every screen, conference room, rates, rooms, safe, invoices) passes against the containers**; the backup dump restores into a fresh database with the right owners and permissions.

**Not** tested: creating a real business with the command above (it is the same code the demo seed uses, but it has not been run inside a container); a real server and domain (so the automatic HTTPS certificate and your firewall), performance with real use, and anything that depends on PayFast calling the system back (that part is not built yet, waiting for PayFast's documents).
