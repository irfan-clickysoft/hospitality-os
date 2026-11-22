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

**Built with cancellation reasons (migration 0053):** a standard reason and who started it (guest, property, booking channel, company, system) on every cancelled or no-show room line; the cancellations report shows them and can be grouped by reason, initiator or source.

**Finance ledgers built:** payment receipts and methods (by receipt, method, deposit/payment/refund or cashier) · refunds, voids and adjustments · daily revenue summary (posted revenue by charge type or day, before tax) · taxes and service charges · financial exceptions (bills that do not add up, closed with balance, cash outside a shift, receipts waiting to be verified, cash differences). Deposits and advances are the *Deposits* view of the payments report.

**More finance built:** guest ledger (in-house balances) · receivables ledger and ageing (by company or by billing) · guest bill detail (every posting).

**Sales built:** booking source and channel · market segment · corporate-account production · room type · rate plan (each with nights, room revenue, ADR, share and cancel rate) · booking window, length of stay and day of week · tentative bookings. Not yet: group block pickup, promotions, lost business and denials, forecast accuracy, budget (need new capture), channel commission and net revenue.

**Rooms, housekeeping and maintenance built:** open and overdue work orders · maintenance response and resolution time · repeat faults · out-of-order rooms and lost sellable nights · rooms not ready for arrival · housekeeping progress, turnaround and inspections (failed inspections and re-cleans). Not yet: room-status history and discrepancies over time, linen/amenity/minibar use, preventive maintenance due, downtime revenue impact, asset lifecycle cost, vendor performance, utilities (need new capture).

**Guest experience and risk built:** guest requests and response time · service recovery and compensation · repeat guests · guest preferences and notes · messaging delivery (email) · safety and security trends (plus the existing complaints, damage and lost-and-found registers). Not yet: guest feedback and satisfaction (no survey captured), structured preferences, WhatsApp delivery and reply times, request response targets (need new capture).

**Food and beverage and inventory built (two new groups in the Reporting Center):** F&B revenue by outlet or day with average order value · sales by item, size or category · orders and timing (prepare/deliver minutes, open, delayed, cancelled) · recipe cost and food margin (costed through sub-recipes, same rules as the recipe screen) · stock on hand and reorder · stock movement, waste and count variance. Not yet: modifier performance, laundry/transfer/rent-a-car (not recorded as services), ancillary revenue per stay and upsell conversion, purchase orders, goods received, expiry and batches, vendor performance, stock transfers, theoretical vs actual consumption, F&B departmental P&L.

**Audit and staff built (two more groups):** user activity log · reservation audit · folio and payment audit · discount, refund and override approvals · sensitive-data access and export · scheduled-report delivery history · cashier variance by employee · approval and review queue. Not yet: room-rate/room-move/room-status audit as their own reports (rate changes and moves have reports; room-status history is not recorded), guest ID compliance and government reporting status, tax-invoice sequence exceptions, integration failures, missing or invalid data, shift handover, task volume and aging, SLA performance, workload and staffing forecast, training and quality (need new capture).

**Portfolio built (group “All properties”, shown to people who can see reports at two or more properties):** portfolio daily flash · property comparison with consolidated occupancy, ADR and RevPAR · cash and receivables · revenue mix · cross-property channel and company performance · operational risk overview. Each property is included only where the person holds the report permission; mixed currencies are shown per property and never added. Not yet: consolidated forecast, budget variance and the owner/investor pack (need budgets recorded).

**More front desk built:** in-house guests and expected departures (due out, overdue) · checkouts, extensions and early departures · walk-ins · unassigned rooms · overbooking risk · missing deposits and guarantees · group rooming lists · guest identification compliance. Not yet: government guest-reporting status and lost business and denials (not recorded), group blocks and allotments (not recorded separately).

**Executive, compliance and upkeep additions built:** property scorecard (month and year to date beside last month and last year) · tax-invoice sequence exceptions · missing or invalid data · quotation pipeline · preventive maintenance due · maintenance vendor performance. Not yet: budget, forecast accuracy, owner/investor pack (need budgets and saved forecasts), integration failures list, asset history and lifecycle cost, utilities, linen and minibar use, training and quality, shift handover (need new capture).

**Budgets built (migration 0055):** monthly budgets per property (room revenue, food and beverage revenue, occupancy), entered under Reports → Budgets by someone who manages rates (permission rate.manage). New reports: budget versus actual versus forecast (month to date, forecast = actual + on the books), portfolio budget variance, and the owner and investor pack (scorecard + budget + what is owed on one page). Not yet: forecast accuracy (needs saved forecasts), departmental profit, cash flow and capital spending (not recorded).

**Returning guests and bookings:** a returning guest's ID (the newest main-guest document that has not expired) is offered masked at check-in and at the walk-in desk and used with one tap; the server copies the stored number to the new stay and refuses it for a different name or an expired document. New bookings now have the same special-price controls as the walk-in desk (a percentage off, an amount off or an agreed price, for the whole stay or the first night), with a percentage for particular nights as the alternative.

