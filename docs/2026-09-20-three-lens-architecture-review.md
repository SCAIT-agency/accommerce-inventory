# Three-Lens Architecture Review — 2026-09-20

Full re-review of the whole codebase and product, at the user's request, after Streams A-H. Three independent fresh reviews, each with no context on the others or on this engagement's own self-assessment, each opus-model, each told to explore the repo cold and verify every claim against real code:

1. **Operational excellence** ("Кук" — the Tim Cook lens): does this actually hold together in real day-to-day supply-chain operation?
2. **Product coherence** ("Джобс" — the Steve Jobs lens): is this one considered product, or features from different eras bolted together?
3. **Engineering rigor** ("Борис Черний" — the Boris Cherny lens): is the type safety, architecture, and code quality real or theater?

This document preserves all three reports verbatim (lightly reformatted) as a durable reference. See `docs/BACKLOG.md` section I for what was fixed immediately versus what remains tracked for future work.

---

## Lens 1: Operational Excellence (Cook)

I've read the docs, all of `server/*.ts`, the schema, the migrations, `RAILWAY.md`, the scripts, and every client page. Findings below are from reading the actual code (I did not run the app or the suite).

### Critical Operational Gaps

**1. There is no way to enter a bank transaction — the entire Cashflow/matching loop has no live input.**
`payments.recordTransaction` exists and is wired at `server/routers.ts:194`, but no client page calls it (grep of all `trpc.*.use*` in `client/src` returns 39 procedures; `recordTransaction` is not among them). `TransactionsPage.tsx` only *lists* and *matches*. So after go-live the `transactions` table can only ever be populated by the one-time migration script. Home's "Unmatched transactions" (`dashboards.ts:61,87`) is permanently 0, actual-vs-planned cash is permanently one-sided, and the Transactions page is a permanently empty screen with a matching dropdown on it.

**2. Purchase Order status can never be advanced from the UI.**
`purchaseOrders.updateStatus` has a full state machine (`purchaseOrders.ts:6-14`), a router procedure (`routers.ts:56-58`), and tests — but `PurchaseOrdersPage.tsx:382` renders status as a read-only badge and the page never calls it. Every PO created in the live app stays `draft` forever. This is exactly the "built, tested, unreachable" class Stream A claims to have closed; the backlog's section A enumerates shipment progression, payments, sales plan, and transaction matching — PO status is not on the list and was not checked.

**3. The one job that depletes stock is neither scheduled nor written.**
There is no Shopify API client anywhere in the repo (grep for `shopify` returns only `shopifyDailyPull.ts` and its CLI wrapper). `scripts/run-daily-shopify-pull.mjs` takes a hand-exported JSON file path. `RAILWAY.md:68` adds exactly one cron — the nightly export. Nothing schedules the sales pull. "Sales happen → stock depletes" is a daily manual chore with no schedule, no retry, and no alerting.

**4. Freight/duty can be edited after arrival, permanently desyncing the ledger from the Landed Cost dashboard.**
`recordShipmentCosts` (`shipments.ts:158-189`) has no status guard, and `ShipmentsPage.tsx:391-440` renders the cost form for every shipment at every status including `delivered`. `markShipmentArrived` bakes the landed unit cost into `inventory_ledger.unitCost` at arrival time (`shipments.ts:252-260`), while `getShipmentLandedUnitCost` recomputes live from the shipment row (`landedCost.ts:69-70,103-106`). Correct the freight after the container lands — the normal case, since the forwarder's invoice arrives late — and you get two authoritative landed costs for the same shipment that never reconcile, with no warning. `costCurrency` changes aren't even written to `change_log` (only freight and duty are, `shipments.ts:166-186`).

