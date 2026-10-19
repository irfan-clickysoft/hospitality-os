# UX foundation — Sunset Hospitality OS

A design for a hospitality operating system for independent and boutique hotels that feels simple, calm, fast and trustworthy. This document is written **before** the implementation, in the order requested: assumptions → roles → sitemap → three workflows → screens → statuses → tokens and components → responsive rules → states. Section 10 says exactly what is built in this pass and what is deliberately not.

It adapts to what already exists (the staff app, its components, its API and its error codes). Where the existing system limits the design, the limit is stated rather than hidden.

---

## 1. Assumptions and target customer

**Customer.** An independent or boutique hotel group: 8–60 rooms per property, one to five properties, a small team where one person often does two jobs (the duty manager also works the desk; the owner also approves tax rates). First market is Pakistan: Urdu and English staff, PKR, cash and bank transfer as common as cards, intermittent connectivity, shared devices, high staff turnover.

**What this customer is not.** Not a chain with a revenue-management department, not a resort with 40 departments, not a consumer brand that needs a marketing site. The software is a tool used under time pressure by tired people.

**Working assumptions** (each one changes the design if it is wrong):

1. The front desk uses a PC or tablet; housekeeping and maintenance use their own or a shared Android phone; managers use both.
2. A new front-desk employee gets no training day. They must be able to open the app and know what needs attention.
3. The business day is not the calendar day: the day ends at night audit, and late arrivals after midnight still belong to yesterday's business date. The business date is therefore always visible.
4. Signal drops. Anything a housekeeper does must survive it; anything that needs the server to validate (check-in, payment) must say so honestly rather than pretend.
5. Several people touch one reservation within minutes (desk, housekeeping, kitchen, manager). Concurrent change is normal, not an edge case.
6. Money and identity documents are sensitive. Every sensitive action is permissioned, confirmed, and recorded; every reversible action can be undone.

**Principles** (used to settle arguments):

- **Today's work, not statistics.** Show what needs a person next; totals are secondary.
- **Exceptions over averages.** A blocker is louder than a count.
- **One obvious primary action per screen.**
- **Plain hospitality words.** "Arrivals", "In house", "Not ready", never "entities" or "records".
- **Progressive disclosure.** Details appear when needed, the summary is always enough to decide.
- **State is never hidden.** Saving, saved, offline, stale and conflicted are all visible, with words.
- **Trust is visible.** Who did this, when, can I undo it, am I allowed.

---

## 2. Roles and their most important jobs

| Role | Device | The jobs that matter most | Home screen | Speed target |
|---|---|---|---|---|
| **Front-desk agent** | PC, tablet | Check guests in and out; find a reservation instantly; fix a room problem before the guest notices; take payment | **Today** (arrivals, departures, exceptions) | Find anyone in ≤ 3 s (search); check-in in ≤ 90 s |
| **Duty / general manager** | PC + phone | See what is going wrong right now; approve exceptions (balance on departure, fee waiver); know the day's money and rooms | **Today** (exceptions first) + Inbox | One glance: "what needs me" |
| **Housekeeper** | Phone | Know which room next; start and finish a room; report a problem | **Today** = my rooms, most urgent first | One tap per status change, works offline |
| **Housekeeping supervisor** | Phone + PC | Assign rooms; see what blocks arrivals; inspect | Housekeeping board | See "arrival waiting on a room" in one look |
| **Maintenance technician** | Phone | What is assigned to me, how severe, by when, is the room out of service | **Today** = my issues, by severity then deadline | Update status in one tap; photo from the camera |
| **Finance / accounts** | PC | Verify bank transfers; chase company balances; invoices, tax, reports | Inbox (payments to verify) then Reports | No hunting: items waiting on me are listed |
| **Administrator / owner** | PC | Set up rooms, rates, tax, accounts, people; see the audit trail; approve | Today (owner view) + Setup check | Safe changes: every one confirmed and recorded |
| **Gate security** | Phone | Who is expected; log visitors and vehicles | Gate (Tasks & Maintenance) | Two taps to log |

