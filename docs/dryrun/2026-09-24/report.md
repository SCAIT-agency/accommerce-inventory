# Real-data dry-run — 2026-09-24

**Verdict: SAFE TO CUT OVER** — 1 item needs your decision (Sheet bugs / conventions); none blocks the platform

Source: live Sheet 1pSVrpDwiN6Ja2RfwVbsxj4H6J3eBRtnLtKNc1TGtoMk → accommerce_dryrun · today = 2026-09-24

## Summary

| Target | Checked | Mismatched | Unclassified |
|---|---:|---:|---:|
| R1 — SOH today per SKU/warehouse (Inventory Ledger — Current On-Hand) | 6 | 0 | 0 |
| R2 — SOH by day (StockModel — Stock) | 606 | 0 | 0 |
| R3 — Daily COGS (Opening Qty/Value, Units Sold, COGS, Unpriced) | 600 | 0 | 0 |
| R4 — Landed cost per shipment line (Landed Cost Summary, net of EUST/VAT) | 24 | 1 | 0 |
| R5 — Payments per PO and per shipment (slots, amounts, paid flags, dates) | 22 | 0 | 0 |
| R6 — Transactions (count, EUR total, transferred matches) | 3 | 0 | 0 |
| R7 — Sales actuals per SKU/warehouse (totals) | 6 | 0 | 0 |
| Q — Rows the migration quarantined or the exporter could not map | 0 | 0 | 0 |
| L — Sheet match hints the migration could not transfer | 0 | 0 | 0 |

Migration: 20 paid payments transferred, 20 transaction links transferred, 0 rows quarantined, 0 links not transferable, 0 export issues.

## Findings by target

### R1 — SOH today per SKU/warehouse (Inventory Ledger — Current On-Hand)

All 6 checks matched.

### R2 — SOH by day (StockModel — Stock)

All 606 checks matched.

### R3 — Daily COGS (Opening Qty/Value, Units Sold, COGS, Unpriced)

All 600 checks matched.

### R4 — Landed cost per shipment line (Landed Cost Summary, net of EUST/VAT)

| Key | Sheet | Platform | Diff | Class | Note |
|---|---:|---:|---:|---|---|
| Mutual-PO2-Delivered / Mixer qty | 3240 | 700 | -2540 | sheet_bug | Landed Cost Summary restates the Straw row's qty (3,240) on the Mixer line; Shipments says 700. Apps Script lookup keyed on Shipment ID only. |

### R5 — Payments per PO and per shipment (slots, amounts, paid flags, dates)

All 22 checks matched.

### R6 — Transactions (count, EUR total, transferred matches)

All 3 checks matched.

### R7 — Sales actuals per SKU/warehouse (totals)

All 6 checks matched.

### Q — Rows the migration quarantined or the exporter could not map

All 0 checks matched.

### L — Sheet match hints the migration could not transfer

All 0 checks matched.

## Quarantines

None.


## Manual links not transferable

None.


## Links transferred with variance

- PO2 Straw #1: planned 569.83, paid 597.23 (4.8%)
- PO1-Wave4-Container1 WAE2026071000047 #3: planned 14867.33, paid 14674.57 (1.3%)
- PO1-Wave4-Container2 #1: planned 11736.97, paid 11737.25 (0.0%) — Sheet slot was unpaid; recorded as paid from the linked transaction
- PO1-Wave4-Container2 #2: planned 15912.19, paid 15719.08 (1.2%) — Sheet slot was unpaid; recorded as paid from the linked transaction

## Conventions applied by the exporter

- PO line unit price = the Sheet's Full Factory Cost/unit (EXW + lab-test/inspection/add-on per unit), the basis of the Sheet's own landed cost.
- Payment slots are re-issued as one running sequence per PO# (a PO spanning several SKU rows keeps every row's payments).
- Shipment-level freight/customs slots become payments owned by the shipment, one running sequence per Shipment ID.
- Rows named <prefix>Container<N>-<SKU> are the lines of one physical container and merge into one pooled shipment (migrate-from-sheet.ts); its freight/duty shares are the Sheet's own per-row split, its payment slots are the rows' slots summed.
- A Sheet transaction link transfers at 1% amount tolerance, or at 5% when the amount differs by FX drift or a partial payment; the platform records the amount actually paid separately from the planned amount.
- A payment the Sheet marks unpaid but links a transaction to is recorded as paid on the transaction's date and amount — the link is the Sheet's own statement that it was paid.
- Sales plan (Plan/day, a weekly plan ÷ 7) is rounded to whole units because sales_plan.plannedQty is an integer.
- Shipment status is derived from dates (arrival → delivered, departure → in_transit, else planned); freight = Actual Delivery + Admin Fees, duty = Actual Duty (non-refundable), both EUR.
- Ledger receipts carry the Sheet's own net landed cost (Landed Cost Summary, minus recoverable EUST/VAT) so the COGS check isolates FIFO logic; the landed-cost formula is checked separately (R4).

## Needs your decision

- [sheet_bug] R4 Mutual-PO2-Delivered / Mixer qty: Sheet 3240 vs platform 700 — Landed Cost Summary restates the Straw row's qty (3,240) on the Mixer line; Shipments says 700. Apps Script lookup keyed on Shipment ID only.