**5. No reversal, no adjustment, no stock count — anywhere.**
`recordLedgerEvent` has exactly three live callers: the sales pull, shipment arrival, and the migration script. No code path in the app ever writes an `"adjustment"` event (confirmed by the author's own comment at `inventoryLedger.ts:86`). The only `delete` statements in the entire server are against `sales_plan` (`salesPlan.ts:225,271,297`). So: a wrong receipt qty, a wrong warehouse, a wrong landed cost, a mistakenly-paid payment, a mis-keyed transaction — none can be corrected or reversed by any operator action. The only table the system will happily destroy data in is the planning table; the money and stock tables are write-once with no compensating entry. For a system whose stated purpose is to *replace* a spreadsheet where every cell is editable, this is the largest single day-one gap.

**6. The shipment create form invites a silent 3x cost inflation.**
`ShipmentsPage.tsx:460-461` defaults `weightShare`/`valueShare` to `"1.0"` per line item, with no validation that they sum to 1.0 across the shipment and no on-screen total. `landedCost.ts:104-105` multiplies the shipment's **total** freight and duty by each line's share. A 3-line shipment left at the defaults allocates 100% of freight to each line — landed costs inflated ~3x, written into the ledger at arrival, unrecoverable per (5). Nothing validates shipped qty against the PO line's ordered qty either (`routers.ts:77`, `shipments.ts:42-46`), so over-shipping a line or shipping the same line twice both write real inventory.

> **Status: (6) fixed 2026-09-20** — `getShipmentLandedUnitCost` now validates every line's weightShare/valueShare is finite and in [0,1], and that all lines' shares sum to 1 (within tolerance) before computing any cost. See BACKLOG.md section I.

### Silent Failure Risks

**7. The daily pull treats a real data-integrity failure as "expected" and exits 0.**
`shopifyDailyPull.ts:85-87` catches *every* error into `skipped` with a reason string; `RAILWAY.md:115` documents "Exits 0 even when rows are skipped (skipping is expected, not a failure)." The most likely error in production is the negative-stock guard (`inventoryLedger.ts:25-30`), which fires exactly when the ledger is behind physical reality — i.e. when a container physically arrived but hasn't been marked arrived yet (which requires the freight invoice first, per `shipments.ts:223-228`). Result: that SKU's sales silently vanish for every day in the gap. No `sales_actuals` row, no ledger event, green cron, SOH overstated, COGS understated, days-of-cover wrong. The only trace is a console line nobody is watching.

**8. Backdating an arrival silently rewrites already-reported history.**
COGS is recomputed from ledger history on every read (`salesPlan.ts:132-171`). Marking a shipment arrived with a past date inserts a receipt batch earlier in the FIFO chain, changing the Daily COGS for every intervening day that has already been reported. Nothing flags the retroactive change. This is the direct flipside of the ledger-centric design and is documented nowhere.

**9. Free-text money fields with no numeric validation reach `parseFloat` and become `NaN`.**
`routers.ts:169,178-179,102-104,53` type `expectedAmount`, `amount`, `fxRate`, `freightCost`, `dutyCost`, `unitPrice` as bare `z.string()`. The UI inputs are `type="text"` (`PurchaseOrdersPage.tsx:210,92-103`; `ShipmentsPage.tsx:393-410`). Typing `1,200.00` gives `parseFloat` → `1`; typing anything non-numeric gives `NaN`. `markPaymentPaid` then stores `"NaN"` in `baseCurrencyAmount` (`payments.ts:33`), and a `NaN` freight cost propagates through `landedCost.ts:106` into `unitCost.toFixed(6)` = `"NaN"` written permanently into `inventory_ledger`, poisoning FIFO COGS forever. Notably, Stream H *did* add exactly this validation to the sales-plan inputs (`salesPlan.ts:191-210`) and to nothing else.

**10. A lowercase currency typo takes down both Home and Money.**
`cashflow.ts:31` compares currency to `"EUR"` case-sensitively and `DEFAULT_STANDARD_FX_RATES` (`cashflow.ts:26-28`) is keyed `"USD"` only. Currency is a free-text input defaulting to `"USD"` (`PurchaseOrdersPage.tsx:219-224`). Enter one payment as `"eur"` and another as `"EUR"` and `distinctCurrencies.size === 2` → `getStandardFxRate("eur")` throws (`cashflow.ts:35-39`). `getHomeSummary` calls it un-caught at `dashboards.ts:62` and `getMoneyDashboard` at `dashboards.ts:115`, so both dashboards hard-fail. The documented remedy is an `app_settings` key — and `setAppSetting` (`db.ts:47`) is exposed by no router procedure, so fixing it requires direct SQL against production. The same applies to CNY, which the spec itself names as a real Jello payment currency (`spec.md:116`) and which has no default rate.

> **Status: fixed 2026-09-20** — currency codes are now normalized to uppercase before comparing/grouping. See BACKLOG.md section I. (The `app_settings` mutation-procedure gap remains open.)

**11. Matching a transaction doesn't mark the payment paid — the money then hides in a dead zone.**
`matchTransactionToPayment` (`payments.ts:96-116`) sets only `matchedPaymentId`. `getCashflowForecast` keys planned-vs-actual off `payments.paid` (`cashflow.ts:65,94`), while `listUnpaidPayments` filters out anything matched (`payments.ts:140-145`). So a matched-but-not-marked-paid payment counts as a *planned future outflow forever*, never appears as actual, and can no longer be selected in the matching dropdown. There is no unmatch path. The two functions hold two different definitions of "paid."

**12. Overdue payables are invisible.**
`getCashflowForecast` only picks up unpaid payments whose `expectedDate` falls inside the queried window (`cashflow.ts:62-65`), and Home queries `now → now+14d` (`dashboards.ts:62`). A payment that was due last week and is still unpaid drops out of "near-term cash needs" entirely. In a supply-chain cash system, the overdue bucket is the one you most need on the front page.

**13. The Money page silently reports one arbitrary SKU as if it were the business.**
`MoneyPage.tsx:15-17` picks `skusQuery.data?.[0]`, `warehousesQuery.data?.[0]`, `shipmentsQuery.data?.[0]` — first row of each list, no picker, no label on screen. The "Daily COGS/Sales" tab therefore shows one arbitrary SKU at one arbitrary warehouse, and "Landed Cost" shows the oldest shipment, both presented as the headline number. The code comment at `MoneyPage.tsx:7-10` calls this a V1 placeholder, but the tab labels don't. Separately, `getMoneyDashboard` only computes COGS when *both* a SKU and a warehouse are given (`dashboards.ts:119`) — there is no aggregate Daily COGS at any level, which is the number the Control Tower actually produces.

**14. The SKU most likely to stock out is structurally excluded from the stockout count.**
`getSohForSkus` groups over `inventory_ledger` (`inventoryLedger.ts:54-62`); a SKU with no ledger rows returns an empty array, so `dashboards.ts:99-105` emits `byWarehouse: []` and the SKU renders no rows on the Stock page and contributes nothing to `stockoutRiskSkuCount` (`dashboards.ts:71-80`). A newly-created SKU, or one never received at a given warehouse, is simply absent rather than shown at zero.

**15. SKU lookup for the sales pull can attribute sales to the wrong product.**
`run-daily-shopify-pull.mjs` builds `skuLookup` from `s.sku` only, via `Object.fromEntries`. `skus.sku` carries no unique constraint (`drizzle/schema.ts:29`) — uniqueness is on the composite `(primaryIdentifierType, identifierValue)` (`schema.ts:55`). Two SKUs sharing a `sku` string under different primary types is legal; `Object.fromEntries` silently keeps the last, and that day's sales deplete the wrong product. Any SKU whose primary identifier is `name` (creatable via `routers.ts:37`) is invisible to the pull and lands in `skipped` as "unknown SKU."

### Deployment/Readiness Gaps

**16. Schema migrations are not in the deploy pipeline, and the documented command is the wrong one for production.**
`RAILWAY.md:25-26` sets Railway to auto-deploy on push to `main` with build `pnpm build` and start `pnpm start` — neither runs migrations. `RAILWAY.md:32` says run `pnpm db:push` once, manually. So the first schema change merged after go-live ships code that queries columns that don't exist, until a human remembers to run a CLI against production. Worse, `db:push` is `drizzle-kit generate && drizzle-kit migrate` (`package.json`) — running `generate` against production can author a *new* migration file at deploy time rather than just applying the committed chain. Production should run `drizzle-kit migrate` alone, as a release step.

**17. The nightly export — the stated human-readable backup — will not survive real data volume.**
`runNightlyExport` does `db.select().from(table)` with no bound, for all 13 core tables including `inventory_ledger`, materializes every row in Node, then builds one array of every line and joins it (`nightlyExport.ts:52-57`, `22-35`). At Jello's volume (thousands of sale events/day) `inventory_ledger` passes a million rows inside a year and this OOMs a Railway container. There is no retention or rotation on `/data/exports` (`RAILWAY.md:68-74`) so the volume fills, and no alerting on failure. `spec.md:32` sells this as the thing that gives "the same peace of mind Google Sheets gives today."

**18. No monitoring, alerting, or restore drill anywhere.** `RAILWAY.md` enables TiDB managed backups (step 3) and never mentions verifying a restore, alerting on a failed cron, or what to do when the parallel-run check fails. The three CLI scripts print to stdout and exit; nothing watches them.

### Cross-Stream Inconsistencies

**19. Two live, mutually destructive writers to `sales_plan` sit on the same page.**
`StockPage.tsx:358` renders the Stream A manual per-day entry form; `StockPage.tsx:359` renders the Stream H weekly generator directly below it. `upsertWeeklyInput` unconditionally deletes every row for the previous recipe's SKUs across that week (`salesPlan.ts:271-275`) and `regenerateSalesPlanForWeek` deletes again before inserting (`salesPlan.ts:225-229`). A manual entry for a SKU in the recipe is silently wiped by the next weekly save; a manual entry for a SKU *not* in the recipe survives forever and is invisible in the weekly grid. Neither UI mentions the other.

> **Status: fixed 2026-09-20** — the manual "Add plan entry" form removed from Stock; only the read-only Plan vs Actual report remains. See BACKLOG.md section I.

**20. The same currency string is handled case-insensitively in one module and case-sensitively in another.**
`landedCost.ts:96` deliberately normalizes case ("Currency codes are freeform text at input time"). `cashflow.ts:31` compares exactly. Same free-text inputs feed both. Stream E fixed one and never looked at the other.

> **Status: fixed 2026-09-20** — see (10) above.

**21. The same estimated number is flagged in one place and presented as exact in another.**
`MoneyPage.tsx:59,65-67` renders `≈` and an explanatory footnote when `plannedOutflowIsEstimated`. `getHomeSummary` sums the identical `plannedOutflow` values (`dashboards.ts:63`) and `HomePage.tsx` prints them as a bare two-decimal figure with no marker and no currency label.

**22. Audit coverage is inconsistent across the money tables.** `payments` and `transactions` have no `createdBy` column at all (`schema.ts:173-201`) and neither `createExpectedPayment` nor `recordTransaction` writes a `change_log` row (`payments.ts:15-19,90-94`) — so who entered a six-figure expected payment is unrecoverable, while every PO date nudge is fully audited. `markShipmentDeparted` logs the actual depart date with no `reasonCategory` at all (`shipments.ts:146-155`), which is precisely the planned-vs-actual delay signal the fixed taxonomy exists to aggregate (`spec.md:81`).

**23. Stream D's N+1 cleanup stopped at the three dashboard functions.** `listShipmentsForPo` loads *every* shipment line item and *every* shipment and filters in JS (`shipments.ts:63-68`); `listUnpaidPayments` loads every transaction and every purchase order on each call (`payments.ts:135-139`); `listShipments`/`listTransactions`/`listPurchaseOrders` are unpaginated full-table reads. On the client, `ShipmentsPage.tsx:348` fires a `getWithLineItems` query per shipment row and `PurchaseOrdersPage.tsx:421` fires a `listForPo` query per PO row, both across unpaginated lists.

### What's Actually Solid

This is not a demo dressed as a system — several things genuinely hold up:

- **The fail-loudly discipline on the arrival path is real and well-judged.** `markShipmentArrived` refuses to write a receipt without recorded freight/duty/currency (`shipments.ts:223-228`) rather than quietly booking an EXW-only cost; `updateShipmentStatus` refuses `departed` and `delivered` outright (`shipments.ts:99-110`) so there is exactly one code path to each transition; the ledger write and the status change are in one transaction (`shipments.ts:233-262`); the landed-cost currency guard throws rather than blending (`landedCost.ts:96-102`). These are the choices an operations lead would make.
- **The single-source-of-truth invariant is actually enforced, not just asserted.** SOH, COGS, and cashflow are all computed from `inventory_ledger` and `payments` on read — there is no cached SOH column anywhere to drift, which is the failure the spec was written to avoid (`spec.md:18`).
- **`recordSalesActual` wraps the `sales_actuals` insert and the ledger event in one transaction** (`salesPlan.ts:43-60`) so a guard rejection can't leave an orphaned actual — the automated path goes through the same validation as manual entry, exactly as `spec.md:67` promised.
- **The same-day event-ordering fix is subtle and correct.** End-of-day anchoring for whole-day sales aggregates plus an end-of-day solvency horizon in the guard (`inventoryLedger.ts:23`, `salesPlan.ts:55`) makes same-day events mutually visible regardless of insertion order — a genuinely non-obvious problem, solved, with the residual ordering asymmetry honestly documented at `inventoryLedger.ts:79-89`.
- **The code comments are unusually honest about their own limits.** The TOCTOU race (`inventoryLedger.ts:6-15`), the dormant adjustment-ordering risk, the `getDailyCogsForRange` equivalence caveats (`salesPlan.ts:114-124`) — these are real engineering notes, not decoration, and they made this review much faster.
- **`runMigration` throwing on an unwired `landedCostTotals` rather than silently running zero comparisons** (`RAILWAY.md:84`) is the right instinct applied in the right place.

The honest summary under this lens: the *calculation engine* is in good shape and the write paths that exist are well guarded. What's missing is the operator's half of the system — no correction path for anything, no live transaction entry, no PO progression, no scheduled sales ingest, and validation that stops at the tRPC boundary while every money field arrives as free text from a `type="text"` input.

---

## Lens 2: Product Coherence (Jobs)

I've read every page, the nav, the stylesheet, and verified the key backend behaviors behind the UI claims.

### The One-Sentence Verdict

This is a meticulously engineered **database admin panel wearing a supply-chain product's name** — eight hardening streams made the machinery trustworthy, but nobody ever asked what a supply-chain manager needs to *see and decide* at 8am, so the app can tell you a SKU is red and has no way to tell you what to order, when, or from whom.

### Where the Product Feels Considered

Credit where it's real:

- **`client/src/index.css` is genuinely good taste.** The one styling pass (IBM Plex Sans for UI / Plex Mono for figures, semantic status tokens, pill badges rather than color-blocked rows, a real dark-mode palette) shows someone who understands that a ledger reads fastest in tabular figures. The comment at `index.css:254-257` — "A pill, not a color-block: semantic color is a signal, not the whole surface" — is a product-taste sentence.
- **The Stock page's core table is the one screen that works.** `StockPage.tsx:328-357`: SKU, warehouse, SOH, avg daily sales, days of cover, status badge, drill-down to batches. That's a supply-chain person's mental model, rendered directly, with the one useful link in the entire app (`StockPage.tsx:352` → `/inventory-ledger/...`).
- **`TransactionsPage.tsx:13` is the app at its best** — the match dropdown renders `poNumber — #seq — amount currency`. A human-readable join, done once. It proves the team *could* do this everywhere and shows how alien the rest of the app feels by comparison.
- **The `≈ estimated` FX disclosure** (`MoneyPage.tsx:59,65-67`) is a small act of honesty most internal tools skip.
- **The reason-category discipline** is a genuinely good product idea. Forcing "why did this date move?" at the moment of the edit is exactly how you build an institutional memory a Sheet can never have. The idea is right. The execution buries it (see below).

### Where It Falls Apart as ONE Product

**1. The app's single most-repeated tax pays into a ledger nobody can open.**

Every mutating action demands a reason category — I count seven distinct dropdowns across `ShipmentsPage.tsx` (lines 133, 193, 252, 315, 411) and `PurchaseOrdersPage.tsx` (110, 390). And the Change Log page that this data feeds is **completely unreachable**. Grep across `client/src` for `change-log` returns exactly one hit: the route definition at `main.tsx:114`. No `<Link>`, no button, nothing. The only `<Link>` in the entire application is the "Batches" one on Stock.

So a user pays the toll dozens of times a day and can never collect. Meanwhile `PurchaseOrdersPage.tsx:144-164` implements a *second, different* history UI (inline, expandable, payments-only) — two audit-trail interfaces, one orphaned, one hidden inside a table cell, neither aware of the other.

**2. The two Sales Plan sections on one page silently destroy each other's work.**

`StockPage.tsx:358-359` stacks `SalesPlanSection` (Stream A: pick SKU, warehouse, date, type a qty) directly above `WeeklySalesPlanSection` (Stream H: revenue + per-SKU recipe + warehouse split). They write to the same `salesPlan` table. `regenerateSalesPlanForWeek` (`server/salesPlan.ts:225-232`) **deletes every `salesPlan` row** for the recipe's SKUs across both warehouses for that entire week before reinserting. Your hand-entered Tuesday adjustment is gone the next time anyone touches that week's revenue number. Nothing in the UI hints at this.

That is the clearest evidence of the "features from different eras" problem: Stream H solved the planning grain properly and then Stream A's obsolete control was left sitting on top of it, still labeled "Add plan entry", still functional, still a trap.

> **Status: fixed 2026-09-20** — see BACKLOG.md section I.

**3. The app speaks in primary keys.**

`ShipmentsPage.tsx:387` renders `SKU {li.skuId} — qty {li.qty}`. Line 480: `SKU {li.skuId} — qty {li.qty} @ {li.unitPrice}`. Line 533, and `PurchaseOrdersPage.tsx:339`, same. `MoneyPage.tsx:88` renders `{row.skuId}` under a column header that says **"SKU"**. `InventoryLedgerPage.tsx:12` opens with "SKU #17, warehouse #3".

The app has the names. `catalog.listSkus` is already called on four different pages. Someone running this brand does not know that Jello Mixer is `#17`, and after a week of this app they will have memorized the integers — which is the app training the human to be a database.

**4. Four different date formats, one app.**

`.toISOString().slice(0,10)` in Shipments and Transactions; raw `Date.toString()` at `PurchaseOrdersPage.tsx:383`, `:82`, `:90` and `ChangeLogPage.tsx:24` (which renders `"Fri Sep 20 2026 00:00:00 GMT+0300 (Eastern European Summer Time)"` into a table cell); bare server strings in `MoneyPage`. Nothing anywhere uses a European format, for a DACH brand.

**5. No currency symbol on any money in the app.** `HomePage:13`, `MoneyPage:59,60,75,88`, every cashflow and COGS figure — bare `.toFixed(2)`. Meanwhile the currency the user must *type by hand* is a free-text input (`ShipmentsPage.tsx:405-410`, `PurchaseOrdersPage.tsx:219-224,292`) with placeholder "currency" and no validation, feeding a landed-cost engine that the README says throws hard on a currency mismatch. Type `usd` instead of `USD` and you find out weeks later.

### The Front Door Problem

`HomePage.tsx` is 18 lines. Four numbers in a `<dl>`. No links, no dates, no currency, no trend, no action.

```
Active SKUs                    47
Stockout-risk SKUs              6
Near-term cash needs (14d)   82431.00
Unmatched transactions          3
```

Three problems, in ascending severity:

1. **Nothing is clickable.** Six SKUs are at risk — *which six?* The user reads the number, then navigates to Stock, then re-scans a table to re-derive the same six. The app already computed the set (`dashboards.ts:66-81`) and threw it away to return a count.

2. **The front door is less honest than the inner room.** `nearTermCashNeeds` sums `plannedOutflow` from the same forecast that `MoneyPage.tsx:65-67` carefully flags with "≈ estimated using a standard FX rate." Home strips the caveat and prints a confident 8-digit figure with no currency. The one number on the wall that a founder would quote in a meeting is the one number the app stopped qualifying.

3. **The threshold behind "Stockout-risk" has no relationship to this business.** `dashboards.ts:14-19` hardcodes critical <21 days, low <45, ok <90, above a comment admitting these are V1 placeholders. This brand's replenishment lead time is ~66 days. A SKU at 30 days of cover is already **unrecoverable** — you cannot get goods from China in time — and this app paints it yellow and excludes it from the risk count. The number that matters most on the front door turns red only after it's too late to act.

And that points at the deepest gap: **`drizzle/schema.ts` has no lead time, no safety stock, no reorder point, no MOQ** — I grepped, there are no such columns on any of the 17 tables. Stock shows on-hand only; there is no "on the water" or "on order" column anywhere, even though the app knows every open PO and departed shipment. A tool built to replace the Control Tower cannot answer the two questions the Control Tower exists to answer: *what do I order, and when.*

The right Home page for this app is not four counters. It's: **"These 4 SKUs must be ordered this week or you stock out"** — each one a link to a pre-filled PO — and **"€82,431 leaves the account in the next 14 days, €60k of it on Sep 28."** Everything else is a supporting detail.

### Confusing or Redundant Controls

- **`ShipmentsPage.tsx:366-443` — the Status cell is a four-panel control room.** For a departed shipment, one table cell simultaneously renders `StatusTransitionControl`, `CustomsArrivalControl`, and `DepartDateCorrectionControl`, each with its own independent reason dropdown (lines 193, 252, 315) defaulting to a *different* value (`logistics_delay`, `customs_hold`, `logistics_delay`), plus the costs form's fourth dropdown at line 411 defaulting to `freight_rate_change`. Four identical-looking 9-option snake_case selects and three date inputs, in one cell, in a table clamped to 1100px by `index.css:146-151`. Nobody could design this on purpose; it's four work streams each appending their control to the same `<td>`.

- **`ShipmentsPage.tsx:228-295` — `CustomsArrivalControl` renders unconditionally.** Unlike its three siblings it has no status guard, so a `planned` shipment that hasn't left the factory shows a **"Save arrival date"** button. The server correctly rejects it (`server/shipments.ts:220`) — and the user gets `Failed to save: markShipmentArrived: invalid transition from planned to delivered`. The app shows you a button it knows cannot work and then answers in the voice of the developer who wrote the guard. Same at `shipments.ts:223-227`, where the user is told to run `recordShipmentCosts` — a function name, shown to a supply-chain manager, when the freight field they need is visible in the next cell over.

  Separately: "Save arrival date" is a dangerously modest label for an action that marks the shipment delivered *and* writes irreversible inventory receipts at landed cost. (One line, per scope: the README notes no reversal path exists anywhere in the codebase.)

- **`StockPage.tsx:321-326` vs `MoneyPage.tsx:46-50` — two tab idioms, both broken.** Stock signals the selected warehouse by `disabled`-ing its button, which `index.css:246-252` renders grey with `cursor: not-allowed` — so the warehouse you're looking at appears *unavailable*. Money's three tabs have no selected state at all; you infer which tab you're on from the table below.

- **`MoneyPage.tsx:15-17` — the whole page silently shows arbitrary data.** `skusQuery.data?.[0]`, `warehousesQuery.data?.[0]`, `shipmentsQuery.data?.[0]`. The "Daily COGS/Sales" tab shows one unnamed SKU's COGS; "Landed Cost" shows one unnamed shipment's. No picker, no label, no indication. The comment at lines 7-10 calls these "placeholder selections … just to prove the wiring end-to-end for V1" — and Stream G's "Money was cleaned up and relabeled Cost & Cashflow" pass shipped right past it. A finance page that shows the wrong numbers with total confidence is worse than one that shows none. (The tab is also labeled "Daily COGS/Sales" and has no sales column.)

- **`PurchaseOrdersPage.tsx:202-207` — the user hand-types the payment sequence number.** Defaults to "1", then increments client-side after each success (line 173). The app knows how many payments a PO has; it just asked you anyway, and won't remember across a reload.

- **`ShipmentsPage.tsx:485-486` — "weight share" and "value share", free-text, defaulting to `1.0`.** These drive landed-cost allocation. No label, no unit, no hint whether it's a fraction, a ratio or a percent — and adding three line items gives you three lines each claiming `1.0` of the shipment. The computer knows the quantities and unit prices; it is asking the human to do the allocation math and offering a default that is wrong for every multi-line shipment.

  > **Status: backend now rejects an invalid or non-summing share (fixed 2026-09-20, see BACKLOG.md section I)** — the UI-level confusion (no label, no live sum indicator) is not fixed, only the silent-corruption path underneath it.

- **`PurchaseOrdersPage.tsx:98-103` — "fx rate", free text, defaults to "1".** No indication of which pair, or which direction.

- **`StockPage.tsx:109` — "Sales volatility (last 8 weeks): 0.47".** A bare coefficient with no unit, no band, no "this is high." Nobody acts on this.

- **`StockPage.tsx:280-294` — 26 week-rows, each with a from-scratch recipe.** The product mix is broadly the same week to week; there is no "copy last week," no carry-forward, no bulk apply. Planning two quarters means re-picking the same SKUs and retyping the same units/€1,000 twenty-six times.

- **`CatalogPage.tsx`** — you can add a SKU, a vendor, a warehouse. You can never edit or archive one. First typo is permanent.

### What You'd Cut or Simplify First

**1. Rebuild Home as the one screen that tells you what to do today — and make every number a door.**

Replace `HomePage.tsx`'s four counters with two blocks: *what must be ordered* (the actual at-risk SKUs, named, with days of cover and a link straight into a pre-filled PO) and *what money moves in 14 days* (with a currency symbol and the `≈` caveat Money already has). Then make the risk threshold lead-time-aware — add `leadTimeDays` and `safetyStockDays` to `skus`, and define risk as *days of cover < lead time + safety stock* instead of `dashboards.ts:14-19`'s arbitrary 21. Without this the front door is decorative and the app never earns the first click of the morning. This is the change that converts a database viewer into a tool.

**2. Delete the old `SalesPlanSection` and the orphaned reason-category tax — finish two half-migrations instead of carrying both halves.**

Cut `StockPage.tsx:28-122` entirely; Stream H's weekly planner supersedes it and currently eats its output. Then either surface the change log (a "History" link on every PO and shipment row, reusing the route that already exists at `main.tsx:114`) or stop demanding a reason on every mutation. Right now the app charges for a product it doesn't deliver, seven dropdowns at a time. Picking one direction removes either a lot of friction or a lot of waste — carrying both is the worst option and it's the one shipped.

> **Status: half done 2026-09-20** — the `SalesPlanSection` half of this is fixed. The Change Log reachability half is NOT fixed — remains open, tracked in BACKLOG.md section I.

**3. Collapse the Shipments row into a single "Update shipment" panel, and make the app say names instead of integers.**

One shipment, one editor: current state at the top, *one* reason field shared by whatever you changed, and only the controls the shipment's status actually permits (`CustomsArrivalControl` should not render on a `planned` shipment). Replace every `SKU {li.skuId}` (`ShipmentsPage.tsx:387,480,533`; `PurchaseOrdersPage.tsx:339`; `MoneyPage.tsx:88`; `InventoryLedgerPage.tsx:12`) with the SKU code the catalog query already returns — `TransactionsPage.tsx:13` shows the pattern, it just needs applying everywhere. And swap the free-text currency inputs for a select.

I'd rank these ahead of any remaining backlog item. The engineering underneath is disciplined and the README's build history is genuinely impressive — but it documents eight streams of making the machine correct and zero passes of asking what the machine is *for*. Nobody has sat down at this app at 8am and tried to run a day. The first person who does will get to Home, read four numbers, learn nothing actionable, and open the Google Sheet.

---

## Lens 3: Engineering Rigor (Boris Cherny)

### Type Safety: Real vs. Theater

**Real.** The tRPC↔React boundary is genuine: `client/src/lib/trpc.ts:2-4` types the client off `AppRouter`, and `ShipmentsPage.tsx:6-7`, `StockPage.tsx:7`, `PurchaseOrdersPage.tsx:24` derive row types via `inferRouterOutputs`. `tsc --noEmit` passes clean (verified). The state machines (`shipments.ts:8-14`, `purchaseOrders.ts:6-14`) are keyed `Record<Status, Status[]>` off the schema const, so adding a status is a compile error — that's the compiler doing real work.

**Theater.**

- `server/_core/auth.ts:30-33` — `payload.userId as number`, `payload.role as "editor" | "viewer"`, `payload.tokenVersion as number`. Three unchecked casts on the only thing standing between a request and an `editorProcedure`. `resolveSession` (`loginFlow.ts:49-52`) re-reads role from the DB, so the role cast is currently harmless — but `tokenVersion` is compared (`loginFlow.ts:50`) as the cast value. A JWT whose `tokenVersion` claim is the string `"0"` fails `!==` against numeric `0` and is rejected; a claim of `null` likewise. It happens to fail safe, by accident, not by type. A `z.object({...}).parse(payload)` here is three lines.
- `server/routers.ts:38` — `createSku(input as any)`. I removed the cast and re-ran `tsc`: **it compiles clean without it.** The cast protects nothing and disables the one check that would have caught the schema mismatch described below.

  > **Status: fixed 2026-09-20** — see BACKLOG.md section I.

- `server/_core/trpc.ts:11` — `export type AppRouter = ReturnType<typeof router>`. A second, unrelated `AppRouter` sharing a name with the real one at `routers.ts:239`. It resolves to a bare generic router type. Any file that autocompletes the import from `_core/trpc` silently loses the entire client type surface and still compiles. Dead and a trap.

  > **Status: fixed 2026-09-20** — deleted. See BACKLOG.md section I.

- `server/nightlyExport.ts:51` — `db.select().from(table as any)`, then `rows as Record<string, unknown>[]` at :52.
- `server/changeLog.ts:7-8` — `entityType: string`, despite exactly three call sites passing three literals (`routers.ts:64`, `:158`, `:207`). `listChangeLog("purchase-order", id)` (hyphen) compiles and returns `[]` — a silently empty audit trail instead of an error.
- **The `.mjs` CLI wrappers are outside the type system entirely.** `tsconfig.json` `include` is `["server","client","scripts"]` with no `allowJs`, so the five `scripts/*.mjs` files are never checked. `scripts/run-daily-shopify-pull.mjs:31` does `JSON.parse(await readFile(...))` and hands the result straight to `runDailyShopifyPull(rows, ...)` typed `ShopifyExportRow[]`. `parseShopifyExport` (`shopifyDailyPull.ts:20-32`) then calls `parseInt(row.qty, 10)` with no guard — a malformed file writes `NaN` quantities. The migration path validates rigorously (`migrate-from-sheet.ts:182-183`, strict `INTEGER_PATTERN`/`DECIMAL_PATTERN`, with a comment explicitly about `parseFloat("200000xyz")`); the daily production path does none of it.

### Wrong States Made Representable

**1. A SKU can be created that the database is guaranteed to reject.** `drizzle/schema.ts:35-48` makes `identifierValue` a `STORED` generated column over six nullable identifier columns, `NOT NULL` (confirmed in `drizzle/migrations/0000_overconfident_thing.sql:139-146`). The create API at `routers.ts:37` accepts only `sku`, `name`, and `primaryIdentifierType: z.enum(SKU_IDENTIFIER_TYPES)` — all six types. `CatalogPage.tsx:35-37` renders all six in the dropdown. Selecting `asin`/`ean`/`fnsku`/`ssku` computes `identifierValue = NULL` → MySQL 1048 on every attempt. There is no input for those four fields anywhere. The type that should exist is a discriminated union — `{type:"sku", sku:string} | {type:"asin", asin:string} | ...` — which is exactly what spec.md:41 says the codebase's principle is.

> **Status: fixed 2026-09-20** (via a form field + server-side refine, not the discriminated-union type the reviewer recommends — see BACKLOG.md section I for the tradeoff noted).

**2. Freight/duty allocation shares are unvalidated free text used as multipliers.** `weightShare`/`valueShare` are `varchar(16)` (`schema.ts:168-169`), accepted as bare `z.string()` (`routers.ts:77`), stored unvalidated by `createShipment` (`shipments.ts:31-49`), and consumed at `landedCost.ts:104-105` as `freightCost * parseFloat(line.weightShare)`. Nothing — not zod, not the module, not the DB — enforces that they are numeric, in `[0,1]`, or that a shipment's lines sum to 1. Two lines each at `"1.0"` double-allocates the freight into landed cost. Worse: a non-numeric share yields `NaN` for `landedUnitCost`, and `markShipmentArrived` at `shipments.ts:257` writes `landedUnitCost.toFixed(6)` → the literal string `"NaN"` into `inventory_ledger.unitCost`, permanently poisoning FIFO for that SKU (there is no reversal path anywhere in this codebase). No `Number.isFinite` check on that path.

> **Status: fixed 2026-09-20** — see BACKLOG.md section I.

**3. `getShipmentWithLineItems` returns a well-shaped lie for a missing row.** `shipments.ts:56-58`: `const [shipment] = await db.select()...; return { ...shipment, lineItems }`. Spreading `undefined` is legal — a nonexistent id returns `{ lineItems: [] }`, with no `id`, `status`, or `shipmentRef`. TypeScript types the return as a full `Shipment & {lineItems}`. The client (`ShipmentsPage.tsx:360`) checks `!data`, which is true only for a network failure, not this. Either return `Shipment | null` or throw.

**4. `change_log` rows can be written for records that were not changed.** `updateShipmentPlannedDepartDate` (`shipments.ts:76-91`) reads the shipment with no not-found check, uses `?.` so it doesn't throw, updates zero rows, and then unconditionally writes a `change_log` entry claiming a change. The audit log is the one table in this design that must never lie.

**5. `payments` has no uniqueness on `(poId, sequenceNo)`.** `sequenceNo` is `notNull` (`schema.ts:177`) and semantically identifies the tranche, but `createExpectedPayment` will happily create two "tranche 2" rows on one PO. `listPaymentsForPo` returns both.

**6. Nullable-but-never-null.** `shipments.freightCost/dutyCost/costCurrency` (`schema.ts:150-155`) are nullable for good reason at creation time, but `markShipmentArrived:223-228` must then defensively re-check all three before it can compute a receipt. A `shipment` and a `costed_shipment` are genuinely different states; the schema models them as one row with three optional columns, and every downstream consumer pays for it (`landedCost.ts:69-70` silently coerces both to `"0"`; `landedCost.ts:96` has to null-guard `costCurrency` before comparing).

### Architecture & Module Boundaries

**The FIFO consumption loop is implemented three times, and the copies disagree.**

| | file | handles `adjustment`? | accumulates cost? |
|---|---|---|---|
| `computeFifoCogs` | `landedCost.ts:29-54` | no | yes |
| `getRemainingBatches` | `inventoryLedger.ts:100-124` | **yes** (:116-123) | no |
| inline in `getDailyCogsForRange` | `salesPlan.ts:152-169` | **no** (:142-148 filters to `receipt`/`sale` only) | yes |

All three are the identical `batches.find(b => b.qty > 0 && b.date <= saleDate)` scan. The divergence is a live bug: `getSoh` (`inventoryLedger.ts:43-47`) is a SQL `SUM` over *all* events including adjustments, so the Stock dashboard counts them; `getRemainingBatches` (the Batches drill-down) counts them; `getDailyCogsForRange` **drops them**. A SKU with a negative adjustment will show SOH and batch detail that reconcile, while the Money tab's Daily COGS either under-reports or throws `insufficient stock` on the same ledger. `reconcile-migration.ts:235` writes adjustment events verbatim from the sheet, so the migration will produce exactly this data. No test covers adjustments through `getDailyCogsForRange` (verified — `salesPlan.test.ts` has none). This is precisely the failure mode `docs/spec.md:18` names as the thing this build exists to avoid: *"SOH not reconciling between tabs."*

`computeFifoCogs` is additionally **dead in production** — referenced only by `landedCost.test.ts`. It's the cleanest of the three implementations and nothing calls it.

> **Status: partially fixed 2026-09-20** — `getDailyCogsForRange` now handles adjustment events, matching `getRemainingBatches`'s rule exactly (see BACKLOG.md section I). The three implementations are still three separate functions, not unified into one shared implementation — that consolidation (Cherny's own "fix first" recommendation) remains open, tracked in BACKLOG.md section I. `computeFifoCogs` is still dead code.

