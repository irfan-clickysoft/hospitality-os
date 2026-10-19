# Staff app (`@hos/staff-web`)

Mobile-first, installable web app for housekeeping (and, next, security / maintenance / front-desk tablet). English and Urdu (right-to-left), works with no signal.

```bash
# once: API running with the dev seed
pnpm --filter @hos/api seed:sunset          # first time only
pnpm --filter @hos/api seed:demo-staff      # adds Sana (supervisor), Bilal and Ayesha (attendants); password: sunset-demo-passphrase
pnpm --filter @hos/api dev                  # API on :3000
pnpm --filter @hos/staff-web dev            # app on http://localhost:3001 (proxies /v1 to the API, so cookies and CSRF behave as in production)
```
Sign in with company code `sunset` and:

| Person | Email | Sees |
|---|---|---|
| Front desk | `hira@sunset.local` | Today queue, Reservations (and the workspace, check-in, check-out), Calendar, Rooms, Guests, Inbox, housekeeping board |
| Property admin | `manager@sunset.local` | all of the above plus Night audit |
| Housekeeping supervisor | `sana@sunset.local` | Board, Issues, Lost & found |
| Attendants | `bilal@sunset.local`, `ayesha@sunset.local` (Urdu) | My rooms |

Start from a clean slate any time with `scripts/reset-dev.sh` (local dev database only).
Open it on your phone via your Mac's LAN address (`http://<mac-ip>:3001`) — "Add to Home Screen" installs it.

## How it works offline
- Every action (start, finish, put back, skip, do-not-disturb, report a problem, lost & found) is sent at once; with no signal it is saved on the phone **with the time it really happened** and sent, in order, when the signal returns.
- The server treats repeats as no-ops, so a retry or double tap never double-counts. If someone else changed the room meanwhile, the action is dropped and the person is told.
- The last room list is kept, so the app opens and shows the day's work with no signal.

## Checks
```bash
pnpm --filter @hos/staff-web test        # translation parity, offline queue
pnpm --filter @hos/staff-web build
# browser tests against the running stack (need: npx playwright install chromium; the API allows 15 sign-ins per account per 10 minutes, so do not loop them)
node apps/staff-web/e2e/smoke.mjs ./shots      # housekeeping: attendant, offline, Urdu, supervisor board
node apps/staff-web/e2e/desk.mjs ./shots       # front office: book, check in, pay, check out, walk-in, rack, cashier, audit (run after scripts/reset-dev.sh)
node apps/staff-web/e2e/flows.mjs ./shots      # the three workflows (late check-in, moving a guest, check-out with a balance) with their exceptions, plus roles, phone, Urdu, keyboard (run after scripts/reset-dev.sh)
node apps/staff-web/e2e/a11y.mjs               # axe-core audit of the shell and workflow pages (run after flows.mjs); fails on serious/critical findings
node apps/staff-web/e2e/office.mjs ./shots     # owner: every tab opens, conference room (space, hire, overlap refused, done, invoice), kitchen menu, grouped tabs on a phone (run after scripts/reset-dev.sh)
```
Translations live in `src/i18n/en.ts` and `ur.ts`; Urdu must define exactly the English keys (compiler + test enforce it). **The Urdu wording is a first draft and needs a native-speaker review before go-live.**

## Structure
`src/shell/` the frame (router, navigation model, command palette, top bar) · `src/pages/` Today, Inbox, the reservation workspace and the check-in, move-room and check-out workflows · `src/ui/ds.tsx` the shared parts (status badge, banner, save state, side panel, tabs, field, inline confirm) · `src/shell.css` their styles and the contrast-checked colour tokens · `src/desk/`, `src/screens/` the earlier screens, now tabs inside the sections.
