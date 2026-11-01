# Stay360 Reporting & Insights Center — design and delivery plan

Source: the product brief in `docs/Reports.Md.Rtf` (as supplied). This file answers its sixteen "before implementation" deliverables, says what exists today, and sets the order of the rest. Where the brief asks for something the system cannot yet know, this file says so instead of showing a number that looks real.

## 1. Information architecture

Reports → **Reporting Center** (first tab) · Management (existing live summary) · Downloads (existing spreadsheets) · Night audit (run it) · Audit trail.

Inside the Center: *For your role* · *Favourites* · *Recently viewed* · then the catalog grouped as **Management**, **Front desk and reservations**, **Rooms and housekeeping**, **Finance and night audit**, **Sales and performance**, **Guest experience and risk**. Planned reports are listed at the foot with what must be captured first. A person reaches any common report in two interactions: Reports → report.

Not built yet: Scheduled reports, shared (manager-published) views, Custom report builder (phases below). Personal saved views and favourites are kept in the browser.

## 2. Role-to-report access (what ships)

Access is by permission at the property, not by role name; the "suggested" column is only the default shelf.

| Report | Opens with any of | Suggested for |
|---|---|---|
| Daily manager flash | management.view, report.view | Manager |
| Expected arrivals, Completed check-ins, Room moves, Reassignments, Early/late | reservation.view | Front desk, manager, housekeeping |
| Cancellations and no-shows | reservation.view | Manager, front desk, accounts |
| Room rate changes | report.view, reservation.view | Manager, accounts |
| Room status | housekeeping.view, reservation.view | Housekeeping, front desk, maintenance |
| Collection and cashier | report.view, cashier.review | Accounts, manager |
| Due and outstanding | report.view, folio.view | Accounts, manager, front desk |
| Discounts and complimentary | report.view | Manager, accounts |
| Lost and found | housekeeping.view, reservation.view | Housekeeping, front desk |
| Night audit | nightaudit.run, report.view, management.view | Accounts, manager |
| Future bookings, Historical performance | management.view, report.view | Manager, accounts |

Each report is checked again on every run and every export. The cashier report shows expected cash and variance only for closed shifts (blind close is preserved).

## 3. Report inventory and priority

**Built (this phase):** flash · expected arrivals · completed check-ins · room moves · pre-arrival reassignments · cancellations and no-shows · early check-in/late checkout (timing) · room rate changes · room status · collection/cashier · due and outstanding · discounts and complimentary · lost and found · night audit · future bookings and revenue (on the books) · historical performance.

**Built with the registers (migration 0049):** E *Damage charges* and K *Complaints and incidents*, with the damage and case registers behind them (Tasks → Damage, Tasks → Complaints).

**Built with snapshots (migration 0050):** *Booking pace and pickup* (net pickup split into new bookings, cancellations and changes) and *Occupancy and revenue forecast* (on the books + typical pickup at that distance, with samples and confidence shown, no forecast where history is thin).

**Built with timing fees (migration 0052):** early check-in and late checkout **fees and waivers**: property steps (share of a night by minutes off the standard time), a decision recorded before check-in/out (charged to the bill, a different amount, or waived with a reason), shown in report D.

**Next (needs new capture):** cancellation initiator and reason codes, discount reasons and approvals, room-status history.

**Later:** booking pace and pickup, forecast and forecast accuracy (need nightly snapshots), channel/segment/corporate production, group pickup, payment-gateway and OTA reconciliation, commission payable, housekeeping productivity and inspection, maintenance aging/downtime, F&B and inventory reports, staff productivity, access/export audit reports, multi-property portfolio views, scheduled delivery, custom builder.

## 4. Metric dictionary