**Logic leaks into the router.** `routers.ts:68-71` fetches a PO, maps its line item IDs, and calls a second module function — a two-step business operation living in the adapter. `routers.ts:62, 212, 218, 221, 235` each perform `input.someDate.toISOString().slice(0,10)`, the Date→calendar-day conversion, five times in the adapter layer rather than once at the module boundary.

**Full-table scans in the modules a "performance hardening" stream touched.** `listShipmentsForPo` (`shipments.ts:61-69`) `SELECT *` from all of `shipment_line_items` *and* all of `shipments`, then filters in JS. `listUnpaidPayments` (`payments.ts:135-139`) loads every transaction and every purchase order into memory on each call — and it's on the Transactions page's hot path. Stream D closed the N+1s in `dashboards.ts` and left these.

**`db.ts`'s read functions can't join a transaction.** `createSku`/`createVendor`/`createWarehouse` all take `dbClient: DbClient = db` (`db.ts:5, 22, 32`), but `listSkus`/`listVendors`/`listWarehouses` (`db.ts:11, 28, 38`) don't. `reconcile-migration.ts:78-80` calls all three list functions *inside* `db.transaction`, so those reads go out on a different pooled connection and cannot see the transaction. It works today only because they're seeding maps before any writes.

### Pattern Drift Across the 8 Streams