**Role adaptation is real, not cosmetic.** Navigation items, home screen, information density and available actions all follow permissions the user actually holds. A housekeeper never sees folios; a cashier never sees the tax setup; a button the user cannot use is **absent**, or present-but-disabled **with the reason** when knowing why is useful ("Needs a manager").

---

## 3. Sitemap and navigation model

### Application shell (always present)

| Element | Behaviour |
|---|---|
| **Property selector** | Persistent, top left. Shows the property name; a list only when the user has more than one. The choice survives reloads and is part of every link. |
| **Business day** | Next to the property: `Mon 19 Oct · business day`. If the business date differs from the calendar date (after midnight, before audit) a quiet note says so. |
| **Search and command palette** | One box, `Ctrl/⌘ K` or `/`. Finds reservations (name, booking number, phone, room), rooms, guests; also runs commands ("New walk-in", "Open cashier", "Go to Rooms", "Switch property"). |
| **Alerts and inbox** | Bell with a count of items that need action, opening a short list; "Open inbox" for the whole shared queue. |
| **System state** | A small, always-visible indicator: *Online*, *Offline — 3 changes waiting*, *Syncing*. Never colour alone. |
| **User and role** | Name and role label; menu: my account (password, second factor), language (English / اردو), sign out. |
| **Navigation** | Left rail on desktop, collapsible to icons (state remembered). Bottom bar on a phone with the role's four most-used items and **More**. |

### Primary navigation and where existing screens live

| Item | Contains | Visible to |
|---|---|---|
| **Today** | Role-specific work queue (see §5). | Everyone |
| **Reservations** | Search/list · **Reservation workspace** · tabs: Bookings, Cashier, Companies & credit, OTA claims, Conference room | reservation.view |
| **Calendar** | The room rack (tape chart) | reservation.view |
| **Rooms** | Live room status: ready / not ready / occupied / out of service, by floor | property.view, housekeeping.view |
| **Housekeeping** | My rooms · Board · Issues · Lost & found | housekeeping.view / .update |
| **Guests** | Guest directory and profile | guest.view |
| **Inbox** | The shared queue of things waiting on someone (grouped by kind) | Everyone (content follows permissions) |
| **Tasks & Maintenance** | Maintenance · Compliance & reviews · Kitchen · Gate | maintenance.view, compliance.view, fnb.order, visitor.log |
| **Reports** | Overview · Downloads · Night audit · Audit trail | report.view, management.view, nightaudit.run, audit.view |
| **Administration** | Property (Rooms, Rates, Tax, Payment accounts, Setup check) · People (Staff) · Data (Import) | property.manage, rate.manage, tax.*, user.manage… |

**Role views of the nav** (items shown): front desk — Today, Reservations, Calendar, Rooms, Guests, Inbox; manager — all but Administration unless permitted; housekeeper — Today, Housekeeping, Inbox; maintenance — Today, Tasks & Maintenance, Inbox; finance — Today, Reservations, Reports, Inbox; admin — everything.

**URLs preserve context.** Every screen has an address (`#/reservations/R-2026-0412/check-in`) so that links, the back button and refresh all work; the selected property, filters (in the query) and scroll position are kept when navigating away and back.

---

## 4. The three workflows

Conventions used below: **Blockers** are shown *before* the workflow starts (in the queue row and at the top of the workspace). **Interactions** counts taps/clicks from the role's home screen.

### Workflow A — Late-arrival check-in with missing information

*Scenario.* Mr Faisal Raza (booking SB-2026-0412, 2 nights, Executive Room, booked by phone, arrives 23:40) has no ID on file, no phone number and has paid no deposit. Room 201 is assigned but still shows *Cleaning*.

**Entry points** (1–2 interactions): the arrival row on **Today**; the command palette (`faisal` → Enter); a search from anywhere.