| Metric | Definition | Notes |
|---|---|---|
| Occupancy % | rooms sold ÷ rooms available | Available excludes rooms out of order or out of service. Paid vs total guest occupancy shown separately later. |
| ADR | recognized room revenue ÷ rooms sold | Excludes tax, fees, F&B, other revenue. |
| RevPAR | recognized room revenue ÷ rooms available | |
| Recognized revenue | revenue for nights consumed, locked by the night audit | `daily_property_stats` |
| On the books | confirmed and in-house room nights at booked prices, ex-tax | Never a forecast; tentative holds kept apart. |
| Cash collected | captured payments on the business date | Never revenue; physical cash is separate from cards and transfers. |
| Expected closing cash | opening float + cash receipts − cash refunds − safe drops | Variance = counted − expected. |
| Pickup | on the books now − prior snapshot for the same stay dates | Needs snapshots (later). |
| Booking window | arrival − booking-created date | |
| Length of stay | consumed room nights | A room move creates no extra nights. |

Booked, forecast, recognized and collected figures are never added together or shown in one column.

## 5. Specifications for reports A–L (built reports)

Each entry: grain · source · default basis/range · main exclusions · drill-down · gaps.

* **A Check-in** — one row per room line checked in; `reservation_room`, history, stay guests, bill. Basis: business date of check-in (or arrival). Expected arrivals are a separate report. Early flag = arrival date and local time before the property's check-in time. Drill: booking. *Gap: early-check-in fee/waiver not recorded.*
* **B Room move** — one row per `ROOM_MOVED` event on a checked-in line; old/new room and type, reason, actor. Pre-arrival changes are a separate report. A move keeps rates, so no charge. *Gap: guest- vs property-initiated, approvals, housekeeping/maintenance impact, related complaint.*
* **C Cancellations and no-shows** — one row per lost room line; separate or combined; expected revenue, deposit, fee and whether waived, lost revenue. A no-show is whatever staff confirmed, never inferred from the clock. *Gap: initiator, commission, standard reason codes.*
* **D Early check-in / late checkout** — timing against the property's standard times, the guest's request, and the fee decision: suggested, charged, waived, reason, who decided. *Gap: approved time, next-arrival impact.* Fees follow the property's steps (Administration → Properties); with no steps set nothing is suggested and the desk is never asked. Same-day walk-ins are never asked. A decision is immutable; a wrong charge is reversed on the bill.
* **E Damage charge** — one row per damage case; suspected and verified kept apart (suspected is never charged); estimate, actual, approved, waived and charged amounts; guest told and their response; who approved and charged; the bill it landed on. Pictures and internal notes stay in the case (permission-gated). *Gap: refunds and payments per charge are handled on the bill.*
* **F Room rate change** — one row per booking modification with before/after dates and stay totals, reason, actor, revenue impact; the history is the existing immutable booking history. *Gap: per-night before/after, tax impact, approvals, source type.*
* **G Room status** — snapshot with occupancy, housekeeping and maintenance as three columns and an explicit discrepancy column. *Gap: status history timeline.*
* **H Collection and cashier** — one row per shift; cash and non-cash apart; blind-close respected. *Gap: paid-outs, gateway/OTA batches, sign-off steps.*
* **I Due and outstanding** — open bills split in-house / departed / company; aged from departure (or bill opening). A card pre-authorization is not a payment. *Gap: disputes, promises, write-offs, credit limits, collection owner.*
* **J Discounts and complimentary** — booking discounts, zero-charge lines (complimentary) and bill discounts, separate types. *Gap: reason, requested/approved-by, category.*
* **K Complaints and incidents** — one row per case: type (complaint, service failure, safety, security, medical, internal), severity, owner, SLA target and overdue flag, resolution and time to resolve, root/corrective/preventive action, compensation. Restricted cases (safety, security, medical, confidential) are filtered out for anyone without `case.restricted`, and the text of a restricted report is not copied into its history.
* **L Lost and found** — one row per item with status, storage, age and retention flag. Photos and handover signatures live on the item.

## 6–9. Management reports

* **Daily manager flash** — live rooms, arrivals/departures, revenue posted, cash collected, owing, and a "needs a decision" block; month to date from closed nights.
* **Night audit** — one row per run: status, who, when, overrides, failed steps and the figures the close locked in; warns about unclosed days.
* **Future bookings and revenue** — on-the-books nights, occupancy, ADR and room revenue by day/week/month, with tentative nights kept separate. A forecast is deliberately absent until snapshots exist.
* **Historical performance** — occupancy, ADR, RevPAR, revenue for closed days, with previous-period and last-year comparison and a warning when days are missing.