**"How do we handle a not-found row" — solved four different ways.**

- Explicit check + clear throw: `shipments.ts:112-114`, `:133-135`, `:217-219`, `payments.ts:98-100`, `salesPlan.ts:176-178`
- No check, immediate property access → `TypeError: Cannot read properties of undefined`: `purchaseOrders.ts:60-61`, `:82-83`, `payments.ts:32`, `shipments.ts:163-170`, `:197`, `:271-272`, `landedCost.ts:66-69`
- No check, optional chaining → silently proceeds and writes a false audit row: `shipments.ts:76-91`
- No check, spread of `undefined` → returns a malformed object: `shipments.ts:56-58`

The functions with real checks are the ones the later streams (G, H) rewrote. The rest are V1-era. Two different functions in the *same file* (`shipments.ts`) handle it differently.

**"How do we reuse a domain enum" — four idioms.**

- Import the const from the schema: `routers.ts:10`, `migrate-from-sheet.ts:1` (for `LEDGER_EVENT_TYPES`)
- Hand-copy the literal array: `migrate-from-sheet.ts:206` and `:277` (in the *same file* that imports one from the schema), `ShipmentsPage.tsx:9-12`, `:74`, `PurchaseOrdersPage.tsx:6-9`
- Import `drizzle/schema` directly into the browser bundle: `CatalogPage.tsx:3` (pulls the Drizzle/MySQL schema module into client code for one string array)
- Hand-write a structural type inline: `TransactionsPage.tsx:4` — `counterparty?: string | null` where the schema says `string | null`; optional vs. nullable already drifted