**What the user sees before starting.** The Today row already carries blockers: `Room not ready` (error), `ID needed at check-in` (info), `No deposit` (warning). Opening the reservation shows the same blockers in a banner at the top of the workspace, ranked: what *stops* check-in, what only needs attention.

**Happy path (3 interactions after the workspace opens):**

1. **Check in** (primary button, `C`) opens the check-in workflow *as a full page inside the workspace*, keeping the context rail visible (guest, stay, room, balance).
2. **Step 1 — Room.** The assigned room and its state. If ready: confirmed. If not ready: a clear card "Room 201 is still being cleaned" with two actions — *Check in anyway (manager)* or *Move guest to another room* (opens Workflow B in a side panel, without losing the check-in draft).
3. **Step 2 — Guests.** One card per guest: name (pre-filled from the booking), ID type (CNIC pre-selected for Pakistani guests, Passport for foreign guests), ID number with live format hint, nationality, passport expiry where relevant. Missing fields are marked **in the field**, never in a modal. The draft autosaves on this device.
4. **Step 3 — Confirm.** A summary ("Mr Faisal Raza · Room 201 · 2 nights · Balance 0") and the primary action **Check in**. On success: a persistent confirmation card in the workspace ("Checked in 23:46 by Hira"), with **Undo check-in** (allowed on the day it happened) and **Print registration card**. No toast is the only confirmation.

**Exceptions**

| Situation | What the system does | Recovery offered |
|---|---|---|
| **Room not ready** (`ROOM_NOT_READY`) | Blocker card; primary action disabled until resolved | Move guest (Workflow B) · Manager override "check in anyway" with a reason (needs `frontdesk.override_room`) |
| **Room no longer free** (`ROOM_NOT_FREE`) | Inline error on the room step with the other rooms of that type that are free | Pick another room; the draft stays |
| **ID number missing / wrong format** | Field-level message; the Check in button stays disabled with the reason listed above it ("2 things missing: ID number, nationality") | Fill in; or **Save draft and finish later** (guest waits at desk) |
| **Foreign guest without a passport** | Passport becomes required; explained in one sentence | Choose Passport |
| **Guest flagged "do not rent"** (`GUEST_BLOCKED`) | Full-width stop banner; check-in blocked | "Ask a manager" (sends to Inbox with the context); no override for the agent |
| **Compliance rule needs approval** | Approval box appears *in place* with the rule text | Manager approves with a reason (second factor) |
| **Missing deposit / at-risk booking** | Warning only; check-in is allowed | "Take payment" shortcut keeps the check-in draft |
| **Permission restriction** (no `frontdesk.check_in`) | Check in is replaced by "Needs front-desk permission" with who can | Ask a colleague |
| **Full ID numbers hidden** | Registration card shows masked numbers; "Reveal" needs permission + second factor, and is recorded | — |
| **Stale data / concurrent change** | The workspace polls; if the stay changed since the page opened (checked in by someone else, room reassigned, cancelled) a **conflict banner** appears: "Hira checked this guest in at 23:41" with **Review changes**; the primary action is disabled until reviewed | Reload and continue |
| **Offline** | Primary action disabled with "No signal — check-in needs the server so the room and ID rules are checked"; the draft is kept on the device | Retry when the system state shows *Online* |
| **Server or integration outage** (5xx, gateway down) | "The system could not complete this. Nothing was changed." with **Try again**; the draft is kept | — |
| **Too early / stay ended** (`TOO_EARLY`, `STAY_ENDED`) | The reason in plain words with the fix (change arrival date / extend stay) as a link | Link to the right place |

**State of the draft is always visible** in the top right of the workflow: *Saving…* · *Draft saved on this device 23:44* · *Could not save draft — Retry* · *Offline — draft kept on this device* · *Changed by someone else — Review*. ID numbers are **not** written to the device draft (sensitive); everything else is.

### Workflow B — Reassigning a guest because the allocated room is not ready