**Shift handover built (migration 0056):** a Handover tab under Reservations where one shift leaves a note and open items for the next, the next person marks it read and ticks items off. New reports (Staff group): shift handover (written, read, open items, days with none), front-desk workload (check-ins, check-outs, bookings, payments, moves, cancellations and charges per person or day, from the audit trail) and SLA performance (complaints and incidents against their response target, maintenance jobs against their due date). Not yet: task volume and aging beyond the approval queue, staffing forecast (needs a roster), training and quality trends.

**Room-status history built (migration 0057):** every change of a room's housekeeping state is now recorded (who, when, why). New report: room-status history and cleaning time (every change, by room, dirty-to-clean turnaround, vacant rooms still not ready). History starts from the day this is deployed. Not yet: discrepancies over time between the rack, housekeeping and maintenance (needs the history to build up first), linen, amenity and minibar use.

**Lost business and denials built (migration 0058):** a price search for dates where a room type is sold out is recorded (once per person, dates, room type and day). New report in Sales: lost business and denials, by arrival date, room type, channel or each search, with the room nights asked for (value is not estimated). Recording starts when this is deployed. Not yet: forecast accuracy (needs forecasts saved each night), guest feedback, group blocks and pickup.

**Also built:** discount reasons (standard list + note), who gave and who approved, and a request/approve flow for discounts above a user's limit (approval is used once, for the exact price).

**Next (needs new capture):** room-status history, channel commission.

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
* **C Cancellations and no-shows** — one row per lost room line; separate or combined; expected revenue, deposit, fee and whether waived, lost revenue. A no-show is whatever staff confirmed, never inferred from the clock. Reason and initiator are chosen when cancelling or marking a no-show (the night audit and expired holds record the system). *Gap: commission; bookings cancelled before this was kept show “Not recorded”.*
* **D Early check-in / late checkout** — timing against the property's standard times, the guest's request, and the fee decision: suggested, charged, waived, reason, who decided. *Gap: approved time, next-arrival impact.* Fees follow the property's steps (Administration → Properties); with no steps set nothing is suggested and the desk is never asked. Same-day walk-ins are never asked. A decision is immutable; a wrong charge is reversed on the bill.
* **E Damage charge** — one row per damage case; suspected and verified kept apart (suspected is never charged); estimate, actual, approved, waived and charged amounts; guest told and their response; who approved and charged; the bill it landed on. Pictures and internal notes stay in the case (permission-gated). *Gap: refunds and payments per charge are handled on the bill.*
* **F Room rate change** — one row per booking modification with before/after dates and stay totals, reason, actor, revenue impact; the history is the existing immutable booking history. *Gap: per-night before/after, tax impact, approvals, source type.*
* **G Room status** — snapshot with occupancy, housekeeping and maintenance as three columns and an explicit discrepancy column. *Gap: status history timeline.*
* **H Collection and cashier** — one row per shift; cash and non-cash apart; blind-close respected. *Gap: paid-outs, gateway/OTA batches, sign-off steps.*
* **I Due and outstanding** — open bills split in-house / departed / company; aged from departure (or bill opening). A card pre-authorization is not a payment. *Gap: disputes, promises, write-offs, credit limits, collection owner.*
* **J Discounts and complimentary** — booking discounts, zero-charge lines (complimentary) and bill discounts, separate types. *Reason, given-by, approved-by and category are now captured.*
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

**Guest feedback built (migration 0059):** after check-out the guest's booking page shows a short form (overall and four 1–5 ratings, would recommend, comment); one response per booking. New report in the Risk group: guest feedback and satisfaction, by response, low ratings, month or room type, with the response rate against check-outs (no reminders are sent). Not yet: group blocks and pickup, forecast accuracy (needs forecasts saved each night), commission and net revenue, integration failures, asset lifecycle, linen/amenity/minibar, training and quality, staffing forecast.

**Commission and net revenue built (migration 0060):** a commission percentage per booking source is set under Reports → Budgets (Commission by booking source). New Sales report: commission and net revenue, by source or month, with a warning for sources that have no rate. Commission is room revenue × the rate (an estimate, not an agent statement). Not yet: group blocks and pickup, forecast accuracy, integration failures, asset lifecycle, linen/amenity/minibar, training and quality, staffing forecast.

**Forecast accuracy built (migration 0061):** each time the books are saved (night audit or manual), the room-night forecast for the next 60 days is kept too, only for dates with enough history. New Sales report: forecast accuracy (each stay date at a chosen distance, or by how far ahead), with accuracy, bias and a comparison with counting only what was on the books. A date can be scored once it has passed, so the report fills in over the first weeks. Not yet: group blocks and pickup (no group booking record exists), integration failures (email and report delivery failures are already in their own reports; there are no channel feeds to record), asset lifecycle, linen/amenity/minibar, training and quality, staffing forecast.