The hand-copied arrays in `migrate-from-sheet.ts:206, 277` are typed `string[]`, which is *why* lines 240 and 314 need `as TransformedPo["initialStatus"]` casts. Using the schema const would have made `includes` a real narrowing guard and removed both casts.

**`VALID_SHIPMENT_TRANSITIONS` exists twice** — `shipments.ts:8-14` (typed against the schema enum) and `ShipmentsPage.tsx:33-38` (`Record<string, string[]>`, with `planned` deliberately removed). The two are already intentionally different, with a 6-line comment explaining why, which means every future status change requires editing two tables that must stay deliberately out of sync.

**"How do we make a write atomic."** `markShipmentArrived` (`shipments.ts:233-262`) and `recordSalesActual` (`salesPlan.ts:43-60`) correctly thread `tx` through `logChange`/`recordLedgerEvent`. `recordShipmentCosts` (`shipments.ts:164-185`) does an `UPDATE` then **two** `logChange` calls with no transaction — a crash between them leaves a shipment with a freight audit entry and no duty one. `markPaymentPaid` (`payments.ts:35-75`) does an `UPDATE` then **three** unguarded `logChange` calls.

### Dead Code & Documentation Drift

- `server/_core/trpc.ts:11` — dead duplicate `AppRouter` (see above). **Fixed 2026-09-20.**
- `server/landedCost.ts:29-54` — `computeFifoCogs`, test-only, superseded by two inline copies.
- `server/cashflow.ts:106` — `export { listUnmatchedTransactions }` re-exports a symbol it imported at :5 and uses nowhere. Every consumer (`dashboards.ts:6`) imports it from `payments` directly. **Fixed 2026-09-20** — removed alongside the currency-normalization fix.
- `server/db.ts:16-20` — `updateSku`, never called from anything, tests included.
- `server/nightlyExport.ts:37-42` — `CORE_TABLES` omits `sales_plan_weekly_inputs` and `sales_plan_weekly_recipe_lines`, both added by Stream H. The "human-readable full snapshot" backup (`spec.md:32`) silently skips the newest tables. A `Record<string, MySqlTable>` built by iterating the schema module would not have drifted.
- `scripts/migrate-from-sheet.ts:47` — comment says "matching runMigration's own `eventType === "receipt"` check"; `runMigration` lives in a different file (`reconcile-migration.ts:44`).
- `reconcile-migration.ts:250-251` — `skuByCode.get(sku)!` / `warehouseByCode.get(warehouseCode)!`. `ReconciliationDeps.getMigratedSoh` is typed `Promise<number | null>` with a 6-line comment (`migrate-from-sheet.ts:96-101`) explaining that `null` means "pair absent, must never be conflated with a real 0." The only production implementation **cannot return null** — it non-null-asserts and would pass `undefined` into `getSoh`. The distinction the type encodes is exercised only by a stub (`migrate-from-sheet.test.ts:74`).
- `routers.ts:207` exposes `payments.history`, but `ChangeLogPage.tsx:3` and the route at `main.tsx:77-78` only accept `"purchase_order" | "shipment"`. Payment history is unreachable.
- `MoneyPage.tsx:88` — `<tr key={row.skuId}>` over `getShipmentLandedUnitCost` output, which `landedCost.test.ts:99-143` explicitly proves can contain two rows with the same `skuId`. React key collision; one row won't render.
- `dashboards.ts:119` — `if (opts?.skuId && opts?.warehouseId)` is a truthiness test on primary keys.

