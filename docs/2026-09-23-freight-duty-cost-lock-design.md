# Freight/Duty Cost Lock — Design

## 1. Problem

`recordShipmentCosts` (`server/shipments.ts`) can be called to change a shipment's `freightCost`/`dutyCost` at any time — before arrival, after arrival, doesn't matter. Once a shipment has arrived, `markShipmentArrived` has already written `inventory_ledger` receipts computed from the costs recorded *at that moment*. A later call to `recordShipmentCosts` updates the shipment's own `freightCost`/`dutyCost` fields but does **not** propagate to those already-written ledger rows — the shipment's displayed cost and the landed cost actually baked into the ledger silently diverge, with no error and no warning.

Backlog Stream M (2026-09-21, `docs/2026-09-21-reversal-correction-paths-design.md`) shipped `correctShipmentLandedCost`, a forward-only correction mechanism that fixes this *after the fact* — an operator who notices the divergence can restate costs and have every affected line's ledger receipt corrected, all-or-nothing. But nothing today prevents or detects the divergence occurring in the first place, and nothing directs an operator toward the correction mechanism instead of the plain (ledger-unaware) `recordShipmentCosts` path.

This design closes that gap with an explicit, operator-triggered **cost lock**: once a shipment's costs are confirmed final, the operator locks them. From that point on, every change to that shipment's costs is a formal, audited correction — not a silent divergence risk.

## 2. Scope

In scope: a `lockShipmentCosts` action and a corresponding refusal in `recordShipmentCosts` once locked; making `recordShipmentCosts` ledger-safe for the whole period after arrival (locked or not), closing the actual desync bug regardless of lock state; a minimal UI surface (lock button, locked indicator, disabled cost inputs once locked) on the existing Shipments page.

