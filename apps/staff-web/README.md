# Staff app (`@hos/staff-web`)

Mobile-first, installable web app for housekeeping (and, next, security / maintenance / front-desk tablet). English and Urdu (right-to-left), works with no signal.

```bash
# once: API running with the dev seed
pnpm --filter @hos/api seed:sunset          # first time only
pnpm --filter @hos/api seed:demo-staff      # adds Sana (supervisor), Bilal and Ayesha (attendants); password: sunset-demo-passphrase
pnpm --filter @hos/api dev                  # API on :3000
pnpm --filter @hos/staff-web dev            # app on http://localhost:3001 (proxies /v1 to the API, so cookies and CSRF behave as in production)
```
Sign in with company code `sunset` and `sana@sunset.local` / `bilal@sunset.local` / `ayesha@sunset.local` (Ayesha's profile is Urdu).
Open it on your phone via your Mac's LAN address (`http://<mac-ip>:3001`) — "Add to Home Screen" installs it.

## How it works offline
- Every action (start, finish, put back, skip, do-not-disturb, report a problem, lost & found) is sent at once; with no signal it is saved on the phone **with the time it really happened** and sent, in order, when the signal returns.
- The server treats repeats as no-ops, so a retry or double tap never double-counts. If someone else changed the room meanwhile, the action is dropped and the person is told.
- The last room list is kept, so the app opens and shows the day's work with no signal.

## Checks
```bash
pnpm --filter @hos/staff-web test        # translation parity, offline queue
pnpm --filter @hos/staff-web build
# browser smoke test against the running stack (needs: npx playwright install chromium)
node apps/staff-web/e2e/smoke.mjs ./shots
```
Translations live in `src/i18n/en.ts` and `ur.ts`; Urdu must define exactly the English keys (compiler + test enforce it). **The Urdu wording is a first draft and needs a native-speaker review before go-live.**