### Test Quality Spot-Check

Assertion quality is **genuinely good** — better than most codebases this age. Concrete evidence:

- `cashflow.test.ts:46-51` — `expect(day20?.actualOutflow).toBe(46500)`, hand-derived from `50000.00 × 0.93`. `:75` asserts `18000` from `20000 × 0.90`. Real arithmetic against real expectations.
- `landedCost.test.ts:141-142` — asserts each of two tranches' landed cost separately with the allocation math spelled out in the comment (`(1000*0.15 + 85)/1000` vs `(500*0.2 + 85)/500`). An implementation that allocated the whole freight to line 1 would fail this.
- `dashboards.test.ts:187-205` — deliberately constructs 30 units sold over 3 days in a 30-day window and asserts `avgDailySales ≈ 1`, not `10`. This is the test that catches the exact bug the denominator comment at `dashboards.ts:21-24` describes. Real regression value.
- `salesPlan.test.ts:144-147` — hand-derives the FIFO split across a batch boundary.
- `shipments.test.ts:440` — "does not write a partial receipt if getShipmentLandedUnitCost throws." Tests the transaction boundary, not just the happy path.

**Weak spots, all in `dashboards.test.ts`:**
- `:64-67` — `expect(summary).toHaveProperty("stockoutRiskSkuCount")` / `("nearTermCashNeeds")`. Pure shape. Passes if both are `NaN`. (Later tests at `:277` and `:79` do assert real values, so the coverage exists — this test just contributes nothing.)
- `:99-106` — titled "adds daily COGS / landed cost **only when scoped**", but asserts only the unscoped case against a database with nothing seeded. `dailyCogs` would be `[]` even if the scoping condition at `dashboards.ts:119` were inverted. The test name claims a guarantee the assertions don't provide.