Out of scope: an `unlockShipmentCosts` path (see §4 — lock is a one-way, append-only-philosophy-aligned commitment, matching this codebase's own established stance rather than adding a new reversible-flag pattern); locking before arrival (see §3 — locking only ever applies to a shipment with an existing ledger receipt); any new cost-component fields beyond the existing `freightCost`/`dutyCost`/`costCurrency` (the schema has no others, and none were requested); a bulk-lock action across multiple shipments at once (real potential future value — e.g. "lock every delivered shipment older than N days" — but a distinct feature with its own UX questions, not needed to close the correctness gap this design targets); any dashboard nudge/reminder surfacing delivered-but-still-unlocked shipments (an unlocked shipment is never unsafe — the ledger stays correct in both states, per §3 — so an operator who never locks a shipment has a process-discipline gap, not a data-integrity one; worth a future backlog note, not part of closing this specific bug).

## 3. Lock timing: only after arrival

A shipment can be locked only when `status === "delivered"` (i.e. only once `markShipmentArrived` has already run and written real `inventory_ledger` receipts). Before arrival, editing costs via `recordShipmentCosts` has no ledger consequence at all — there is nothing to lock against yet, and locking a not-yet-arrived shipment would have no real meaning (arrival's own existing precondition already requires costs to be non-null before it can happen, per `markShipmentArrived`'s current guard).

There is a real window between arrival and lock: after `markShipmentArrived` writes the first receipts, `recordShipmentCosts` remains callable while the shipment is unlocked — this covers the realistic case where a shipment has physically arrived but the final freight/duty invoice from the forwarder is still being finalized over the following days. During this window, quick corrections via the plain `recordShipmentCosts` path stay available without the heavier, more deliberate `correctShipmentLandedCost` form.

**The window does not mean unsafe.** Every `recordShipmentCosts` call made after arrival — locked or not — internally performs the same ledger-correcting work `correctShipmentLandedCost` already does (§5). The only thing lock actually gates is *availability*: whether `recordShipmentCosts` can be called at all. It never gates *safety* — the ledger is never allowed to drift from the shipment's own displayed costs after arrival, in either state.

## 4. Lock is one-way; no unlock

Once locked, a shipment's costs can never again be changed through `recordShipmentCosts` — only through `correctShipmentLandedCost`. There is no `unlockShipmentCosts` function. This mirrors the ledger's own append-only philosophy this whole platform is built around: locking is a deliberate, permanent commitment ("we are done casually editing this; every future change is now a formal, audited correction"), not a reversible flag. Since every path (locked or not, post-arrival) already keeps the ledger safe, there is no unsafe state an unlock would need to escape from — the only thing lock removes is the lighter-weight entry point, and that removal is meant to be permanent.

## 5. Shared correction core: `applyShipmentCostChange`

`correctShipmentLandedCost`'s existing body (update `shipments.freightCost`/`dutyCost`, `logChange` per changed field, recompute `getShipmentLandedUnitCost`, then per line find-and-correct the receipt via `correctLedgerReceipt`, skipping only its own no-op refusal) is extracted into a shared, module-private core:

```ts
async function applyShipmentCostChange(
  tx: DbClient,
  shipmentId: number,
  updates: { freightCost?: string; dutyCost?: string },
  opts: { changedBy: number; reasonCategory: ReasonCategory; reasonNote: string; allowNegativeSoh?: boolean },
): Promise<{ corrections: LedgerCorrectionResult[] }>
```

`correctShipmentLandedCost` becomes a thin wrapper: `applyShipmentCostChange(tx, shipmentId, updates, { ...opts, reasonCategory: "data_correction" })` — its own external signature and behavior are unchanged (still requires at least one of `freightCost`/`dutyCost`, still `reasonNote`-required, still hardcodes `"data_correction"` for both the shipment-level `change_log` entries and — automatically, since `correctLedgerReceipt` already hardcodes this internally regardless of what's passed to it — the ledger-side corrections).

`recordShipmentCosts`'s post-arrival branch (§6) calls the same core, but passes through the *caller's own* `reasonCategory` (a genuine manual category like `"freight_rate_change"`, never `"data_correction"` — enforced by the existing `MANUAL_REASON_CATEGORIES` schema split from the previous stream's final review) for the two shipment-level `change_log` entries. The ledger-side corrections `correctLedgerReceipt` performs are **still always** tagged `"data_correction"` regardless — that function accepts no `reasonCategory` parameter at all, so no new plumbing is needed to keep this invariant: the shipment's own audit trail explains the *business* reason (why the freight rate changed), while the ledger's audit trail explains the *mechanism* (this was a forward-only data correction).

## 6. `recordShipmentCosts`'s new branch

Current signature gains one new optional field: `recordShipmentCosts(id, costs: { freightCost: string; dutyCost: string; costCurrency: string }, opts: { reasonCategory: ReasonCategory; reasonNote?: string; changedBy: number; allowNegativeSoh?: boolean })`. Every existing caller (none of which pass `allowNegativeSoh` today) is unaffected — the field defaults to `undefined`, matching today's behavior exactly for every pre-arrival call.

New behavior, inside the existing transaction:

1. Read the shipment (as today).
2. **If `shipment.status !== "delivered"`**: unchanged — plain update + two `change_log` entries, no ledger involvement, `reasonNote` stays optional. This preserves every existing caller's behavior for the pre-arrival case exactly.
3. **If `shipment.status === "delivered"` and `shipment.costsLockedAt !== null`**: throw `recordShipmentCosts: shipment ${id}'s costs are locked — use correctShipmentLandedCost to make further changes` before writing anything.
4. **If `shipment.status === "delivered"` and `shipment.costsLockedAt === null`** (the window): `reasonNote` becomes required at the value level (`opts.reasonNote?.trim()` — throw a clear error if blank, mirroring `correctShipmentLandedCost`'s own requirement, since this call now performs a real ledger correction under the hood even though its own type signature keeps `reasonNote` optional for the pre-arrival case). Write `costCurrency` to the `shipments` row directly first (unchanged column, no ledger dependency on currency beyond the existing mismatch guard inside `getShipmentLandedUnitCost`, so it is not part of the ledger-correction path) — then call `applyShipmentCostChange(tx, id, { freightCost: costs.freightCost, dutyCost: costs.dutyCost }, { changedBy: opts.changedBy, reasonCategory: opts.reasonCategory, reasonNote: opts.reasonNote!, allowNegativeSoh: opts.allowNegativeSoh })`, which itself writes `freightCost`/`dutyCost` and their `change_log` entries.
5. Re-read and return the updated shipment row in both branches, exactly as today — `applyShipmentCostChange` returns only `{ corrections }`, not the shipment row, so `recordShipmentCosts` performs its own final `SELECT` after calling it, preserving its existing `Promise<Shipment>` return type unchanged for every caller.

`recordShipmentCosts`'s `opts` gains an optional `allowNegativeSoh?: boolean`, threaded through to `applyShipmentCostChange` only in the post-arrival branch — giving the plain "quick fix" path in the arrival-to-lock window access to the same escape hatch `correctShipmentLandedCost`'s UI already has, for the same class of legitimate refusal (Backlog Stream M, §4.1 of that design). This matters more here than it might first appear: this design makes `recordShipmentCosts` trigger a real ledger correction on *every* routine post-arrival cost tweak, not just the rarer, deliberate corrections `correctShipmentLandedCost` alone used to handle — so Stream M's same-day FIFO-unreplayable self-check (closed in that stream, not reopened by this one) is likely to fire somewhat more often in absolute terms simply because this path now runs more often. The check itself does not get any less correct with more calls; threading `allowNegativeSoh` through here is what keeps the escape hatch available at the same frequency the refusal itself now occurs.

**Self-review note on `getShipmentLandedUnitCost` re-validation**: `applyShipmentCostChange` calls this function fresh on every invocation, which re-runs its existing weight/value-share-sum and currency-match validation (`server/landedCost.ts`) against the shipment's current line items — not just the just-changed cost fields. In principle a post-arrival cost edit could now fail for a reason unrelated to the cost change itself, if the underlying line-item data had some pre-existing quality problem. In practice this is not a new risk: `getShipmentLandedUnitCost` already ran once successfully during the shipment's own `markShipmentArrived` call (arrival cannot complete without it succeeding), and no line-item `weightShare`/`valueShare` data changes between then and a later cost edit — so a second call against the same underlying data will succeed again barring an actual data corruption in between, which would be a real, independent bug worth surfacing loudly regardless of this design.

## 7. `lockShipmentCosts`

```ts
export async function lockShipmentCosts(
  id: number,
  opts: { changedBy: number; reasonNote: string },
): Promise<void>
```

Inside one transaction: read the shipment; throw `lockShipmentCosts: no shipment found with id ${id}` if absent; throw `lockShipmentCosts: shipment ${id} has not arrived yet — costs can only be locked after arrival` if `status !== "delivered"`; throw `lockShipmentCosts: shipment ${id}'s costs are already locked` if `costsLockedAt !== null`; throw if `reasonNote` is blank (same value-level check as every other correction entry point in this codebase). Otherwise: `UPDATE shipments SET costsLockedAt = NOW(), costsLockedBy = opts.changedBy`, then one `logChange` (`entityType: "shipment"`, `field: "costsLockedAt"`, `oldValue: null`, `newValue: <the timestamp>`, `reasonCategory: "data_correction"`, `reasonNote: opts.reasonNote`, `changedBy: opts.changedBy`) — locking is itself a correction-adjacent, audited action, not a routine business-status change, so it uses the same hardcoded category every other Stream-M-style action does.

## 8. Schema

`drizzle/schema.ts`'s `shipments` table gains two nullable columns:

```ts
costsLockedAt: timestamp("costsLockedAt"),
costsLockedBy: int("costsLockedBy").references(() => users.id),
```

Naming matches the existing `changedBy`/`createdBy` convention (an int FK to `users.id`, no `Id` suffix) rather than introducing a new naming pattern.

## 9. UI

`client/src/pages/ShipmentsPage.tsx`'s existing shipment-cost-editing UI and the Stream-M-added `CorrectReceiptControl`:

- A new **"Lock costs"** button, visible only when `shipment.status === "delivered"` and `shipment.costsLockedAt === null`, with a required `reasonNote` field (no `reasonCategory` dropdown — matches every other correction-adjacent control). Calls the new `shipments.lockCosts` tRPC procedure.
- When `shipment.costsLockedAt !== null`: the plain freight/duty cost inputs (the ones driving `recordShipmentCosts`) become disabled, with a short inline note ("Costs locked by {name} on {date} — use the correction form below to make changes") pointing at the already-existing `correctShipmentLandedCost` UI from Stream M, which needs no change.
- Before lock (including the pre-arrival case, unchanged): the existing plain cost inputs keep working exactly as today. After arrival specifically, saving now also requires the same `reasonNote` the server enforces (§6) — the existing form gains that field only once `status === "delivered"`, mirroring the conditional-field pattern `CorrectReceiptControl` already established (Stream M) for its own required-`reasonNote`-only, no-`reasonCategory` inputs.
- A small "🔒 Locked" indicator on the shipment row once `costsLockedAt` is set, so the state is visible without opening the correction form.

## 10. Testing

Real-DB tests (this codebase's established convention):

1. `lockShipmentCosts`: happy path (delivered, unlocked → locked, `change_log` entry correct); rejects locking a not-yet-arrived shipment; rejects locking an already-locked shipment; rejects a blank `reasonNote`.
2. `recordShipmentCosts`'s new branches: pre-arrival behavior unchanged (existing tests must pass with zero modification); post-arrival-unlocked call correctly corrects every affected line's ledger receipt (reuse the same assertion shape Stream M's `correctShipmentLandedCost` tests already use — recomputed unit cost, unchanged SOH, `change_log` entries for both the shipment-level fields with the caller's real `reasonCategory` and for the ledger-level correction with `"data_correction"`); post-arrival-unlocked call with a blank `reasonNote` is rejected before any write; post-arrival-locked call is refused with the locked-specific error message and writes nothing.
3. `applyShipmentCostChange`'s shared no-op-skip behavior (already proven once for `correctShipmentLandedCost` in Stream M) needs one new test proving `recordShipmentCosts`'s own call site exercises the identical skip path correctly on a multi-line shipment where one line's cost doesn't move — not a full re-proof of Stream M's own already-covered logic, just confirming the new call site wires it correctly.
4. Regression: every existing `recordShipmentCosts`/`correctShipmentLandedCost` test in `server/shipments.test.ts` must still pass unmodified except where this design explicitly changes behavior (the post-arrival branch).

## Global Constraints

- Locking is only possible once `status === "delivered"` — never before.
- Locking is one-way; no `unlockShipmentCosts` function exists.
- `recordShipmentCosts` is ledger-safe for the entire period after arrival, locked or not — the actual desync bug this design exists to close must not persist in the unlocked "window."
- Once locked, `recordShipmentCosts` always refuses; `correctShipmentLandedCost` is the only path forward.
- The ledger-side correction (`correctLedgerReceipt`, called internally by both `recordShipmentCosts`'s post-arrival branch and `correctShipmentLandedCost`) always hardcodes `reasonCategory: "data_correction"` — this already holds today via `correctLedgerReceipt`'s own existing implementation and needs no new code to preserve.
- The shipment-level `change_log` entries for `freightCost`/`dutyCost` continue to use the caller's own genuine manual `reasonCategory` in `recordShipmentCosts`'s post-arrival branch (not `"data_correction"`) — only `correctShipmentLandedCost` and `lockShipmentCosts` hardcode `"data_correction"` at the shipment-log level too.
- No new `MANUAL_REASON_CATEGORIES`/`REASON_CATEGORIES` changes — this design introduces no new reason category.