*Scenario.* Room 201 will not be clean for another 40 minutes and Mrs Ayesha Malik is at the desk now. Or: the guest is already in the house and the room has a problem (AC failure).

**Entry points** (1 interaction from the blocker): the **Move guest** action on the "Room not ready" blocker (workspace, Today row, or Rooms), or `M` in the workspace.

**Design choice.** A **side panel**, not a dialog or a new page: the reservation stays visible behind it, because the decision depends on guest, dates and balance.

**Happy path (3 interactions):**

1. **Move guest** opens the panel headed "Choose another room for Mrs Ayesha Malik — Executive Room, 2 nights".
2. The panel lists the *same room type* in three groups, ordered by usefulness: **Ready now** (clean, inspected, free for all nights) · **Almost ready** (cleaning in progress, with the housekeeper's progress) · **Not available** (occupied, out of service, booked by someone else — each with the reason). Rooms that cannot be chosen are shown, not hidden, so the agent understands why.
3. Select a room (e.g. 202 — Ready now) → a **consequence summary**: "Room 202, Floor 1 · same rate · housekeeping will be told to release 201 · the guest is not notified automatically". Primary action **Move to 202**. For an in-house guest a reason is required (pre-filled suggestions: *Room not ready, AC fault, Guest request*).
4. Confirmation persists in the workspace timeline ("Moved 201 → 202 by Hira, 23:52 — reason: room not ready") (there is no Undo: a move is a recorded action, and putting the guest back is a new move — the old room is dirty by then, so the panel does not pretend otherwise).

**Exceptions**

| Situation | Behaviour | Recovery |
|---|---|---|
| **No room of that type is free** | Panel says so plainly; shows the nearest time one will be (checkouts due today) | Assign later and keep the guest waiting; *Upgrade (not available in this version — the room type must be changed on the booking first)* is shown disabled with that reason; ask a manager |
| **Chosen room taken meanwhile** (`ROOM_NOT_FREE`) | Panel refreshes, keeps the selection's neighbours, says "Someone just booked 202" | Choose again |
| **Target room not ready** | Allowed only with an explicit "I accept it is not ready" and, if the guest is in-house, a reason | — |
| **Different room type** (`WRONG_ROOM_TYPE`) | Never offered; stated in one line | Change room type on the booking |
| **Same room** (`SAME_ROOM`) | Prevented in the UI | — |
| **Permission restriction** | Panel opens read-only with "Only front desk can move guests — ask Hira or a manager" | Request via Inbox |
| **Stale data** | The room list shows its age ("updated 8 s ago") and refreshes; if the reservation changed, the conflict banner appears | Review |
| **Concurrent change** | A move by someone else while the panel is open → panel closes with "Hira already moved this guest to 203" | Review |
| **Offline / outage** | Primary disabled with the reason; panel keeps its selection | Retry |
| **Undo no longer possible** | Undo is offered only while valid; afterwards a new move is a new, recorded action | — |

### Workflow C — Checkout with an outstanding balance

*Scenario.* Mr Imran Siddiqui checks out; the folio shows PKR 6,900 owing (two nights, room-service dinner, minibar).

**Entry points:** the departure row on **Today** (shows `Balance 6,900` as a blocker), the workspace, or `O`.

**What the user sees first.** The departure row says *Balance due PKR 6,900*; opening the workspace puts the balance in the **context rail** (always visible) and the primary action reads **Settle and check out**.

**Happy path (3–4 interactions):**

1. **Settle and check out** opens the checkout page inside the workspace, in two clear zones: **The bill** (grouped lines with tax shown separately, charges that were posted late flagged) and **How is it being settled?**
2. **Take payment** (primary) with the amount pre-filled; method chips (Cash · Card slip · Wallet · Bank transfer); the account picker where the method needs one; reference fields only where they matter.
3. When the balance reaches zero the page changes state: *Paid in full*, and the primary becomes **Check out**. **Issue invoice** (and **Print**) are offered next, not buried.
4. Confirmation persists ("Checked out 11:58 · Settled · Invoice INV-2026-000381") with **Undo** only where the system allows it (it does not for financial postings: corrections are explicit reversals, and the page says so).

**Alternatives for the balance:** **Bill to company** (if the booking has one, credit limit shown), **Leave with a balance** (needs `folio.checkout_with_balance`, a reason and the second factor, and is recorded), **Waive / adjust** (manager).

**Exceptions**

| Situation | Behaviour | Recovery |
|---|---|---|
| **Payment fails** (card slip rejected, wrong reference, cash with no open cashier session) | Error stays on the payment form, in words ("Open your cashier session before taking cash"); nothing is posted; the form keeps what was typed | Other method; open session in one click; record the slip manually |
| **Bank transfer** | Recorded as *Waiting for verification*; balance shown as "pending 6,900" not zero; checkout stays blocked until a second person verifies, or a manager lets the guest leave | Manager path; the item appears in Finance's Inbox |
| **Balance changed meanwhile** (kitchen posted a charge, night audit ran) | The page re-reads the bill every 15 s and on focus; a **banner** says "The bill changed: +PKR 1,200 (Room service 21:10)" and the amounts update; the primary action is disabled for one second so a stale total cannot be confirmed by reflex | Review and continue |
| **Overpaid** | "The guest has paid PKR 500 more than the bill" with *Refund* and *Keep as credit* (refund needs permission) | — |
| **Early departure** | Reason required, remaining nights explained | — |
| **Permission restriction** | Settling is available to anyone with `payment.take`; leaving with a balance shows "Needs a manager" and routes the request to the Inbox with the folio attached | Manager acts from the Inbox |
| **Second factor needed** | An inline step-up prompt on the same page; no navigation away | — |
| **Offline** | Payments and check-out are disabled with the reason; the bill remains readable from the last good copy, labelled with its age | Retry |
| **Gateway / terminal outage** | Card payment shows "Card payment is unavailable"; Cash, Transfer and *Card slip (manual)* remain | Manual slip with the reference |
| **Duplicate tap** | Money requests carry an idempotency key made when the page opens, so a double click can never take payment twice | — |
| **Folio already closed / guest already checked out by someone else** | Conflict banner: "Checked out by Hira at 11:41" | Review |

---

## 5. Screen inventory

Status: **B** = built in this pass · **E** = existing screen reused inside the new shell · **L** = later.

| Screen | Purpose | One primary action | Status |
|---|---|---|---|
| App shell | Orientation, search, alerts, state | Search | **B** |
| Command palette | Find anything / run a command | Open result | **B** |
| Today — front desk and manager | The work queue: arrivals, departures, in house, exceptions | Open the most urgent item | **B** |
| Today — housekeeper | Rooms in urgency order, one-tap status | Start / Finish | E (my rooms) |
| Today — maintenance | Assigned issues | Update status | E |
| Reservations list | Search and filter | Open | **B** |
| **Reservation workspace** | The canonical place for a stay (guest, stay, room, requests, tasks, folio, timeline) | Context-dependent (Check in / Settle and check out / Move) | **B** |
| Check-in workflow | Workflow A | Check in | **B** |
| Move-room side panel | Workflow B | Move to … | **B** |
| Checkout workflow | Workflow C | Settle / Check out | **B** |
| Inbox | Shared queue of items waiting on someone | Open item | **B** |
| Rooms (live status) | Which rooms are ready | Open room / move | **B** |
| Calendar (rack) | Occupancy over time | Open stay | E |
| Housekeeping board, Issues, Lost & found | Supervisor tools | Assign | E |
| Guests directory / profile | Find and view a guest | Open | **B** (directory) |
| Tasks & Maintenance, Reports, Administration | Existing screens grouped under their section | — | E |
| Shortcut help | `?` | — | **B** |
| Registration-card capture by camera, bulk actions on lists, guest messaging inbox, saved views | — | — | **L** |

---

## 6. Status model

Every status is shown as **icon + label + tone**. Colour never carries meaning alone. Statuses are grouped by what they describe, so the same word is never used for two different things.

**Attention level** (applies to any item in a queue — it decides order and loudness):

| Level | Icon | Tone | Meaning |
|---|---|---|---|
| **Blocker** | ⛔ (stop) | Error | Stops the next step until resolved |
| **Needs action** | ▲ (warning) | Warning | Should be handled today; does not stop the step |
| **Information** | ⓘ | Info | Useful context |
| **OK / done** | ✓ | Success | Nothing to do |

**Reservation status**

| Status | Icon · Label | Tone |
|---|---|---|
| Option | ◔ Held | Warning |
| Confirmed | ◉ Confirmed | Info |
| Checked in | ● In house | Success |
| Checked out | ✓ Departed | Neutral |
| Cancelled | ✕ Cancelled | Neutral |
| No-show | ✕ No-show | Error |
| At risk (unguaranteed) | ▲ At risk | Warning |

**Room status** (two separate facts, shown together as "Room 201 · Cleaning · Vacant")

| Housekeeping | Icon · Label | Tone |
|---|---|---|
| Dirty | ○ Dirty | Error |
| Cleaning | ◔ Cleaning | Warning |
| Clean | ● Clean | Info |
| Inspected | ✓ Ready | Success |
| Out of order / service | ⛔ Out of service | Error |

| Occupancy | Label |
|---|---|
| Vacant, Occupied, Arriving today, Due out today | plain words, neutral |

**Readiness for an arrival** (derived): *Ready* (assigned + clean/inspected) · *Not ready* (assigned, dirty/cleaning) · *No room assigned* · *Room blocked* — shown on every arrival row.

**Money**

| Status | Icon · Label | Tone |
|---|---|---|
| Balance due | ▲ Owes PKR 6,900 | Warning |
| Paid in full | ✓ Paid | Success |
| Overpaid | ⓘ Credit PKR 500 | Info |
| Waiting for verification | ◔ Transfer waiting | Warning |
| Billed to company | ⓘ On company account | Info |

**Tasks and issues:** urgency (Urgent / High / Normal / Low), owner (name or *Unassigned* — itself a warning), deadline (relative: "due in 2 h", "overdue 40 min"), blocker flag ("Room out of service").

**System state:** Online · Syncing · Offline (n waiting) · Conflict (needs review) · Could not save (retry).

---

## 7. Design tokens and component inventory

### Colour (all pairs measured against WCAG 2.2: text ≥ 4.5:1, UI boundaries and focus ≥ 3:1)

| Token | Value | Use | Contrast |
|---|---|---|---|
| `--bg` | `#f6f4ef` | warm neutral page | — |
| `--surface` | `#ffffff` | cards, tables, panels | — |
| `--ink` | `#1f2933` | primary text | 14.8:1 on surface, 13.4:1 on bg |
| `--ink-muted` | `#52606d` | secondary text | 6.5:1 / 5.9:1 |
| `--line` | `#dcd7cb` | decorative dividers | — |
| `--line-strong` | `#7b8794` | input and control borders | 3.7:1 on surface |
| `--brand` | `#0f4c5c` | primary action, current nav | 9.5:1 with white |
| `--nav-bg` | `#13384a` | navigation rail | 10.6:1 with `#e6eef0` |
| `--focus` | `#0b5cad` | 3 px focus ring (+ 2 px offset) | 6.7:1 on surface |
| success | text `#1e6b3a` on `#e6f4ea` | done, ready | 5.7:1 |
| warning | text `#8a4b00` on `#fdf0d9` | needs action | 6.0:1 |
| error | text `#a4262c` on `#fde8e8` | blocker, failure | 6.2:1 |
| info | text `#0b5cad` on `#e4effa` | context | 5.7:1 |
| neutral | text `#3e4c59` on `#e9e6df` | done, departed | 7.1:1 |

One accent only (`--brand`). Semantic colours are reserved for status; they are never used for decoration. Dark mode follows the system setting with equivalent tokens.

### Type, space, shape

- **Font:** system sans stack (legible on low-end Android and Windows, no download), Urdu falls back to Noto Nastaliq/Naskh. Sizes (px): 12 caption · 14 body (dense tables) · 16 body (forms, mobile) · 20 section title · 24 page title. Weights 400 / 600 / 700. Line height 1.45. Numbers tabular.
- **Spacing:** 8-point scale — 4 · 8 · 16 · 24 · 32 · 48 (4 only inside components).
- **Radius:** 8 (controls, cards), 12 (panels). **Elevation:** one level for drawers and popovers; otherwise borders, not shadows.
- **Touch target:** ≥ 44×44 px on touch devices; ≥ 32 px high on desktop dense tables with 44 px hit areas for the primary row action.
- **Motion:** 120–160 ms opacity/position only for drawers and focus; none for data. `prefers-reduced-motion` removes it entirely.

### Components

| Component | Notes |
|---|---|
| App shell, nav rail (collapsible), bottom nav, top bar | landmarks (`header`, `nav`, `main`), skip link, collapsed rail keeps labels as tooltips + `aria-label` |
| Property selector, business-day label | |
| Command palette | combobox + listbox semantics, arrow keys, `Esc`, results grouped |
| Alerts popover, system-state indicator | live region for count changes (polite) |
| Status badge | icon + label + tone; the only way statuses are shown |
| Attention banner | Blocker / Needs action / Info; stackable; each has one action |
| Queue row | status, who, where, **blockers**, one action; whole row is the target |
| Data table | dense, sortable, sticky header, keyboard row focus, selectable (bulk later); becomes **action list** on a phone |
| Split view / context rail | list + detail on desktop; rail shows guest, stay, room, balance wherever you are in the workspace |
| Side panel (drawer) | quick inspection and light edits; focus trapped, `Esc` closes, returns focus to the trigger; never stacked on another dialog |
| Workflow page | stepper + sticky action bar, autosave indicator, blockers on top |
| Save-state indicator | idle · saving · saved · failed · offline · conflict |
| Conflict banner | says what changed, who, when; one action: Review |
| Form field | label above, hint, error text tied by `aria-describedby`, required marked in words |
| Tabs, filter chips (≤ 5 visible), search, date field | |
| Timeline | chronological, actor + time + reason; financial events marked |
| Confirmation card | persistent result of a completed action, with Undo where valid |
| Empty / loading (skeleton) / error / offline / permission blocks | see §9 |
| Toast | **supplementary only**; never the sole confirmation |

---

## 8. Responsive decisions

| Breakpoint | Layout |
|---|---|
| **≥ 1200 px** (front desk, management) | Rail (224 px, collapsible to 64) · main · optional **context rail** (320 px) in the workspace. Three things visible at once: queue, selected stay, its balance. Dense tables, keyboard shortcuts, multi-select. |
| **900–1199 px** (tablet landscape) | Rail collapsed by default; context rail becomes a panel above the content. |
| **< 900 px** (phone) | One task at a time. Bottom navigation (4 + More). Sticky primary action bar above the keyboard. Tables are **not shrunk**: each becomes a prioritised list where a row = status + who + the one fact that matters + the action. Side panels become full-screen sheets. |

Mobile specifics: touch targets ≥ 44 px; large status controls for housekeeping (Start / Finish as full-width buttons); one-handed reach (primary actions at the bottom); no hover-only interactions; numeric keypads for amounts and ID numbers; camera upload is part of the design for maintenance photos and ID capture and is **not built here** (it needs a file-storage and retention decision first; see §10).

Reading order and focus order match visual order in both LTR (English) and RTL (Urdu); layout uses logical properties so the rail, context rail and sheets mirror correctly.

---

## 9. Empty, loading, error, offline, permission and conflict states

| State | Principle | Example copy |
|---|---|---|
| **Empty** | Say why it is empty and what to do; never a blank page | Arrivals: "No arrivals left today. Next arrival: 14:00 tomorrow." · Inbox: "Nothing is waiting on you." |
| **Loading** | Skeleton of the real layout; keep previous data visible while refreshing; no spinner-only screens | |
| **Error (cannot load)** | What failed, what is still true, Retry | "Could not load today's arrivals. Showing the list from 23:41." |
| **Error (action failed)** | Inline, next to the action, in words from the server's own message; the form keeps its input | "The room is no longer free. Rooms still free: 202, 204." |
| **Offline** | System state shows it; read screens show last good data **with its age**; actions that need the server are disabled with the reason; housekeeping actions queue and say so | "No signal — 2 changes will be sent when you are back online." |
| **Permission** | Absent control, or disabled with who can do it; one-tap request to a manager through the Inbox | "Leaving with a balance needs a manager. Ask a manager." |
| **Conflict / stale** | Detect by polling and by the server's refusal; banner states what changed, by whom and when; the primary action is disabled until the user reviews | "Hira checked this guest in at 23:41. Review changes." |
| **Saving drafts** | Always one of: Saving… · Saved on this device 23:44 · Could not save — Retry · Offline — kept on this device · Changed by someone else — Review | |
| **Session expired / second factor needed** | Inline step-up prompt on the same page; unsaved input kept | |

**Confirmation rules.** Financial, destructive, irreversible and guest-impacting actions state the consequence in the primary button ("Take PKR 6,900 cash", "Check out Mr Siddiqui") and require an explicit action; reversible actions apply at once and show **Undo** in the timeline and in a persistent card.

---

## 10. What is built in this pass, and what is not

**Built:** the shared application shell (property selector, business day, search and command palette, alerts and inbox entry, system-state indicator, role and profile menu, collapsible role-adaptive navigation, hash routing that preserves property, filters and scroll, keyboard shortcuts and help); the **Today** work queue for front desk and manager; the **Reservations** list; the **Reservation workspace** with its context rail; the three flows — **late-arrival check-in**, **move room**, **checkout with a balance** — with their exceptions; **Inbox**; live **Rooms** status; a **Guests** directory; the design tokens and the shared components above. All existing screens remain, reachable under their new section.

**Deliberately not built (and why):**

- **Camera capture of IDs and photos** — needs a storage and retention decision for identity images before anything is stored.
- **Housekeeping priority request and "undo move"** — there is no endpoint to prioritise one room's cleaning, and a move cannot be reversed without dirtying a room; both would need server work first.
- **Registration-card printing from the check-in page** — the printable card is on a separate open branch (gate and registration card) and will join the done-card when it merges.
- **Card gateway outage handling** — there is no card gateway yet (card slips are entered by hand), so there is nothing to be "down"; the outage message used for server failures covers the case.
- **Upgrade as part of a room move** — the system moves guests within the booked room type; an upgrade needs a room-type change on the booking first (the panel says so).
- **Guest messaging inbox** — the system links to WhatsApp but has no message store; showing an empty "Messages" tab would be a lie.
- **Bulk actions on lists** — designed in §7 (selectable tables) but no bulk-capable endpoints exist yet.
- **Dark mode polish, saved views, notifications settings** — later.

**How we will know it works (usability test, not built here):** five unaided tasks with someone who has never seen the product — *find today's arrivals that have a problem; check in a late guest with no ID on file; move a guest because the room is not ready; check out a guest who owes money; find where a bank transfer is waiting for approval*. Success = each task completed unaided in the target time, and the participant can say, without looking, what needs attention right now.


**Known deviation from "no stacked dialogs".** Two interrupts still appear above a page that is itself a workflow: the second-factor prompt (a security step the server demands, shown by the existing step-up component) and the payment form (the existing payment sheet, reused so the cash/card/transfer rules stay in one place). Both are the *only* dialog open at that moment — they are never opened over a side panel — and both keep what the person typed. Replacing them with inline forms is the next design step.