**The gap that matters** is not weak assertions, it's missing coverage at the seam: nothing anywhere tests `getDailyCogsForRange` against a ledger containing `adjustment` events, which is the divergence described above. `inventoryLedger.test.ts:187-192` tests adjustments thoroughly — for the *other* FIFO implementation.

> **Status: fixed 2026-09-20** — `salesPlan.test.ts` now has 2 tests exercising adjustment events through `getDailyCogsForRange`, both independently arithmetic-verified during a re-review round.

### Schema Assessment

**Normal form** is sound. Ledger-centric, no derived columns except the one generated identifier, no duplicated totals. The design goal at `spec.md:18` is structurally honored at the table level.

**Constraint enforcement is inconsistent in a way that tracks stream boundaries.** Real FKs exist on `inventory_ledger`, `po_line_items`, `shipment_line_items`, `payments`, `transactions` (migration `0000:197-206`), plus the Stream H tables (`0006:26-29`). Missing entirely:

| column | file:line | why it matters |
|---|---|---|
| `purchase_orders.vendorId` | `schema.ts:113` | PO with a nonexistent vendor; `po_line_items.poId` *is* constrained |
| `purchase_orders.createdBy`, `shipments.createdBy` | `:118`, `:156` | `createdBy: 1` is hardcoded in `reconcile-migration.ts:128, 181` and nothing checks user 1 exists |
| `change_log.changedBy` | `:101` | unverifiable audit authorship |
| `sales_plan.skuId/warehouseId` | `:233-234` | `inventory_ledger` has both FKs; its sibling has neither |
| `sales_actuals.skuId/warehouseId` | `:283-284` | same |
| `users.managerId` | `:8` | self-ref, unconstrained |

