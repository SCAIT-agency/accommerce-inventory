# Real-data dry-run — 2026-09-24

**Verdict: NOT SAFE TO CUT OVER**

Source: live Sheet 1pSVrpDwiN6Ja2RfwVbsxj4H6J3eBRtnLtKNc1TGtoMk → accommerce_dryrun · today = 2026-09-24

## Summary

| Target | Checked | Mismatched | Unclassified |
|---|---:|---:|---:|
| R1 — SOH today per SKU/warehouse (Inventory Ledger — Current On-Hand) | 6 | 0 | 0 |
| R2 — SOH by day (StockModel — Stock) | 606 | 0 | 0 |
| R3 — Daily COGS (Opening Qty/Value, Units Sold, COGS, Unpriced) | 600 | 334 | 334 |
| R4 — Landed cost per shipment line (Landed Cost Summary, net of EUST/VAT) | 24 | 0 | 0 |
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

| Key | Sheet | Platform | Diff | Class | Note |
|---|---:|---:|---:|---|---|
| Mixer/Mutual 2026-06-16 unpricedQty | 6 | 0 | -6 | unclassified |  |
| Mixer/Mutual 2026-06-16 cogs | 0 | 13.7256 | 13.7256 | unclassified |  |
| Mixer/Mutual 2026-06-17 unpricedQty | 8 | 0 | -8 | unclassified |  |
| Mixer/Mutual 2026-06-17 cogs | 0 | 18.3008 | 18.3008 | unclassified |  |
| Mixer/Mutual 2026-06-18 unpricedQty | 7 | 0 | -7 | unclassified |  |
| Mixer/Mutual 2026-06-18 cogs | 0 | 16.0132 | 16.0132 | unclassified |  |
| Mixer/Mutual 2026-06-19 unpricedQty | 7 | 0 | -7 | unclassified |  |
| Mixer/Mutual 2026-06-19 cogs | 0 | 16.0132 | 16.0132 | unclassified |  |
| Mixer/Mutual 2026-06-20 unpricedQty | 7 | 0 | -7 | unclassified |  |
| Mixer/Mutual 2026-06-20 cogs | 0 | 16.0132 | 16.0132 | unclassified |  |
| Mixer/Mutual 2026-06-21 unpricedQty | 8 | 0 | -8 | unclassified |  |
| Mixer/Mutual 2026-06-21 cogs | 0 | 18.3008 | 18.3008 | unclassified |  |
| Mixer/Mutual 2026-06-22 unpricedQty | 1 | 0 | -1 | unclassified |  |
| Mixer/Mutual 2026-06-22 cogs | 0 | 2.2876 | 2.2876 | unclassified |  |
| Mixer/Mutual 2026-06-25 unpricedQty | 3 | 0 | -3 | unclassified |  |
| Mixer/Mutual 2026-06-25 cogs | 0 | 6.8628 | 6.8628 | unclassified |  |
| Mixer/Mutual 2026-06-26 unpricedQty | 4 | 0 | -4 | unclassified |  |
| Mixer/Mutual 2026-06-26 cogs | 0 | 9.1504 | 9.1504 | unclassified |  |
| Mixer/Mutual 2026-06-27 unpricedQty | 16 | 0 | -16 | unclassified |  |
| Mixer/Mutual 2026-06-27 cogs | 0 | 36.6016 | 36.6016 | unclassified |  |
| Mixer/Mutual 2026-06-28 unpricedQty | 22 | 0 | -22 | unclassified |  |
| Mixer/Mutual 2026-06-28 cogs | 0 | 50.3272 | 50.3272 | unclassified |  |
| Mixer/Mutual 2026-06-29 unpricedQty | 9 | 0 | -9 | unclassified |  |
| Mixer/Mutual 2026-06-29 cogs | 0 | 20.5884 | 20.5884 | unclassified |  |
| Mixer/Mutual 2026-06-30 openingQty | 186 | 88 | -98 | unclassified |  |
| Mixer/Mutual 2026-06-30 unpricedQty | 10 | 0 | -10 | unclassified |  |
| Mixer/Mutual 2026-06-30 openingValue | 425.4900 | 201.3088 | -224.1812 | unclassified |  |
| Mixer/Mutual 2026-06-30 cogs | 0 | 22.8760 | 22.8760 | unclassified |  |
| Mixer/Mutual 2026-07-01 openingQty | 186 | 78 | -108 | unclassified |  |
| Mixer/Mutual 2026-07-01 unpricedQty | 3 | 0 | -3 | unclassified |  |
| Mixer/Mutual 2026-07-01 openingValue | 425.4900 | 178.4328 | -247.0572 | unclassified |  |
| Mixer/Mutual 2026-07-01 cogs | 0 | 6.8628 | 6.8628 | unclassified |  |
| Mixer/Mutual 2026-07-02 openingQty | 186 | 75 | -111 | unclassified |  |
| Mixer/Mutual 2026-07-02 unpricedQty | 1 | 0 | -1 | unclassified |  |
| Mixer/Mutual 2026-07-02 openingValue | 425.4900 | 171.5700 | -253.9200 | unclassified |  |
| Mixer/Mutual 2026-07-02 cogs | 0 | 2.2876 | 2.2876 | unclassified |  |
| Mixer/Mutual 2026-07-03 openingQty | 186 | 74 | -112 | unclassified |  |
| Mixer/Mutual 2026-07-03 unpricedQty | 14 | 0 | -14 | unclassified |  |
| Mixer/Mutual 2026-07-03 openingValue | 425.4900 | 169.2824 | -256.2076 | unclassified |  |
| Mixer/Mutual 2026-07-03 cogs | 0 | 32.0264 | 32.0264 | unclassified |  |
| Mixer/Mutual 2026-07-04 openingQty | 186 | 60 | -126 | unclassified |  |
| Mixer/Mutual 2026-07-04 unpricedQty | 5 | 0 | -5 | unclassified |  |
| Mixer/Mutual 2026-07-04 openingValue | 425.4900 | 137.2560 | -288.2340 | unclassified |  |
| Mixer/Mutual 2026-07-04 cogs | 0 | 11.4380 | 11.4380 | unclassified |  |
| Mixer/Mutual 2026-07-05 openingQty | 186 | 55 | -131 | unclassified |  |
| Mixer/Mutual 2026-07-05 unpricedQty | 11 | 0 | -11 | unclassified |  |
| Mixer/Mutual 2026-07-05 openingValue | 425.4900 | 125.8180 | -299.6720 | unclassified |  |
| Mixer/Mutual 2026-07-05 cogs | 0 | 25.1636 | 25.1636 | unclassified |  |
| Mixer/Mutual 2026-07-06 openingQty | 186 | 44 | -142 | unclassified |  |
| Mixer/Mutual 2026-07-06 unpricedQty | 10 | 0 | -10 | unclassified |  |
| Mixer/Mutual 2026-07-06 openingValue | 425.4900 | 100.6544 | -324.8356 | unclassified |  |
| Mixer/Mutual 2026-07-06 cogs | 0 | 22.8760 | 22.8760 | unclassified |  |
| Mixer/Mutual 2026-07-07 openingQty | 186 | 34 | -152 | unclassified |  |
| Mixer/Mutual 2026-07-07 unpricedQty | 5 | 0 | -5 | unclassified |  |
| Mixer/Mutual 2026-07-07 openingValue | 425.4900 | 77.7784 | -347.7116 | unclassified |  |
| Mixer/Mutual 2026-07-07 cogs | 0 | 11.4380 | 11.4380 | unclassified |  |
| Mixer/Mutual 2026-07-08 openingQty | 186 | 29 | -157 | unclassified |  |
| Mixer/Mutual 2026-07-08 unpricedQty | 10 | 0 | -10 | unclassified |  |
| Mixer/Mutual 2026-07-08 openingValue | 425.4900 | 66.3404 | -359.1496 | unclassified |  |
| Mixer/Mutual 2026-07-08 cogs | 0 | 22.8760 | 22.8760 | unclassified |  |
| Mixer/Mutual 2026-07-09 openingQty | 186 | 19 | -167 | unclassified |  |
| Mixer/Mutual 2026-07-09 unpricedQty | 12 | 0 | -12 | unclassified |  |
| Mixer/Mutual 2026-07-09 openingValue | 425.4900 | 43.4644 | -382.0256 | unclassified |  |
| Mixer/Mutual 2026-07-09 cogs | 0 | 27.4512 | 27.4512 | unclassified |  |
| Mixer/Mutual 2026-07-10 openingQty | 186 | 7 | -179 | unclassified |  |
| Mixer/Mutual 2026-07-10 unpricedQty | 15 | 0 | -15 | unclassified |  |
| Mixer/Mutual 2026-07-10 openingValue | 425.4900 | 16.0132 | -409.4768 | unclassified |  |
| Mixer/Mutual 2026-07-10 cogs | 0 | 21.6810 | 21.6810 | unclassified |  |
| Mixer/Mutual 2026-07-11 openingQty | 186 | 0 | -186 | unclassified |  |
| Mixer/Mutual 2026-07-11 unpricedQty | 13 | 0 | -13 | unclassified |  |
| Mixer/Mutual 2026-07-11 openingValue | 425.4900 | 0 | -425.4900 | unclassified |  |
| Mixer/Mutual 2026-07-11 cogs | 0 | 9.2101 | 9.2101 | unclassified |  |
| Mixer/Mutual 2026-07-12 openingQty | 286 | 79 | -207 | unclassified |  |
| Mixer/Mutual 2026-07-12 unpricedQty | 12 | 0 | -12 | unclassified |  |
| Mixer/Mutual 2026-07-12 openingValue | 496.3400 | 55.9693 | -440.3707 | unclassified |  |
| Mixer/Mutual 2026-07-12 cogs | 0 | 8.5017 | 8.5017 | unclassified |  |
| Mixer/Mutual 2026-07-13 openingQty | 286 | 67 | -219 | unclassified |  |
| Mixer/Mutual 2026-07-13 unpricedQty | 7 | 0 | -7 | unclassified |  |
| Mixer/Mutual 2026-07-13 openingValue | 496.3400 | 47.4676 | -448.8724 | unclassified |  |
| Mixer/Mutual 2026-07-13 cogs | 0 | 4.9593 | 4.9593 | unclassified |  |
| Mixer/Mutual 2026-07-14 openingQty | 286 | 60 | -226 | unclassified |  |
| Mixer/Mutual 2026-07-14 unpricedQty | 11 | 0 | -11 | unclassified |  |
| Mixer/Mutual 2026-07-14 openingValue | 496.3400 | 42.5083 | -453.8317 | unclassified |  |
| Mixer/Mutual 2026-07-14 cogs | 0 | 7.7932 | 7.7932 | unclassified |  |
| Mixer/Mutual 2026-07-15 openingQty | 286 | 49 | -237 | unclassified |  |
| Mixer/Mutual 2026-07-15 unpricedQty | 15 | 0 | -15 | unclassified |  |
| Mixer/Mutual 2026-07-15 openingValue | 496.3400 | 34.7151 | -461.6249 | unclassified |  |
| Mixer/Mutual 2026-07-15 cogs | 0 | 10.6271 | 10.6271 | unclassified |  |
| Mixer/Mutual 2026-07-16 openingQty | 286 | 34 | -252 | unclassified |  |
| Mixer/Mutual 2026-07-16 unpricedQty | 2 | 0 | -2 | unclassified |  |
| Mixer/Mutual 2026-07-16 openingValue | 496.3400 | 24.0880 | -472.2520 | unclassified |  |
| Mixer/Mutual 2026-07-16 cogs | 0 | 1.4169 | 1.4169 | unclassified |  |
| Mixer/Mutual 2026-07-17 openingQty | 286 | 32 | -254 | unclassified |  |
| Mixer/Mutual 2026-07-17 unpricedQty | 8 | 0 | -8 | unclassified |  |
| Mixer/Mutual 2026-07-17 openingValue | 496.3400 | 22.6711 | -473.6689 | unclassified |  |
| Mixer/Mutual 2026-07-17 cogs | 0 | 5.6678 | 5.6678 | unclassified |  |
| Mixer/Mutual 2026-07-18 openingQty | 286 | 24 | -262 | unclassified |  |
| Mixer/Mutual 2026-07-18 unpricedQty | 15 | 0 | -15 | unclassified |  |
| Mixer/Mutual 2026-07-18 openingValue | 496.3400 | 17.0033 | -479.3367 | unclassified |  |
| Mixer/Mutual 2026-07-18 cogs | 0 | 10.6271 | 10.6271 | unclassified |  |
| Mixer/Mutual 2026-07-19 openingQty | 286 | 9 | -277 | unclassified |  |
| Mixer/Mutual 2026-07-19 unpricedQty | 6 | 0 | -6 | unclassified |  |
| Mixer/Mutual 2026-07-19 openingValue | 496.3400 | 6.3762 | -489.9638 | unclassified |  |
| Mixer/Mutual 2026-07-19 cogs | 0 | 4.2508 | 4.2508 | unclassified |  |
| Mixer/Mutual 2026-07-20 openingQty | 586 | 303 | -283 | unclassified |  |
| Mixer/Mutual 2026-07-20 unpricedQty | 11 | 0 | -11 | unclassified |  |
| Mixer/Mutual 2026-07-20 openingValue | 708.8800 | 214.6670 | -494.2130 | unclassified |  |
| Mixer/Mutual 2026-07-20 cogs | 0 | 7.7932 | 7.7932 | unclassified |  |
| Mixer/Mutual 2026-07-21 openingQty | 586 | 292 | -294 | unclassified |  |
| Mixer/Mutual 2026-07-21 unpricedQty | 5 | 0 | -5 | unclassified |  |
| Mixer/Mutual 2026-07-21 openingValue | 708.8800 | 206.8738 | -502.0062 | unclassified |  |
| Mixer/Mutual 2026-07-21 cogs | 0 | 3.5424 | 3.5424 | unclassified |  |
| Mixer/Mutual 2026-07-22 openingQty | 586 | 287 | -299 | unclassified |  |
| Mixer/Mutual 2026-07-22 unpricedQty | 8 | 0 | -8 | unclassified |  |
| Mixer/Mutual 2026-07-22 openingValue | 708.8800 | 203.3315 | -505.5485 | unclassified |  |
| Mixer/Mutual 2026-07-22 cogs | 0 | 5.6678 | 5.6678 | unclassified |  |
| Mixer/Mutual 2026-07-23 openingQty | 586 | 279 | -307 | unclassified |  |
| Mixer/Mutual 2026-07-23 unpricedQty | 9 | 0 | -9 | unclassified |  |
| Mixer/Mutual 2026-07-23 openingValue | 708.8800 | 197.6637 | -511.2163 | unclassified |  |
| Mixer/Mutual 2026-07-23 cogs | 0 | 6.3762 | 6.3762 | unclassified |  |
| Mixer/Mutual 2026-07-24 openingQty | 586 | 270 | -316 | unclassified |  |
| Mixer/Mutual 2026-07-24 unpricedQty | 12 | 0 | -12 | unclassified |  |
| Mixer/Mutual 2026-07-24 openingValue | 708.8800 | 191.2874 | -517.5926 | unclassified |  |
| Mixer/Mutual 2026-07-24 cogs | 0 | 8.5017 | 8.5017 | unclassified |  |
| Mixer/Mutual 2026-07-25 openingQty | 586 | 258 | -328 | unclassified |  |
| Mixer/Mutual 2026-07-25 unpricedQty | 8 | 0 | -8 | unclassified |  |
| Mixer/Mutual 2026-07-25 openingValue | 708.8800 | 182.7858 | -526.0942 | unclassified |  |
| Mixer/Mutual 2026-07-25 cogs | 0 | 5.6678 | 5.6678 | unclassified |  |
| Mixer/Mutual 2026-07-26 openingQty | 586 | 250 | -336 | unclassified |  |
| Mixer/Mutual 2026-07-26 unpricedQty | 17 | 0 | -17 | unclassified |  |
| Mixer/Mutual 2026-07-26 openingValue | 708.8800 | 177.1180 | -531.7620 | unclassified |  |
| Mixer/Mutual 2026-07-26 cogs | 0 | 12.0440 | 12.0440 | unclassified |  |
| Mixer/Mutual 2026-07-27 openingQty | 586 | 233 | -353 | unclassified |  |
| Mixer/Mutual 2026-07-27 unpricedQty | 9 | 0 | -9 | unclassified |  |
| Mixer/Mutual 2026-07-27 openingValue | 708.8800 | 165.0740 | -543.8060 | unclassified |  |
| Mixer/Mutual 2026-07-27 cogs | 0 | 6.3762 | 6.3762 | unclassified |  |
| Mixer/Mutual 2026-07-28 openingQty | 586 | 224 | -362 | unclassified |  |
| Mixer/Mutual 2026-07-28 unpricedQty | 11 | 0 | -11 | unclassified |  |
| Mixer/Mutual 2026-07-28 openingValue | 708.8800 | 158.6977 | -550.1823 | unclassified |  |
| Mixer/Mutual 2026-07-28 cogs | 0 | 7.7932 | 7.7932 | unclassified |  |
| Mixer/Mutual 2026-07-29 openingQty | 586 | 213 | -373 | unclassified |  |
| Mixer/Mutual 2026-07-29 unpricedQty | 13 | 0 | -13 | unclassified |  |
| Mixer/Mutual 2026-07-29 openingValue | 708.8800 | 150.9045 | -557.9755 | unclassified |  |
| Mixer/Mutual 2026-07-29 cogs | 0 | 9.2101 | 9.2101 | unclassified |  |
| Mixer/Mutual 2026-07-30 openingQty | 586 | 200 | -386 | unclassified |  |
| Mixer/Mutual 2026-07-30 unpricedQty | 6 | 0 | -6 | unclassified |  |
| Mixer/Mutual 2026-07-30 openingValue | 708.8800 | 141.6944 | -567.1856 | unclassified |  |
| Mixer/Mutual 2026-07-30 cogs | 0 | 4.2508 | 4.2508 | unclassified |  |
| Mixer/Mutual 2026-07-31 openingQty | 586 | 194 | -392 | unclassified |  |
| Mixer/Mutual 2026-07-31 unpricedQty | 19 | 0 | -19 | unclassified |  |
| Mixer/Mutual 2026-07-31 openingValue | 708.8800 | 137.4436 | -571.4364 | unclassified |  |
| Mixer/Mutual 2026-07-31 cogs | 0 | 13.4610 | 13.4610 | unclassified |  |
| Mixer/Mutual 2026-08-01 openingQty | 586 | 175 | -411 | unclassified |  |
| Mixer/Mutual 2026-08-01 unpricedQty | 2 | 0 | -2 | unclassified |  |
| Mixer/Mutual 2026-08-01 openingValue | 708.8800 | 123.9826 | -584.8974 | unclassified |  |
| Mixer/Mutual 2026-08-01 cogs | 0 | 1.4169 | 1.4169 | unclassified |  |
| Mixer/Mutual 2026-08-02 openingQty | 586 | 173 | -413 | unclassified |  |
| Mixer/Mutual 2026-08-02 unpricedQty | 2 | 0 | -2 | unclassified |  |
| Mixer/Mutual 2026-08-02 openingValue | 708.8800 | 122.5657 | -586.3143 | unclassified |  |
| Mixer/Mutual 2026-08-02 cogs | 0 | 1.4169 | 1.4169 | unclassified |  |
| Mixer/Mutual 2026-08-03 openingQty | 586 | 171 | -415 | unclassified |  |
| Mixer/Mutual 2026-08-03 unpricedQty | 2 | 0 | -2 | unclassified |  |
| Mixer/Mutual 2026-08-03 openingValue | 708.8800 | 121.1487 | -587.7313 | unclassified |  |
| Mixer/Mutual 2026-08-03 cogs | 0 | 1.4169 | 1.4169 | unclassified |  |
| Mixer/Mutual 2026-08-04 openingQty | 586 | 169 | -417 | unclassified |  |
| Mixer/Mutual 2026-08-04 unpricedQty | 1 | 0 | -1 | unclassified |  |
| Mixer/Mutual 2026-08-04 openingValue | 708.8800 | 119.7318 | -589.1482 | unclassified |  |
| Mixer/Mutual 2026-08-04 cogs | 0 | 0.7085 | 0.7085 | unclassified |  |
| Mixer/Mutual 2026-08-05 openingQty | 586 | 168 | -418 | unclassified |  |
| Mixer/Mutual 2026-08-05 openingValue | 708.8800 | 119.0233 | -589.8567 | unclassified |  |
| Mixer/Mutual 2026-08-06 openingQty | 586 | 168 | -418 | unclassified |  |
| Mixer/Mutual 2026-08-06 openingValue | 708.8800 | 119.0233 | -589.8567 | unclassified |  |
| Mixer/Mutual 2026-08-07 openingQty | 586 | 168 | -418 | unclassified |  |
| Mixer/Mutual 2026-08-07 unpricedQty | 2 | 0 | -2 | unclassified |  |
| Mixer/Mutual 2026-08-07 openingValue | 708.8800 | 119.0233 | -589.8567 | unclassified |  |
| Mixer/Mutual 2026-08-07 cogs | 0 | 1.4169 | 1.4169 | unclassified |  |
| Mixer/Mutual 2026-08-08 openingQty | 586 | 166 | -420 | unclassified |  |
| Mixer/Mutual 2026-08-08 unpricedQty | 18 | 0 | -18 | unclassified |  |
| Mixer/Mutual 2026-08-08 openingValue | 708.8800 | 117.6064 | -591.2736 | unclassified |  |
| Mixer/Mutual 2026-08-08 cogs | 0 | 12.7525 | 12.7525 | unclassified |  |
| Mixer/Mutual 2026-08-09 openingQty | 1286 | 848 | -438 | unclassified |  |
| Mixer/Mutual 2026-08-09 unpricedQty | 18 | 0 | -18 | unclassified |  |
| Mixer/Mutual 2026-08-09 openingValue | 1672.0800 | 1068.0539 | -604.0261 | unclassified |  |
| Mixer/Mutual 2026-08-09 cogs | 0 | 12.7525 | 12.7525 | unclassified |  |
| Mixer/Mutual 2026-08-10 openingQty | 1286 | 830 | -456 | unclassified |  |
| Mixer/Mutual 2026-08-10 unpricedQty | 14 | 0 | -14 | unclassified |  |
| Mixer/Mutual 2026-08-10 openingValue | 1672.0800 | 1055.3014 | -616.7786 | unclassified |  |
| Mixer/Mutual 2026-08-10 cogs | 0 | 9.9186 | 9.9186 | unclassified |  |
| Mixer/Mutual 2026-08-11 openingQty | 1286 | 816 | -470 | unclassified |  |
| Mixer/Mutual 2026-08-11 unpricedQty | 8 | 0 | -8 | unclassified |  |
| Mixer/Mutual 2026-08-11 openingValue | 1672.0800 | 1045.3828 | -626.6972 | unclassified |  |
| Mixer/Mutual 2026-08-11 cogs | 0 | 5.6678 | 5.6678 | unclassified |  |
| Mixer/Mutual 2026-08-12 openingQty | 1286 | 808 | -478 | unclassified |  |
| Mixer/Mutual 2026-08-12 unpricedQty | 15 | 0 | -15 | unclassified |  |
| Mixer/Mutual 2026-08-12 openingValue | 1672.0800 | 1039.7150 | -632.3650 | unclassified |  |
| Mixer/Mutual 2026-08-12 cogs | 0 | 10.6271 | 10.6271 | unclassified |  |
| Mixer/Mutual 2026-08-13 openingQty | 1286 | 793 | -493 | unclassified |  |
| Mixer/Mutual 2026-08-13 unpricedQty | 10 | 0 | -10 | unclassified |  |
| Mixer/Mutual 2026-08-13 openingValue | 1672.0800 | 1029.0879 | -642.9921 | unclassified |  |
| Mixer/Mutual 2026-08-13 cogs | 0 | 7.0847 | 7.0847 | unclassified |  |
| Mixer/Mutual 2026-08-14 openingQty | 1286 | 783 | -503 | unclassified |  |
| Mixer/Mutual 2026-08-14 unpricedQty | 3 | 0 | -3 | unclassified |  |
| Mixer/Mutual 2026-08-14 openingValue | 1672.0800 | 1022.0032 | -650.0768 | unclassified |  |
| Mixer/Mutual 2026-08-14 cogs | 0 | 2.1254 | 2.1254 | unclassified |  |
| Mixer/Mutual 2026-08-15 openingQty | 1286 | 780 | -506 | unclassified |  |
| Mixer/Mutual 2026-08-15 unpricedQty | 10 | 0 | -10 | unclassified |  |
| Mixer/Mutual 2026-08-15 openingValue | 1672.0800 | 1019.8778 | -652.2022 | unclassified |  |
| Mixer/Mutual 2026-08-15 cogs | 0 | 7.0847 | 7.0847 | unclassified |  |
| Mixer/Mutual 2026-08-16 openingQty | 1286 | 770 | -516 | unclassified |  |
| Mixer/Mutual 2026-08-16 unpricedQty | 14 | 0 | -14 | unclassified |  |
| Mixer/Mutual 2026-08-16 openingValue | 1672.0800 | 1012.7930 | -659.2870 | unclassified |  |
| Mixer/Mutual 2026-08-16 cogs | 0 | 9.9186 | 9.9186 | unclassified |  |
| Mixer/Mutual 2026-08-17 openingQty | 1286 | 756 | -530 | unclassified |  |
| Mixer/Mutual 2026-08-17 unpricedQty | 13 | 0 | -13 | unclassified |  |
| Mixer/Mutual 2026-08-17 openingValue | 1672.0800 | 1002.8744 | -669.2056 | unclassified |  |
| Mixer/Mutual 2026-08-17 cogs | 0 | 9.2101 | 9.2101 | unclassified |  |
| Mixer/Mutual 2026-08-18 openingQty | 1286 | 743 | -543 | unclassified |  |
| Mixer/Mutual 2026-08-18 unpricedQty | 8 | 0 | -8 | unclassified |  |
| Mixer/Mutual 2026-08-18 openingValue | 1672.0800 | 993.6643 | -678.4157 | unclassified |  |
| Mixer/Mutual 2026-08-18 cogs | 0 | 5.6678 | 5.6678 | unclassified |  |
| Mixer/Mutual 2026-08-19 openingQty | 1286 | 735 | -551 | unclassified |  |
| Mixer/Mutual 2026-08-19 unpricedQty | 4 | 0 | -4 | unclassified |  |
| Mixer/Mutual 2026-08-19 openingValue | 1672.0800 | 987.9965 | -684.0835 | unclassified |  |
| Mixer/Mutual 2026-08-19 cogs | 0 | 2.8339 | 2.8339 | unclassified |  |
| Mixer/Mutual 2026-08-20 openingQty | 1286 | 731 | -555 | unclassified |  |
| Mixer/Mutual 2026-08-20 unpricedQty | 17 | 0 | -17 | unclassified |  |
| Mixer/Mutual 2026-08-20 openingValue | 1672.0800 | 985.1626 | -686.9174 | unclassified |  |
| Mixer/Mutual 2026-08-20 cogs | 0 | 12.0440 | 12.0440 | unclassified |  |
| Mixer/Mutual 2026-08-21 openingQty | 1286 | 714 | -572 | unclassified |  |
| Mixer/Mutual 2026-08-21 unpricedQty | 6 | 0 | -6 | unclassified |  |
| Mixer/Mutual 2026-08-21 openingValue | 1672.0800 | 973.1186 | -698.9614 | unclassified |  |
| Mixer/Mutual 2026-08-21 cogs | 0 | 4.2508 | 4.2508 | unclassified |  |
| Mixer/Mutual 2026-08-22 openingQty | 1286 | 708 | -578 | unclassified |  |
| Mixer/Mutual 2026-08-22 unpricedQty | 5 | 0 | -5 | unclassified |  |
| Mixer/Mutual 2026-08-22 openingValue | 1672.0800 | 968.8678 | -703.2122 | unclassified |  |
| Mixer/Mutual 2026-08-22 cogs | 0 | 3.5424 | 3.5424 | unclassified |  |
| Mixer/Mutual 2026-08-23 openingQty | 1286 | 703 | -583 | unclassified |  |
| Mixer/Mutual 2026-08-23 unpricedQty | 6 | 0 | -6 | unclassified |  |
| Mixer/Mutual 2026-08-23 openingValue | 1672.0800 | 965.3254 | -706.7546 | unclassified |  |
| Mixer/Mutual 2026-08-23 cogs | 0 | 6.2534 | 6.2534 | unclassified |  |
| Mixer/Mutual 2026-08-24 openingQty | 1286 | 697 | -589 | unclassified |  |
| Mixer/Mutual 2026-08-24 unpricedQty | 11 | 0 | -11 | unclassified |  |
| Mixer/Mutual 2026-08-24 openingValue | 1672.0800 | 959.0720 | -713.0080 | unclassified |  |
| Mixer/Mutual 2026-08-24 cogs | 9.1500 | 20.6400 | 11.4900 | unclassified |  |
| Mixer/Mutual 2026-08-25 openingQty | 1282 | 682 | -600 | unclassified |  |
| Mixer/Mutual 2026-08-25 openingValue | 1662.9300 | 938.4320 | -724.4980 | unclassified |  |
| Mixer/Mutual 2026-08-25 cogs | 27.4500 | 16.5120 | -10.9380 | unclassified |  |
| Mixer/Mutual 2026-08-26 openingQty | 1270 | 670 | -600 | unclassified |  |
| Mixer/Mutual 2026-08-26 openingValue | 1635.4800 | 921.9200 | -713.5600 | unclassified |  |
| Mixer/Mutual 2026-08-26 cogs | 38.8900 | 23.3920 | -15.4980 | unclassified |  |
| Mixer/Mutual 2026-08-27 openingQty | 1253 | 653 | -600 | unclassified |  |
| Mixer/Mutual 2026-08-27 openingValue | 1596.5900 | 898.5280 | -698.0620 | unclassified |  |
| Mixer/Mutual 2026-08-27 cogs | 18.3000 | 11.0080 | -7.2920 | unclassified |  |
| Mixer/Mutual 2026-08-28 openingQty | 1245 | 645 | -600 | unclassified |  |
| Mixer/Mutual 2026-08-28 openingValue | 1578.2900 | 887.5200 | -690.7700 | unclassified |  |
| Mixer/Mutual 2026-08-28 cogs | 29.7400 | 17.8880 | -11.8520 | unclassified |  |
| Mixer/Mutual 2026-08-29 openingQty | 1232 | 632 | -600 | unclassified |  |
| Mixer/Mutual 2026-08-29 openingValue | 1548.5500 | 869.6320 | -678.9180 | unclassified |  |
| Mixer/Mutual 2026-08-29 cogs | 20.5900 | 12.3840 | -8.2060 | unclassified |  |
| Mixer/Mutual 2026-08-30 openingQty | 1223 | 623 | -600 | unclassified |  |
| Mixer/Mutual 2026-08-30 openingValue | 1527.9600 | 857.2480 | -670.7120 | unclassified |  |
| Mixer/Mutual 2026-08-30 cogs | 29.7400 | 17.8880 | -11.8520 | unclassified |  |
| Mixer/Mutual 2026-08-31 openingQty | 1210 | 610 | -600 | unclassified |  |
| Mixer/Mutual 2026-08-31 openingValue | 1498.2200 | 839.3600 | -658.8600 | unclassified |  |
| Mixer/Mutual 2026-08-31 cogs | 22.8800 | 13.7600 | -9.1200 | unclassified |  |
| Mixer/Mutual 2026-09-01 openingQty | 1200 | 600 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-01 openingValue | 1475.3500 | 825.6000 | -649.7500 | unclassified |  |
| Mixer/Mutual 2026-09-01 cogs | 4.5800 | 2.7520 | -1.8280 | unclassified |  |
| Mixer/Mutual 2026-09-02 openingQty | 1198 | 598 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-02 openingValue | 1470.7700 | 822.8480 | -647.9220 | unclassified |  |
| Mixer/Mutual 2026-09-02 cogs | 20.5900 | 12.3840 | -8.2060 | unclassified |  |
| Mixer/Mutual 2026-09-03 openingQty | 1189 | 589 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-03 openingValue | 1450.1900 | 810.4640 | -639.7260 | unclassified |  |
| Mixer/Mutual 2026-09-03 cogs | 13.7300 | 8.2560 | -5.4740 | unclassified |  |
| Mixer/Mutual 2026-09-04 openingQty | 1183 | 583 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-04 openingValue | 1436.4600 | 802.2080 | -634.2520 | unclassified |  |
| Mixer/Mutual 2026-09-04 cogs | 32.0300 | 19.2640 | -12.7660 | unclassified |  |
| Mixer/Mutual 2026-09-05 openingQty | 1169 | 569 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-05 openingValue | 1404.4300 | 782.9440 | -621.4860 | unclassified |  |
| Mixer/Mutual 2026-09-05 cogs | 32.0300 | 19.2640 | -12.7660 | unclassified |  |
| Mixer/Mutual 2026-09-06 openingQty | 1155 | 555 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-06 openingValue | 1372.4100 | 763.6800 | -608.7300 | unclassified |  |
| Mixer/Mutual 2026-09-06 cogs | 38.8900 | 23.3920 | -15.4980 | unclassified |  |
| Mixer/Mutual 2026-09-07 openingQty | 1138 | 538 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-07 openingValue | 1333.5200 | 740.2880 | -593.2320 | unclassified |  |
| Mixer/Mutual 2026-09-07 cogs | 22.8800 | 13.7600 | -9.1200 | unclassified |  |
| Mixer/Mutual 2026-09-08 openingQty | 1128 | 528 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-08 openingValue | 1310.6400 | 726.5280 | -584.1120 | unclassified |  |
| Mixer/Mutual 2026-09-08 cogs | 20.5900 | 12.3840 | -8.2060 | unclassified |  |
| Mixer/Mutual 2026-09-09 openingQty | 1119 | 519 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-09 openingValue | 1290.0500 | 714.1440 | -575.9060 | unclassified |  |
| Mixer/Mutual 2026-09-09 cogs | 11.4400 | 6.8800 | -4.5600 | unclassified |  |
| Mixer/Mutual 2026-09-10 openingQty | 1114 | 514 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-10 openingValue | 1278.6200 | 707.2640 | -571.3560 | unclassified |  |
| Mixer/Mutual 2026-09-10 cogs | 18.3000 | 11.0080 | -7.2920 | unclassified |  |
| Mixer/Mutual 2026-09-11 openingQty | 1106 | 506 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-11 openingValue | 1260.3100 | 696.2560 | -564.0540 | unclassified |  |
| Mixer/Mutual 2026-09-11 cogs | 15.1400 | 11.0080 | -4.1320 | unclassified |  |
| Mixer/Mutual 2026-09-12 openingQty | 1098 | 498 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-12 openingValue | 1245.1700 | 685.2480 | -559.9220 | unclassified |  |
| Mixer/Mutual 2026-09-12 cogs | 3.5400 | 6.8800 | 3.3400 | unclassified |  |
| Mixer/Mutual 2026-09-13 openingQty | 1093 | 493 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-13 openingValue | 1241.6300 | 678.3680 | -563.2620 | unclassified |  |
| Mixer/Mutual 2026-09-13 cogs | 4.9600 | 9.6320 | 4.6720 | unclassified |  |
| Mixer/Mutual 2026-09-14 openingQty | 1086 | 486 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-14 openingValue | 1236.6700 | 668.7360 | -567.9340 | unclassified |  |
| Mixer/Mutual 2026-09-14 cogs | 6.3800 | 12.3840 | 6.0040 | unclassified |  |
| Mixer/Mutual 2026-09-15 openingQty | 1077 | 477 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-15 openingValue | 1230.2900 | 656.3520 | -573.9380 | unclassified |  |
| Mixer/Mutual 2026-09-15 cogs | 4.2500 | 8.2560 | 4.0060 | unclassified |  |
| Mixer/Mutual 2026-09-16 openingQty | 1071 | 471 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-16 openingValue | 1226.0400 | 648.0960 | -577.9440 | unclassified |  |
| Mixer/Mutual 2026-09-16 cogs | 7.7900 | 15.1360 | 7.3460 | unclassified |  |
| Mixer/Mutual 2026-09-17 openingQty | 1060 | 460 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-17 openingValue | 1218.2500 | 632.9600 | -585.2900 | unclassified |  |
| Mixer/Mutual 2026-09-17 cogs | 6.3800 | 12.3840 | 6.0040 | unclassified |  |
| Mixer/Mutual 2026-09-18 openingQty | 1051 | 451 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-18 openingValue | 1211.8700 | 620.5760 | -591.2940 | unclassified |  |
| Mixer/Mutual 2026-09-18 cogs | 2.1300 | 4.1280 | 1.9980 | unclassified |  |
| Mixer/Mutual 2026-09-19 openingQty | 1048 | 448 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-19 openingValue | 1209.7500 | 616.4480 | -593.3020 | unclassified |  |
| Mixer/Mutual 2026-09-19 cogs | 4.9600 | 9.6320 | 4.6720 | unclassified |  |
| Mixer/Mutual 2026-09-20 openingQty | 1041 | 441 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-20 openingValue | 1204.7900 | 606.8160 | -597.9740 | unclassified |  |
| Mixer/Mutual 2026-09-20 cogs | 7.0800 | 13.7600 | 6.6800 | unclassified |  |
| Mixer/Mutual 2026-09-21 openingQty | 1031 | 431 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-21 openingValue | 1197.7000 | 593.0560 | -604.6440 | unclassified |  |
| Mixer/Mutual 2026-09-21 cogs | 6.3800 | 12.3840 | 6.0040 | unclassified |  |
| Mixer/Mutual 2026-09-22 openingQty | 1022 | 422 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-22 openingValue | 1191.3300 | 580.6720 | -610.6580 | unclassified |  |
| Mixer/Mutual 2026-09-22 cogs | 6.3800 | 12.3840 | 6.0040 | unclassified |  |
| Mixer/Mutual 2026-09-23 openingQty | 1013 | 413 | -600 | unclassified |  |
| Mixer/Mutual 2026-09-23 openingValue | 1184.9500 | 568.2880 | -616.6620 | unclassified |  |
| Mixer/Mutual 2026-09-23 cogs | 7.0800 | 13.7600 | 6.6800 | unclassified |  |

### R4 — Landed cost per shipment line (Landed Cost Summary, net of EUST/VAT)

All 24 checks matched.

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

Nothing pending.

