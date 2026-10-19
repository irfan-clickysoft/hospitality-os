# Demo walkthrough — Sunset Hospitality OS

For showing the system (to PayFast, to staff, to partners). About 20–25 minutes. Everything below works on a local copy (`bash scripts/reset-dev.sh`, then start the API and the staff app, open http://localhost:3001). Company code `sunset`, password `sunset-demo-passphrase`.

## Before the meeting (10 minutes, once)

1. `bash scripts/reset-dev.sh`, restart the API and the staff app.
2. Sign in as `owner@sunset.local` → **My account** → set up the second factor (authenticator app).
3. **Tax** → enter the company's **NTN and STRN** (legal entity card). Set the real effective date on each draft rate and **approve** it with the advisor's reference. (Until you do, nothing is taxed and the invoice shows no tax.)
4. **Accounts** → the four bank accounts are already there (three in the owner's personal name, one company account, flagged accordingly); add the last four characters of each, and **the PayFast gateway account** when it exists. Cash is not an account: registers close daily into the property's safe (**Cashier**), and the weekly handover to head office is recorded and printed there.
5. **Rooms** → correct the Ramna numbers (see the note in the README). **Rates** → set how many people each type sleeps.
6. Open **Setup check**: nothing should say *To do* except what you know is pending.
7. Sign in as `hira@sunset.local` in a second browser (front desk) and open the cashier session (**Cashier** → open, with a float).

## The story (in this order)

| # | Show | Where | What to say |
|---|---|---|---|
| 1 | The business at a glance | Owner → **Management** | Occupancy, ADR, RevPAR, revenue, money owed to us, per property and for the group. |
| 2 | Real prices, one place | **Rates** | Rate card per room type; foreign guests can be priced differently later with one number. |
| 3 | Book a guest | Front desk → **Rack** → New booking | Quote shows the price, the cancellation sentence (72 hours) and the deposit rule. Prices exclude tax. |
| 4 | Take a deposit | Booking → **Take payment** | Cash needs an open cashier session; a bank transfer waits for a second person to verify. |
| 5 | Check in, add a charge | Booking → Check in, then **Add charge** | Tax is added beside each charge from the approved rates (Karachi / Islamabad differ). |
| 6 | Room service | **Kitchen** → New order (tick *pay digitally* once) | Food is charged when it is handed over; digital food uses the digital rate. |
| 7 | Conference room | **Conference room** → New hire | Hourly / half-day / full-day, no double booking, charged to a stay or on its own bill with its own invoice. |
| 8 | Check out and invoice | Booking → Check out → **Issue invoice** | Numbered tax invoice with the company's NTN/STRN; printable; credit notes if wrong. |
| 9 | Company on credit | Booking → **Bill to company** | Credit limit, terms; over the limit needs a manager (with the second factor). |
| 10 | Housekeeping on a phone | Sign in as `bilal@sunset.local` on a phone-sized window | Works offline; Urdu for staff who prefer it (`ayesha@sunset.local`). |
| 11 | Cash and the safe | **Cashier** (manager) | Registers are counted blind; each day's envelope goes in the safe; the weekly handover to head office is recorded with a printable, signable receipt. |
| 12 | Close the day | **Night audit** | Rolls the business date; the day's figures become fixed. |
| 13 | Nothing hidden | **Audit trail**, **Setup check**, **Compliance** | Who did what; personal accounts are flagged; charges that need a tax review are listed. |

## For PayFast specifically

- **Payment accounts** already have a *Gateway* kind: money received through PayFast is recorded against it, with the owner of the account shown.
- Bookings from Booking.com that are *unpaid* are held **at risk** until a deposit is received (the guarantee rule); the deposit link from PayFast is what will turn that into automatic confirmation.
- **Not built yet** (waiting for PayFast's documents and a test merchant account): creating a payment link for a booking, receiving PayFast's confirmation (the instant notification), matching it to the booking, and refunds through the gateway. All money entries already go through one audited path, so this attaches without changing the rules.
- A gateway can only call back to a **public address**. Locally that does not exist; see "Showing it to PayFast" below.

## Showing it to PayFast

PayFast cannot reach a laptop. Options, cheapest first:

1. **Screen-share the local copy** for the walkthrough (nothing to set up).
2. For their technical testing, a **small hosted copy** (a Docker image exists on branch `phase-1-hosting`, never built or tested yet) behind a public HTTPS address, with test data only and their access limited to a test account. This needs a hosting account and a decision about where the data may live; do not put real guest data on it.

Whichever is chosen: give them **test** logins only (never the owner's), and reset the data after.

## If something looks wrong during the demo

Do not improvise a fix on screen. Note it, and send it over: every screen has an audit trail and the problem can be reproduced from the database state.