The `sales_plan` gap is live: `regenerateSalesPlanForWeek` (`salesPlan.ts:231-233`) bulk-inserts plan rows for arbitrary skuIds with no referential check.

**Indexes: exactly one exists.** `sku_warehouse_date_idx` on `inventory_ledger` (migration `0000:207`). `change_log` — an append-only table that only ever grows — has no index on `(entityType, entityId)`, so `listChangeLog` (`changeLog.ts:34-39`) full-scans on every "show history" click. `payments` has none on `(paid, expectedDate)` or `paidDate`, both of which `getCashflowForecast` filters on (`cashflow.ts:62-65`, `:91-94`). `transactions` has none on `matchedPaymentId` or `date`.

**Money/quantity typing is consistently `varchar`, and that consistency is real but wrong.** Every monetary column — `unitPrice`, `freightCost`, `dutyCost`, `expectedAmount`, `paidAmount`, `fxRate`, `baseCurrencyAmount`, `amount`, `unitCost` — is `varchar(16|32)`. Not one `decimal` in the schema. The consequences are concrete: MySQL cannot validate, sum, or compare these; every consumer does `parseFloat` into IEEE-754 (`cashflow.ts:81`, `:83`, `:99`; `landedCost.ts:69-70`, `:103-106`; `payments.ts:33`); and `"NaN"`, `""`, or `"abc"` are all storable. `markPaymentPaid:33` computes `baseCurrencyAmount` as `(parseFloat(a) * parseFloat(r)).toFixed(2)` in float, and `getCashflowForecast` sums those floats. `decimal(18,4)` with Drizzle's string mode is a drop-in that keeps the app-level string representation while giving the DB real validation and `SUM`.

**Date typing is deliberately mixed and half-migrated.** Stream E converted `purchase_orders.plannedReadyDate`, `sales_plan.periodDate`, `sales_actuals.date` to real `date` columns (migrations `0001`, `0002`). But `shipments.plannedDepartDate/actualDepartDate/plannedArrivalDate/actualArrivalDate` and `payments.expectedDate` remain `timestamp` — and `shipments.ts:82-85` openly admits `plannedDepartDate` "is a calendar-day concept even though the column itself is still `timestamp`," then compensates by string-slicing in the audit log. Meanwhile the wire type for *all* of these is `z.date()` (`routers.ts:60, 81, 211, 217`), so genuine calendar days round-trip through a timezone-bearing type and back via `.toISOString().slice(0, 10)`. This works today only because every client call site happens to build UTC midnight via `new Date("YYYY-MM-DD")` (verified across `StockPage.tsx:98, 241, 264-265`, `PurchaseOrdersPage.tsx:130, 232, 411`, `ShipmentsPage.tsx:152, 171, 284, 334`). One `new Date(y, m, d)` anywhere in a negative-UTC-offset browser silently writes the wrong day.

### The Three Things Worth Fixing First

**1. Collapse the three FIFO implementations into one, and make `inventory_ledger` events exhaustive at the type level.** Not because duplication is ugly — because the copies **already disagree**, the disagreement is untested, and it produces the exact class of bug (`docs/spec.md:18`) this platform was built to eliminate. Delete the inline loop in `salesPlan.ts` and the one in `inventoryLedger.ts`; keep one function that takes the full event stream and returns `{ perDayCogs, remainingBatches }`. Make it `switch` on `eventType` with a `never` exhaustiveness check so the next event type added to `LEDGER_EVENT_TYPES` cannot be silently dropped by a filter.

> **Status: the divergence itself is fixed (2026-09-20) — `getDailyCogsForRange` now handles adjustments correctly and identically to `getRemainingBatches`.** The unification into one shared implementation is NOT done — three separate functions still exist, now agreeing on adjustment semantics but still separately maintained. Tracked in BACKLOG.md section I.

**2. One module contract: `(id) → row | throw`, `(input, dbClient) → void`, applied uniformly.** The eight streams produced four different not-found behaviors, three different transaction disciplines, and read functions that can't join a transaction. Fix it as a shape: a single `getOrThrow(table, id, dbClient)` helper; every module function takes `dbClient: DbClient = db` as its last parameter; every function that writes more than one row opens its own transaction or accepts one.

**3. Make money and allocation shares real types, at the schema and at the boundary.** `varchar` money → `decimal(18,4)`; `weightShare`/`valueShare` → validated numerics with a check that a shipment's lines sum to 1; a `Number.isFinite` guard before `shipments.ts:257` writes a computed cost into the ledger.

> **Status: the weightShare/valueShare half is fixed 2026-09-20.** The `varchar` → `decimal` schema migration is NOT done. Tracked in BACKLOG.md section I.

**Two quick ones, both fixed 2026-09-20:** replaced `routers.ts:37-38`'s SKU input with real per-type field support (not the full discriminated union recommended, but the NOT-NULL failure mode is closed); deleted `server/_core/trpc.ts:11`.