## 10. Global filters and saved views

Every report states its date basis; the date inputs are labelled with it ("Arrival date — From"), never just "Date". Filters live in the address, so a link reproduces the screen. Personal saved views are stored per property and report. Property, group and building filters, comparison selectors for every report, and manager-published views are later.

## 11. Permissions and masking

View is per report and per property (above). Export is audited (`report.export`: report, basis, range, filters, row count). No report shows full card numbers or full ID numbers; the reports built here show none. Unmasking with a reason, separate export/schedule permissions, and re-checking permission when a schedule runs come with scheduling.

## 12. Export and scheduling

Built: screen, print view, **scheduled delivery** (below), CSV with a header block (report, property, date basis and range, filters, currency and tax basis, time zone and business date, generated time and user, data-as-of, definition version) and a totals row. **Scheduled delivery (built, migration 0051).** A schedule names a report, its filters, which dates it covers (the day that closed, last 7/30 days, month to date, previous month, next 7/30/90), how often (every day, weekly on a day, monthly on a day or at period end) and who receives it. It runs **when the night audit closes the business day**, so figures are final. The report is generated then and **stored as a snapshot** (so the link, the screen and the CSV always match), and each recipient gets an **email with a link and no figures**. The link needs sign-in, works for 7 days (the stored copy is then removed), and is **checked again on every opening**: the person must be a recipient and must still be allowed to open that report. The schedule is re-authorized each time it runs: if its owner is inactive or can no longer open the report, it is paused and the log says why; recipients who lost access are skipped. **Threshold alerts**: a schedule can be limited to days when a key figure crosses a limit; otherwise nothing is sent and the log says it was skipped. Complaints and incidents are generated without restricted cases, so a scheduled copy never carries them. Each delivery is audited (generated, opened, exported). Permission `report.schedule` (separate from viewing).
Later: Excel, branded PDF (the screen is printable now), delivery of reports that include sensitive fields with unmasking and a reason, and shared (manager-published) views.

## 13. Event and snapshot data model

Existing and used: booking history, room assignments, payments, cashier shifts, folio postings, night-audit runs and daily statistics, stay nights, lost-and-found events.
To add as needed: `booking_snapshot` — **built**: daily on-the-books by stay date, room type and channel, saved in the transaction that closes the business day (and on demand); cancellation initiator and reason code; fee/waiver events for early/late; damage cases; complaint/incident cases; room-status history; discount reason and approval; collection follow-up (promise, dispute); report schedules and delivery log.

## 14. Layouts

Desktop: dense sticky-header table with column chooser, sortable columns, totals row. Tablet/mobile: the table becomes a stack of compact records (label/value pairs); filters and exports remain reachable; no sideways page scroll.

## 15. Reconciliation and testing

* API test runs every report on one property after a booking, check-in, room move, cancellation, cash payment, shift close and night audit, and checks the figures (room moves, cancellations, shift expected/variance, historical occupancy), permission refusal, period limits and CSV headers.
* Browser test covers the catalog, scope header, definitions, CSV link, three-column room status, accessibility (axe, WCAG 2.2 AA tags) and the phone layout.
* Reconciliation rules to keep: cashier expected = float + cash in − cash refunds − drops; historical totals equal the night-audit rows they sum; outstanding total equals open bill balances; future bookings never include tentative holds.

## 16. Implementation sequence

1. **Done:** engine, catalog, shell, components, sixteen reports above.
2. Capture slices that unlock the registers: damage cases (E), complaints/incidents (K), early/late fees, cancellation reason codes, discount approvals.
3. **Done:** daily snapshots → booking pace, pickup, forecast. Still to add: forecast accuracy (needs forecasts saved over time), pace by channel/segment, same-date-last-year pace.
4. Scheduling and delivery (expiring links), Excel/PDF, shared views.
5. Reconciliation reports (gateway, OTA, bank), channel/segment/corporate, housekeeping and maintenance analytics.
6. Portfolio (multi-property, currency conversion with stated FX), owner pack.
7. Custom report builder.

Demo data: the Sunset demo property's seed data is clearly the demo; reports show whatever the property holds.
