import { useState } from "react";
import { Link } from "react-router-dom";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "../lib/trpc";
import { skuLabel, formatMoney } from "../lib/labels";
import { MANUAL_REASON_CATEGORIES } from "../../../shared/constants";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type ShipmentListItem = RouterOutputs["shipments"]["list"][number];

type ReasonCategory = (typeof MANUAL_REASON_CATEGORIES)[number];

const SHIPMENT_STATUS_BADGE_CLASS: Record<string, string> = {
  delivered: "badge badge-ok",
  customs: "badge badge-warning",
};
const DEFAULT_STATUS_BADGE_CLASS = "badge badge-neutral";

const CUSTOMS_STATUS_BADGE_CLASS: Record<string, string> = {
  held: "badge badge-warning",
  cleared: "badge badge-ok",
};

// "planned" has no entry here on purpose: the only forward transition out of
// "planned" is marking a shipment departed, which must go through
// markShipmentDeparted (records the actual depart date and enforces the
// planned-depart-date precondition) — updateShipmentStatus now rejects
// "departed" outright, so no button here may call it. PlannedDepartureControl
// below is what actually drives that transition.
const VALID_SHIPMENT_TRANSITIONS: Record<string, string[]> = {
  departed: ["in_transit"],
  in_transit: ["customs"],
  customs: ["delivered"],
  delivered: [],
};

interface StatusTransitionFormState {
  reasonCategory: ReasonCategory;
  reasonNote: string;
}

function defaultStatusTransitionForm(): StatusTransitionFormState {
  return { reasonCategory: "logistics_delay", reasonNote: "" };
}

interface CostsFormState {
  freightCost: string;
  adminFeesCost: string;
  dutyCost: string;
  eustAmount: string;
  vatAmount: string;
  costCurrency: string;
  reasonCategory: ReasonCategory;
  reasonNote: string;
}

function defaultCostsForm(shipment: ShipmentListItem): CostsFormState {
  return {
    freightCost: shipment.freightCost ?? "",
    adminFeesCost: shipment.adminFeesCost ?? "",
    dutyCost: shipment.dutyCost ?? "",
    eustAmount: shipment.eustAmount ?? "",
    vatAmount: shipment.vatAmount ?? "",
    costCurrency: shipment.costCurrency ?? "USD",
    reasonCategory: "freight_rate_change",
    reasonNote: "",
  };
}

interface CustomsArrivalFormState {
  customsStatus: string;
  actualArrivalDate: string;
  reasonCategory: ReasonCategory;
  reasonNote: string;
}

const CUSTOMS_STATUSES = ["not_declared", "declared", "held", "cleared"] as const;

function defaultCustomsArrivalForm(shipment: ShipmentListItem): CustomsArrivalFormState {
  return {
    customsStatus: shipment.customsStatus,
    actualArrivalDate: shipment.actualArrivalDate ? new Date(shipment.actualArrivalDate).toISOString().slice(0, 10) : "",
    reasonCategory: "customs_hold",
    reasonNote: "",
  };
}

interface DepartDateCorrectionFormState {
  newDate: string;
  reasonCategory: ReasonCategory;
  reasonNote: string;
}

function defaultDepartDateCorrectionForm(): DepartDateCorrectionFormState {
  return { newDate: new Date().toISOString().slice(0, 10), reasonCategory: "logistics_delay", reasonNote: "" };
}

interface ReceiptCorrectionFormState {
  lineItemId: string;
  newQty: string;
  freightCost: string;
  adminFeesCost: string;
  dutyCost: string;
  eustAmount: string;
  vatAmount: string;
  reasonNote: string;
}

function defaultReceiptCorrectionForm(shipment: ShipmentListItem): ReceiptCorrectionFormState {
  return {
    lineItemId: "",
    newQty: "",
    freightCost: shipment.freightCost ?? "",
    adminFeesCost: shipment.adminFeesCost ?? "",
    dutyCost: shipment.dutyCost ?? "",
    eustAmount: shipment.eustAmount ?? "",
    vatAmount: shipment.vatAmount ?? "",
    reasonNote: "",
  };
}

interface PlannedDepartureFormState {
  plannedDepartDate: string;
  actualDepartDate: string;
  reasonCategory: ReasonCategory;
  reasonNote: string;
}

function defaultPlannedDepartureForm(shipment: ShipmentListItem): PlannedDepartureFormState {
  return {
    plannedDepartDate: shipment.plannedDepartDate ? new Date(shipment.plannedDepartDate).toISOString().slice(0, 10) : "",
    actualDepartDate: new Date().toISOString().slice(0, 10),
    reasonCategory: "logistics_delay",
    reasonNote: "",
  };
}

// Only relevant while a shipment is still "planned" — updateShipmentStatus
// rejects a direct transition to "departed" precisely so this is the only
// path a shipment can take out of "planned". markShipmentDeparted itself
// enforces that plannedDepartDate must already be set, which is why "Mark
// departed" only appears once shipment.plannedDepartDate is non-null.
function PlannedDepartureControl({ shipment, onUpdated }: { shipment: ShipmentListItem; onUpdated: () => void }) {
  const updatePlannedDepartDate = trpc.shipments.updatePlannedDepartDate.useMutation({ onSuccess: onUpdated });
  const markDeparted = trpc.shipments.markDeparted.useMutation({ onSuccess: onUpdated });
  const [form, setForm] = useState<PlannedDepartureFormState>(() => defaultPlannedDepartureForm(shipment));
  const noteRequired = form.reasonCategory === "other";
  const canSavePlanned = !noteRequired || form.reasonNote.trim().length > 0;

  if (shipment.status !== "planned") return null;

  return (
    <div>
      <div>Planned depart: {shipment.plannedDepartDate ? new Date(shipment.plannedDepartDate).toISOString().slice(0, 10) : "not set"}</div>
      <input
        type="date"
        value={form.plannedDepartDate}
        onChange={(e) => setForm((prev) => ({ ...prev, plannedDepartDate: e.target.value }))}
      />
      <select
        value={form.reasonCategory}
        onChange={(e) => setForm((prev) => ({ ...prev, reasonCategory: e.target.value as ReasonCategory }))}
      >
        {MANUAL_REASON_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      {noteRequired && (
        <input
          type="text"
          placeholder="required note"
          value={form.reasonNote}
          onChange={(e) => setForm((prev) => ({ ...prev, reasonNote: e.target.value }))}
        />
      )}
      <button
        disabled={!canSavePlanned || !form.plannedDepartDate || updatePlannedDepartDate.isPending}
        onClick={() =>
          updatePlannedDepartDate.mutate({
            id: shipment.id,
            newDate: new Date(form.plannedDepartDate),
            reasonCategory: form.reasonCategory,
            reasonNote: noteRequired ? form.reasonNote : undefined,
          })
        }
      >
        Save planned depart date
      </button>
      {updatePlannedDepartDate.error && <div>Failed to save: {updatePlannedDepartDate.error.message}</div>}

      {shipment.plannedDepartDate && (
        <div style={{ marginTop: "4px" }}>
          <input
            type="date"
            value={form.actualDepartDate}
            onChange={(e) => setForm((prev) => ({ ...prev, actualDepartDate: e.target.value }))}
          />
          <button
            disabled={markDeparted.isPending}
            onClick={() => markDeparted.mutate({ id: shipment.id, actualDate: new Date(form.actualDepartDate) })}
          >
            Mark departed
          </button>
          {markDeparted.error && <div>Failed to mark departed: {markDeparted.error.message}</div>}
        </div>
      )}
    </div>
  );
}

function StatusTransitionControl({ shipment, onUpdated }: { shipment: ShipmentListItem; onUpdated: () => void }) {
  const updateStatus = trpc.shipments.updateStatus.useMutation({ onSuccess: onUpdated });
  const [form, setForm] = useState<StatusTransitionFormState>(() => defaultStatusTransitionForm());
  // "delivered" always has a dedicated control (CustomsArrivalControl's
  // "Save arrival date" button) -- offering it here too would render a
  // working-looking option that updateShipmentStatus (server/shipments.ts)
  // unconditionally rejects. ("departed" needs no such filter: it isn't a key
  // in VALID_SHIPMENT_TRANSITIONS at all, so it never appears here in the
  // first place — see the comment on that constant above.)
  const nextStatuses = (VALID_SHIPMENT_TRANSITIONS[shipment.status] ?? []).filter(
    (s) => s !== "delivered",
  );
  const noteRequired = form.reasonCategory === "other";
  const canSave = !noteRequired || form.reasonNote.trim().length > 0;

  if (nextStatuses.length === 0) return null;

  return (
    <div>
      <select
        value={form.reasonCategory}
        onChange={(e) => setForm((prev) => ({ ...prev, reasonCategory: e.target.value as ReasonCategory }))}
      >
        {MANUAL_REASON_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      {noteRequired && (
        <input
          type="text"
          placeholder="required note"
          value={form.reasonNote}
          onChange={(e) => setForm((prev) => ({ ...prev, reasonNote: e.target.value }))}
        />
      )}
      {nextStatuses.map((next) => (
        <button
          key={next}
          disabled={!canSave || updateStatus.isPending}
          onClick={() =>
            updateStatus.mutate({
              id: shipment.id,
              newStatus: next as ShipmentListItem["status"],
              reasonCategory: form.reasonCategory,
              reasonNote: noteRequired ? form.reasonNote : undefined,
            })
          }
        >
          Mark {next}
        </button>
      ))}
      {updateStatus.error && <div>Failed to update status: {updateStatus.error.message}</div>}
    </div>
  );
}

function CustomsArrivalControl({ shipment, onUpdated }: { shipment: ShipmentListItem; onUpdated: () => void }) {
  const setCustomsStatus = trpc.shipments.setCustomsStatus.useMutation({ onSuccess: onUpdated });
  const markArrived = trpc.shipments.markArrived.useMutation({ onSuccess: onUpdated });
  const [form, setForm] = useState<CustomsArrivalFormState>(() => defaultCustomsArrivalForm(shipment));
  const noteRequired = form.reasonCategory === "other";
  const canSave = !noteRequired || form.reasonNote.trim().length > 0;
  const costsRecorded = shipment.freightCost != null && shipment.dutyCost != null && shipment.costCurrency != null;

  return (
    <div>
      <div>
        Customs: <span className={CUSTOMS_STATUS_BADGE_CLASS[shipment.customsStatus] ?? DEFAULT_STATUS_BADGE_CLASS}>{shipment.customsStatus}</span>
        {" "}· Arrived: {shipment.actualArrivalDate ? new Date(shipment.actualArrivalDate).toISOString().slice(0, 10) : "—"}
      </div>
      <select
        value={form.customsStatus}
        onChange={(e) => setForm((prev) => ({ ...prev, customsStatus: e.target.value }))}
      >
        {CUSTOMS_STATUSES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <input
        type="date"
        value={form.actualArrivalDate}
        onChange={(e) => setForm((prev) => ({ ...prev, actualArrivalDate: e.target.value }))}
      />
      <select
        value={form.reasonCategory}
        onChange={(e) => setForm((prev) => ({ ...prev, reasonCategory: e.target.value as ReasonCategory }))}
      >
        {MANUAL_REASON_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      {noteRequired && (
        <input
          type="text"
          placeholder="required note"
          value={form.reasonNote}
          onChange={(e) => setForm((prev) => ({ ...prev, reasonNote: e.target.value }))}
        />
      )}
      <button
        disabled={!canSave || setCustomsStatus.isPending}
        onClick={() =>
          setCustomsStatus.mutate({
            id: shipment.id,
            newStatus: form.customsStatus as (typeof CUSTOMS_STATUSES)[number],
            reasonCategory: form.reasonCategory,
            reasonNote: noteRequired ? form.reasonNote : undefined,
          })
        }
      >
        Save customs status
      </button>
      <button
        disabled={!canSave || !form.actualArrivalDate || shipment.status !== "customs" || !costsRecorded || markArrived.isPending}
        onClick={() =>
          markArrived.mutate({
            id: shipment.id,
            actualArrivalDate: new Date(form.actualArrivalDate),
            reasonCategory: form.reasonCategory,
            reasonNote: noteRequired ? form.reasonNote : undefined,
          })
        }
      >
        Save arrival date
      </button>
      {shipment.status !== "customs" && shipment.status !== "delivered" && <p>Available once the shipment has reached customs.</p>}
      {shipment.status === "customs" && !costsRecorded && <p>Available once freight/duty costs are recorded.</p>}
      {shipment.status === "delivered" && <p>Already arrived — arrival date saved, "Save arrival date" is disabled.</p>}
      {(setCustomsStatus.error ?? markArrived.error) && <div>Failed to save: {(setCustomsStatus.error ?? markArrived.error)!.message}</div>}
    </div>
  );
}

function DepartDateCorrectionControl({ shipment, onUpdated }: { shipment: ShipmentListItem; onUpdated: () => void }) {
  const correctDate = trpc.shipments.correctActualDepartDate.useMutation({ onSuccess: onUpdated });
  const [form, setForm] = useState<DepartDateCorrectionFormState>(() => defaultDepartDateCorrectionForm());
  const noteRequired = form.reasonCategory === "other";
  const canSave = !noteRequired || form.reasonNote.trim().length > 0;

  // markShipmentDeparted hasn't set an actual depart date yet on this shipment —
  // nothing to correct, so don't render the control at all.
  if (!shipment.actualDepartDate) return null;

  return (
    <div>
      <span>Actual depart: {new Date(shipment.actualDepartDate).toISOString().slice(0, 10)}</span>
      <input
        type="date"
        value={form.newDate}
        onChange={(e) => setForm((prev) => ({ ...prev, newDate: e.target.value }))}
      />
      <select
        value={form.reasonCategory}
        onChange={(e) => setForm((prev) => ({ ...prev, reasonCategory: e.target.value as ReasonCategory }))}
      >
        {MANUAL_REASON_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      {noteRequired && (
        <input
          type="text"
          placeholder="required note"
          value={form.reasonNote}
          onChange={(e) => setForm((prev) => ({ ...prev, reasonNote: e.target.value }))}
        />
      )}
      <button
        disabled={!canSave || correctDate.isPending}
        onClick={() =>
          correctDate.mutate({
            id: shipment.id,
            newDate: new Date(form.newDate),
            reasonCategory: form.reasonCategory,
            reasonNote: noteRequired ? form.reasonNote : undefined,
          })
        }
      >
        Correct depart date
      </button>
      {correctDate.error && <div>Failed to correct: {correctDate.error.message}</div>}
    </div>
  );
}

// Shared across every control whose mutation can be refused for a reason
// allowNegativeSoh:true legitimately overrides — either correctLedgerReceipt's
// own FIFO-replayability self-check ("...pass allowNegativeSoh to record the
// correction anyway") or the earlier, more commonly-hit negative-stock guard
// on the reversal write itself ("...would drive SOH negative..."), which the
// same flag bypasses but never names in its own message. Matched by message
// text (these procedures throw plain Errors, no typed error here) against
// /allowNegativeSoh/i OR /drive SOH negative/i — callers surface a distinct
// "Force this correction anyway" button that resubmits the exact same
// payload with allowNegativeSoh: true. Never shown by default, only after a
// refusal matching one of those patterns.
//
// Deliberately NOT a bare /negative/i: the router's own Zod validation on
// freightCost/dutyCost/amount/fxRate (server/routers.ts's
// nonNegativeDecimalString) produces "...must be a non-negative number in
// plain decimal notation" for an ordinary malformed input (e.g. a comma
// decimal separator) — that message contains "negative" too, and a bare
// /negative/i would wrongly surface this bypass button (plus its scary
// inconsistency warning) for a typo instead of a real stock-integrity
// refusal. /drive SOH negative/i matches only recordLedgerEvent's actual
// refusal text.
function needsForceBypass(error: { message: string } | null | undefined): boolean {
  return error != null && (/allowNegativeSoh/i.test(error.message) || /drive SOH negative/i.test(error.message));
}

// Only meaningful once a receipt has actually been written to the ledger
// (shipment.status === "delivered") — before that, there is nothing to
// correct. No reasonCategory here at all, per the design's Global Constraint
// for this whole stream: every correction is "data_correction" by
// construction, server-side. Copy stays neutral ("Correct quantity",
// "Correct cost restated"), never "Fix"/"mistake"/"wrong".
//
// correctLandedCost skips (does not fail on) a line whose recomputed cost is
// unchanged — lastCostResult reports "N of M" honestly rather than implying
// every line was touched.
function CorrectReceiptControl({
  shipment,
  lineItems,
  onUpdated,
}: {
  shipment: ShipmentListItem;
  lineItems: { id: number; skuId: number; qty: number }[];
  onUpdated: () => void;
}) {
  const correctReceiptQty = trpc.shipments.correctReceiptQty.useMutation({ onSuccess: onUpdated });
  const correctLandedCost = trpc.shipments.correctLandedCost.useMutation({ onSuccess: onUpdated });
  const [form, setForm] = useState<ReceiptCorrectionFormState>(() => defaultReceiptCorrectionForm(shipment));
  // `forced` records whether THIS successful submission carried
  // allowNegativeSoh: true — distinct from consumedFromOtherBatches (which
  // can be true even on an un-forced correction, e.g. plain FIFO reordering).
  // Drives the persistent post-success notice below: the ongoing consequence
  // of forcing (remaining-batch/Daily COGS may keep erroring for the
  // affected SKU(s)) doesn't go away once the mutation succeeds, so it can't
  // live only in the transient error-state warning the way the rest of this
  // component's error copy does.
  const [lastQtyResult, setLastQtyResult] = useState<{ consumedFromOtherBatches: boolean; forced: boolean } | null>(null);
  const [lastCostResult, setLastCostResult] = useState<{ correctedCount: number; consumedFromOtherBatches: boolean; forced: boolean } | null>(null);

  if (shipment.status !== "delivered") return null;

  const canCorrectQty = form.lineItemId !== "" && form.newQty.trim().length > 0 && form.reasonNote.trim().length > 0;
  const costsChanged = form.freightCost !== (shipment.freightCost ?? "")
    || form.adminFeesCost !== (shipment.adminFeesCost ?? "")
    || form.dutyCost !== (shipment.dutyCost ?? "")
    || form.eustAmount !== (shipment.eustAmount ?? "")
    || form.vatAmount !== (shipment.vatAmount ?? "");
  const canCorrectCost = costsChanged && form.reasonNote.trim().length > 0;

  // Present only after a refusal whose message names this escape hatch OR
  // describes the negative-stock condition it exists to bypass — see
  // needsForceBypass above for the matching rationale. mutation.error
  // naturally clears when a new mutate() call starts, so this hides itself
  // again as soon as the forced retry is in flight.
  const qtyNeedsForce = needsForceBypass(correctReceiptQty.error);
  const costNeedsForce = needsForceBypass(correctLandedCost.error);

  const submitQty = (allowNegativeSoh?: boolean) => {
    correctReceiptQty.mutate(
      {
        shipmentId: shipment.id,
        lineItemId: Number(form.lineItemId),
        newQty: Number(form.newQty),
        reasonNote: form.reasonNote,
        allowNegativeSoh,
      },
      { onSuccess: (result) => setLastQtyResult({ ...result, forced: allowNegativeSoh === true }) },
    );
  };

  const submitCost = (allowNegativeSoh?: boolean) => {
    correctLandedCost.mutate(
      {
        shipmentId: shipment.id,
        freightCost: form.freightCost !== (shipment.freightCost ?? "") ? form.freightCost : undefined,
        adminFeesCost: form.adminFeesCost !== (shipment.adminFeesCost ?? "") ? form.adminFeesCost : undefined,
        dutyCost: form.dutyCost !== (shipment.dutyCost ?? "") ? form.dutyCost : undefined,
        eustAmount: form.eustAmount !== (shipment.eustAmount ?? "") ? form.eustAmount : undefined,
        vatAmount: form.vatAmount !== (shipment.vatAmount ?? "") ? form.vatAmount : undefined,
        reasonNote: form.reasonNote,
        allowNegativeSoh,
      },
      {
        onSuccess: (result) =>
          setLastCostResult({
            correctedCount: result.corrections.length,
            consumedFromOtherBatches: result.corrections.some((c) => c.consumedFromOtherBatches),
            forced: allowNegativeSoh === true,
          }),
      },
    );
  };

  return (
    <div>
      <strong>Correct receipt</strong>
      <div>
        <select value={form.lineItemId} onChange={(e) => setForm((prev) => ({ ...prev, lineItemId: e.target.value }))}>
          <option value="">Line item…</option>
          {lineItems.map((li) => <option key={li.id} value={li.id}>SKU {li.skuId} — qty {li.qty}</option>)}
        </select>
        <input
          type="text"
          placeholder="corrected qty"
          value={form.newQty}
          onChange={(e) => setForm((prev) => ({ ...prev, newQty: e.target.value }))}
        />
        <button disabled={!canCorrectQty || correctReceiptQty.isPending} onClick={() => submitQty()}>
          Correct quantity
        </button>
        {qtyNeedsForce && (
          <button disabled={correctReceiptQty.isPending} onClick={() => submitQty(true)}>
            Force this correction anyway
          </button>
        )}
      </div>
      <div style={{ marginTop: "4px" }}>
        <input
          type="text"
          placeholder="freight (delivery) cost"
          value={form.freightCost}
          onChange={(e) => setForm((prev) => ({ ...prev, freightCost: e.target.value }))}
        />
        <input
          type="text"
          placeholder="admin fees"
          value={form.adminFeesCost}
          onChange={(e) => setForm((prev) => ({ ...prev, adminFeesCost: e.target.value }))}
        />
        <input
          type="text"
          placeholder="duty cost (non-refundable)"
          value={form.dutyCost}
          onChange={(e) => setForm((prev) => ({ ...prev, dutyCost: e.target.value }))}
        />
        <input
          type="text"
          placeholder="EUST (refundable)"
          value={form.eustAmount}
          onChange={(e) => setForm((prev) => ({ ...prev, eustAmount: e.target.value }))}
        />
        <input
          type="text"
          placeholder="VAT (refundable)"
          value={form.vatAmount}
          onChange={(e) => setForm((prev) => ({ ...prev, vatAmount: e.target.value }))}
        />
        <button disabled={!canCorrectCost || correctLandedCost.isPending} onClick={() => submitCost()}>
          Correct cost restated
        </button>
        {costNeedsForce && (
          <button disabled={correctLandedCost.isPending} onClick={() => submitCost(true)}>
            Force this correction anyway
          </button>
        )}
      </div>
      <input
        type="text"
        placeholder="what changed and why"
        value={form.reasonNote}
        onChange={(e) => setForm((prev) => ({ ...prev, reasonNote: e.target.value }))}
      />
      {correctReceiptQty.error && (
        <div>
          Failed to correct: {correctReceiptQty.error.message}
          {qtyNeedsForce && (
            <div>
              This correction would leave some stock data temporarily inconsistent until the underlying issue is
              resolved — remaining-batch and Daily COGS figures for this SKU may error out until the over-sale is
              separately resolved.
            </div>
          )}
        </div>
      )}
      {correctLandedCost.error && (
        <div>
          Failed to correct: {correctLandedCost.error.message}
          {costNeedsForce && (
            <div>
              Forcing this correction will apply to every line item on this shipment that needs it, not just
              one — remaining-batch and Daily COGS figures for those SKUs may error out until the over-sale is
              separately resolved.
            </div>
          )}
        </div>
      )}
      {lastQtyResult?.consumedFromOtherBatches && (
        <div>This correction drew from a different batch than the one being corrected, because the original batch was already partly or fully sold — past Daily COGS is not recalculated.</div>
      )}
      {lastQtyResult?.forced && (
        <div>
          This correction was forced past the negative-stock guard — remaining-batch and Daily COGS figures for
          this SKU may keep erroring out until the underlying over-sale is separately resolved.
        </div>
      )}
      {lastCostResult && (
        <div>
          Corrected {lastCostResult.correctedCount} of {lineItems.length} line items
          {lastCostResult.correctedCount < lineItems.length
            ? ` (${lineItems.length - lastCostResult.correctedCount} needed no change).`
            : "."}
          {lastCostResult.consumedFromOtherBatches &&
            " This correction drew from a different batch than the one being corrected, because the original batch was already partly or fully sold — past Daily COGS is not recalculated."}
        </div>
      )}
      {lastCostResult?.forced && (
        <div>
          This correction was forced past the negative-stock guard for every line item that needed it —
          remaining-batch and Daily COGS figures for those SKUs may keep erroring out until the underlying
          over-sale is separately resolved.
        </div>
      )}
    </div>
  );
}

// Visible only once a shipment has arrived and isn't locked yet — locking a
// not-yet-arrived shipment has no real meaning (see
// docs/2026-09-23-freight-duty-cost-lock-design.md §3), and once locked
// there's no unlock path to render a control for.
interface ShipmentLinksFormState {
  quoteLink: string;
  invoiceLink: string;
  customsInvoiceLink: string;
  customsDeclarationLink: string;
}

function defaultShipmentLinksForm(shipment: ShipmentListItem): ShipmentLinksFormState {
  return {
    quoteLink: shipment.quoteLink ?? "",
    invoiceLink: shipment.invoiceLink ?? "",
    customsInvoiceLink: shipment.customsInvoiceLink ?? "",
    customsDeclarationLink: shipment.customsDeclarationLink ?? "",
  };
}

// Reference links only (Google Drive etc.) -- this platform never stores the
// documents themselves. No reasonCategory/audit trail: these don't affect
// delay or cost, the only things this codebase's change_log tracks.
function ShipmentLinksControl({ shipment, onUpdated }: { shipment: ShipmentListItem; onUpdated: () => void }) {
  const updateLinks = trpc.shipments.updateLinks.useMutation({ onSuccess: onUpdated });
  const [form, setForm] = useState<ShipmentLinksFormState>(() => defaultShipmentLinksForm(shipment));

  const linkRow = (label: string, url: string | null) =>
    url ? <div>{label}: <a href={url} target="_blank" rel="noreferrer">{label}</a></div> : null;

  return (
    <div>
      {linkRow("Quote", shipment.quoteLink)}
      {linkRow("Invoice", shipment.invoiceLink)}
      {linkRow("Customs invoice", shipment.customsInvoiceLink)}
      {linkRow("Customs declaration", shipment.customsDeclarationLink)}
      <input
        type="text"
        placeholder="quote link"
        value={form.quoteLink}
        onChange={(e) => setForm((prev) => ({ ...prev, quoteLink: e.target.value }))}
      />
      <input
        type="text"
        placeholder="invoice link"
        value={form.invoiceLink}
        onChange={(e) => setForm((prev) => ({ ...prev, invoiceLink: e.target.value }))}
      />
      <input
        type="text"
        placeholder="customs invoice link"
        value={form.customsInvoiceLink}
        onChange={(e) => setForm((prev) => ({ ...prev, customsInvoiceLink: e.target.value }))}
      />
      <input
        type="text"
        placeholder="customs declaration link"
        value={form.customsDeclarationLink}
        onChange={(e) => setForm((prev) => ({ ...prev, customsDeclarationLink: e.target.value }))}
      />
      <button
        disabled={updateLinks.isPending}
        onClick={() =>
          updateLinks.mutate({
            id: shipment.id,
            quoteLink: form.quoteLink.trim(),
            invoiceLink: form.invoiceLink.trim(),
            customsInvoiceLink: form.customsInvoiceLink.trim(),
            customsDeclarationLink: form.customsDeclarationLink.trim(),
          })
        }
      >
        Save links
      </button>
      {updateLinks.error && <div>Failed to save: {updateLinks.error.message}</div>}
    </div>
  );
}

function ShipMethodControl({ shipment, onUpdated }: { shipment: ShipmentListItem; onUpdated: () => void }) {
  const updateMethod = trpc.shipments.updateMethod.useMutation({ onSuccess: onUpdated });
  const [shipMethod, setShipMethod] = useState(shipment.shipMethod ?? "");

  return (
    <div>
      <input type="text" placeholder="ship method (e.g. Sea, Air)" value={shipMethod} onChange={(e) => setShipMethod(e.target.value)} />
      <button disabled={updateMethod.isPending || shipMethod.trim() === ""} onClick={() => updateMethod.mutate({ id: shipment.id, shipMethod })}>
        Save method
      </button>
      {updateMethod.error && <div>Failed to save: {updateMethod.error.message}</div>}
    </div>
  );
}

interface NewShipmentPaymentFormState {
  sequenceNo: string;
  expectedAmount: string;
  expectedDate: string;
  currency: string;
}

function defaultNewShipmentPaymentForm(): NewShipmentPaymentFormState {
  return { sequenceNo: "1", expectedAmount: "", expectedDate: new Date().toISOString().slice(0, 10), currency: "EUR" };
}

// Minimal shipment-owned payments (customs clearance fees, freight
// instalments) — the payments table already supports shipmentId ownership
// generically; this page simply had no UI for it before. Deliberately
// lighter than PurchaseOrdersPage's own payments section (no correction
// control, no history link) -- proportionate to closing this one gap.
function ShipmentPaymentsSection({ shipmentId }: { shipmentId: number }) {
  const utils = trpc.useUtils();
  const paymentsQuery = trpc.payments.listForShipment.useQuery(shipmentId);
  const [form, setForm] = useState<NewShipmentPaymentFormState>(() => defaultNewShipmentPaymentForm());
  const createPayment = trpc.payments.createExpectedPayment.useMutation({
    onSuccess: () => {
      utils.payments.listForShipment.invalidate(shipmentId);
      setForm((prev) => ({ ...defaultNewShipmentPaymentForm(), sequenceNo: String(Number(prev.sequenceNo) + 1) }));
      utils.dashboards.money.invalidate();
    },
  });
  const markPaid = trpc.payments.markPaid.useMutation({
    onSuccess: () => {
      utils.payments.listForShipment.invalidate(shipmentId);
      utils.dashboards.money.invalidate();
    },
  });
  const canCreate = form.expectedAmount.trim().length > 0 && form.currency.trim().length > 0;

  if (paymentsQuery.error) return <div>Failed to load payments: {paymentsQuery.error.message}</div>;

  return (
    <div>
      <strong>Payments</strong>
      {paymentsQuery.isLoading && <div>Loading payments…</div>}
      {paymentsQuery.data && paymentsQuery.data.length > 0 && (
        <ul>
          {paymentsQuery.data.map((payment) => (
            <li key={payment.id}>
              #{payment.sequenceNo}: {formatMoney(payment.expectedAmount, payment.currency)} — {payment.paid ? "paid" : "unpaid"}
              {!payment.paid && (
                <button
                  disabled={markPaid.isPending}
                  onClick={() =>
                    markPaid.mutate({
                      id: payment.id,
                      amount: payment.expectedAmount,
                      fxRate: "1.0",
                      paidDate: new Date(),
                      reasonCategory: "payment_timing",
                    })
                  }
                >
                  Mark paid
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div>
        <input type="text" placeholder="sequence no" value={form.sequenceNo} onChange={(e) => setForm((prev) => ({ ...prev, sequenceNo: e.target.value }))} />
        <input type="text" placeholder="expected amount" value={form.expectedAmount} onChange={(e) => setForm((prev) => ({ ...prev, expectedAmount: e.target.value }))} />
        <input type="date" value={form.expectedDate} onChange={(e) => setForm((prev) => ({ ...prev, expectedDate: e.target.value }))} />
        <input type="text" placeholder="currency" value={form.currency} onChange={(e) => setForm((prev) => ({ ...prev, currency: e.target.value }))} />
        <button
          disabled={!canCreate || createPayment.isPending}
          onClick={() =>
            createPayment.mutate({
              shipmentId,
              sequenceNo: Number(form.sequenceNo) || 1,
              expectedAmount: form.expectedAmount,
              expectedDate: new Date(form.expectedDate),
              currency: form.currency,
            })
          }
        >
          Add expected payment (customs, freight instalment, etc.)
        </button>
        {createPayment.error && <div>Failed to save: {createPayment.error.message}</div>}
      </div>
    </div>
  );
}

function LockCostsControl({ shipment, onUpdated }: { shipment: ShipmentListItem; onUpdated: () => void }) {
  const lockCosts = trpc.shipments.lockCosts.useMutation({ onSuccess: onUpdated });
  const [reasonNote, setReasonNote] = useState("");

  if (shipment.status !== "delivered" || shipment.costsLockedAt != null) return null;

  return (
    <div>
      <input
        type="text"
        placeholder="why these costs are final"
        value={reasonNote}
        onChange={(e) => setReasonNote(e.target.value)}
      />
      <button
        disabled={reasonNote.trim().length === 0 || lockCosts.isPending}
        onClick={() => lockCosts.mutate({ id: shipment.id, reasonNote })}
      >
        Lock costs
      </button>
      {lockCosts.error && <div>Failed to lock: {lockCosts.error.message}</div>}
    </div>
  );
}

function ShipmentRow({ shipment }: { shipment: ShipmentListItem }) {
  const { data, error, isLoading, refetch } = trpc.shipments.getWithLineItems.useQuery(shipment.id);
  const utils = trpc.useUtils();
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const skusById = new Map((skusQuery.data ?? []).map((s) => [s.id, s]));
  const recordCosts = trpc.shipments.recordCosts.useMutation({
    onSuccess: () => {
      refetch();
      utils.shipments.list.invalidate();
      utils.dashboards.money.invalidate();
    },
  });
  const [form, setForm] = useState<CostsFormState>(() => defaultCostsForm(shipment));
  const [expanded, setExpanded] = useState(false);

  if (error) return <tr><td colSpan={7}>Failed to load {shipment.shipmentRef}: {error.message}</td></tr>;
  if (isLoading || !data) return <tr><td colSpan={7}>Loading {shipment.shipmentRef}…</td></tr>;

  // Once a shipment has arrived, the server requires reasonNote regardless of
  // reasonCategory — this now performs a real ledger correction, not just an
  // ordinary field edit. Pre-arrival, the old "only required for 'other'"
  // rule still applies.
  const noteRequired = form.reasonCategory === "other" || shipment.status === "delivered";
  const canSave = form.freightCost.trim().length > 0 && form.dutyCost.trim().length > 0 && form.costCurrency.trim().length > 0
    && (!noteRequired || form.reasonNote.trim().length > 0);

  // Post-arrival, recordCosts performs a real ledger correction (via
  // applyShipmentCostChange) and can hit the same negative-stock guard
  // CorrectReceiptControl's two actions can — but this plain "Save costs"
  // form had no way to supply the allowNegativeSoh escape hatch. Mirrors
  // CorrectReceiptControl's pattern exactly: needsForceBypass matches the
  // refusal, a "Force this correction anyway" button resubmits the same
  // payload with allowNegativeSoh: true, never shown until that refusal
  // happens.
  const costSaveNeedsForce = needsForceBypass(recordCosts.error);

  const submitCosts = (allowNegativeSoh?: boolean) => {
    recordCosts.mutate({
      id: shipment.id,
      freightCost: form.freightCost,
      adminFeesCost: form.adminFeesCost || undefined,
      dutyCost: form.dutyCost,
      eustAmount: form.eustAmount || undefined,
      vatAmount: form.vatAmount || undefined,
      costCurrency: form.costCurrency,
      reasonCategory: form.reasonCategory,
      reasonNote: noteRequired ? form.reasonNote : undefined,
      allowNegativeSoh,
    });
  };

  const costsSummary = (
    <div>
      Freight: {shipment.freightCost != null && shipment.costCurrency ? formatMoney(shipment.freightCost, shipment.costCurrency) : "—"}
      {" · "}
      Admin fees: {shipment.adminFeesCost != null && shipment.costCurrency ? formatMoney(shipment.adminFeesCost, shipment.costCurrency) : "—"}
      {" · "}
      Duty: {shipment.dutyCost != null && shipment.costCurrency ? formatMoney(shipment.dutyCost, shipment.costCurrency) : "—"}
      {" · "}
      EUST: {shipment.eustAmount != null && shipment.costCurrency ? formatMoney(shipment.eustAmount, shipment.costCurrency) : "—"}
      {" · "}
      VAT: {shipment.vatAmount != null && shipment.costCurrency ? formatMoney(shipment.vatAmount, shipment.costCurrency) : "—"}
      {shipment.costsLockedAt != null && " 🔒"}
    </div>
  );

  return (
    <>
      <tr>
        <td>{shipment.shipmentRef}</td>
        <td>
          <span className={SHIPMENT_STATUS_BADGE_CLASS[shipment.status] ?? DEFAULT_STATUS_BADGE_CLASS}>{shipment.status}</span>
          <div style={{ marginTop: "8px" }}>
            <button onClick={() => setExpanded((x) => !x)}>{expanded ? "Hide details ▴" : "Details ▾"}</button>
          </div>
        </td>
        <td>{data.lineItems.length} line item{data.lineItems.length === 1 ? "" : "s"}</td>
        <td>{costsSummary}</td>
        <td>{shipment.quoteLink || shipment.invoiceLink || shipment.customsInvoiceLink || shipment.customsDeclarationLink ? "links set" : "—"}</td>
        <td>{shipment.shipMethod ?? "—"}</td>
        <td>{expanded ? null : "(see details)"}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7}>
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div>
                <div style={{ marginTop: "8px" }}>
                  <PlannedDepartureControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />
                </div>
                <div style={{ marginTop: "8px" }}>
                  <StatusTransitionControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />
                </div>
                <div style={{ marginTop: "8px" }}>
                  <CustomsArrivalControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />
                </div>
                <div style={{ marginTop: "8px" }}>
                  <DepartDateCorrectionControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />
                </div>
                <div style={{ marginTop: "8px" }}>
                  <CorrectReceiptControl
                    shipment={shipment}
                    lineItems={data.lineItems}
                    onUpdated={() => { refetch(); utils.shipments.list.invalidate(); utils.dashboards.money.invalidate(); utils.dashboards.stock.invalidate(); }}
                  />
                </div>
                <div style={{ marginTop: "8px" }}><Link to={`/change-log/shipment/${shipment.id}`}>History</Link></div>
              </div>
              <div>
                <ul>
                  {data.lineItems.map((li) => (
                    <li key={li.id}>{skuLabel(skusById.get(li.skuId) ?? { id: li.skuId })} — qty {li.qty}</li>
                  ))}
                </ul>
              </div>
              <div>
                {shipment.status === "delivered" && shipment.costsLockedAt == null && (
                  <p>
                    This shipment has arrived — saving here restates the ledger receipt for every affected line.
                  </p>
                )}
                {shipment.costsLockedAt != null && (
                  <p>
                    Locked on {new Date(shipment.costsLockedAt).toISOString().slice(0, 10)} — use this shipment's
                    "Correct cost restated" control to make further changes.
                  </p>
                )}
                <input
                  type="text"
                  placeholder="freight (delivery) cost"
                  value={form.freightCost}
                  disabled={shipment.costsLockedAt != null}
                  onChange={(e) => setForm((prev) => ({ ...prev, freightCost: e.target.value }))}
                />
                <input
                  type="text"
                  placeholder="admin fees"
                  value={form.adminFeesCost}
                  disabled={shipment.costsLockedAt != null}
                  onChange={(e) => setForm((prev) => ({ ...prev, adminFeesCost: e.target.value }))}
                />
                <input
                  type="text"
                  placeholder="duty cost (non-refundable)"
                  value={form.dutyCost}
                  disabled={shipment.costsLockedAt != null}
                  onChange={(e) => setForm((prev) => ({ ...prev, dutyCost: e.target.value }))}
                />
                <input
                  type="text"
                  placeholder="EUST (refundable)"
                  value={form.eustAmount}
                  disabled={shipment.costsLockedAt != null}
                  onChange={(e) => setForm((prev) => ({ ...prev, eustAmount: e.target.value }))}
                />
                <input
                  type="text"
                  placeholder="VAT (refundable)"
                  value={form.vatAmount}
                  disabled={shipment.costsLockedAt != null}
                  onChange={(e) => setForm((prev) => ({ ...prev, vatAmount: e.target.value }))}
                />
                <input
                  type="text"
                  placeholder="currency"
                  value={form.costCurrency}
                  onChange={(e) => setForm((prev) => ({ ...prev, costCurrency: e.target.value }))}
                />
                <select
                  value={form.reasonCategory}
                  onChange={(e) => setForm((prev) => ({ ...prev, reasonCategory: e.target.value as ReasonCategory }))}
                >
                  {MANUAL_REASON_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                {noteRequired && (
                  <input
                    type="text"
                    placeholder="required note"
                    value={form.reasonNote}
                    onChange={(e) => setForm((prev) => ({ ...prev, reasonNote: e.target.value }))}
                  />
                )}
                <button
                  disabled={!canSave || shipment.costsLockedAt != null || recordCosts.isPending}
                  onClick={() => submitCosts()}
                >
                  Save costs
                </button>
                {costSaveNeedsForce && (
                  <button disabled={recordCosts.isPending} onClick={() => submitCosts(true)}>
                    Force this correction anyway
                  </button>
                )}
                {recordCosts.error && (
                  <div>
                    Failed to save: {recordCosts.error.message}
                    {costSaveNeedsForce && (
                      <div>
                        Forcing this correction will apply to every line item on this shipment that needs it, not
                        just one — remaining-batch and Daily COGS figures for those SKUs may error out until the
                        over-sale is separately resolved.
                      </div>
                    )}
                  </div>
                )}
                <div style={{ marginTop: "8px" }}>
                  <LockCostsControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />
                </div>
              </div>
              <div>
                <ShipmentLinksControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />
              </div>
              <div>
                <ShipMethodControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />
              </div>
              <div>
                <ShipmentPaymentsSection shipmentId={shipment.id} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

interface NewShipmentLineItem {
  poLineItemId: number;
  skuId: number;
  qty: number;
  weightShare: string;
  valueShare: string;
}

function NewLineItemPicker({ onAdd }: { onAdd: (li: NewShipmentLineItem) => void }) {
  const posQuery = trpc.purchaseOrders.list.useQuery();
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const skusById = new Map((skusQuery.data ?? []).map((s) => [s.id, s]));
  const [poId, setPoId] = useState("");
  const poLineItemsQuery = trpc.purchaseOrders.getWithLineItems.useQuery(Number(poId), { enabled: poId !== "" });
  const [poLineItemId, setPoLineItemId] = useState("");
  const [qty, setQty] = useState("");
  const [weightShare, setWeightShare] = useState("1.0");
  const [valueShare, setValueShare] = useState("1.0");

  if (posQuery.error) return <div>Failed to load purchase orders: {posQuery.error.message}</div>;

  const selectedLineItem = poLineItemsQuery.data?.lineItems.find((li) => li.id === Number(poLineItemId));
  const canAdd = poId !== "" && poLineItemId !== "" && qty.trim().length > 0 && weightShare.trim().length > 0 && valueShare.trim().length > 0;

  return (
    <div>
      <select value={poId} onChange={(e) => { setPoId(e.target.value); setPoLineItemId(""); }}>
        <option value="">PO…</option>
        {(posQuery.data ?? []).map((po) => <option key={po.id} value={po.id}>{po.poNumber}</option>)}
      </select>
      {poId !== "" && poLineItemsQuery.isLoading && <span>Loading line items…</span>}
      {poId !== "" && poLineItemsQuery.error && <span>Failed to load line items: {poLineItemsQuery.error.message}</span>}
      {poId !== "" && poLineItemsQuery.data && (
        <select value={poLineItemId} onChange={(e) => setPoLineItemId(e.target.value)}>
          <option value="">Line item…</option>
          {poLineItemsQuery.data.lineItems.map((li) => (
            <option key={li.id} value={li.id}>{skuLabel(skusById.get(li.skuId) ?? { id: li.skuId })} — qty {li.qty} @ {formatMoney(li.unitPrice, li.currency)}</option>
          ))}
        </select>
      )}
      <input type="text" placeholder="qty" value={qty} onChange={(e) => setQty(e.target.value)} />
      <input type="text" placeholder="weight share" value={weightShare} onChange={(e) => setWeightShare(e.target.value)} />
      <input type="text" placeholder="value share" value={valueShare} onChange={(e) => setValueShare(e.target.value)} />
      <button
        disabled={!canAdd}
        onClick={() => {
          if (!selectedLineItem) return;
          onAdd({ poLineItemId: selectedLineItem.id, skuId: selectedLineItem.skuId, qty: Number(qty), weightShare, valueShare });
          setPoLineItemId("");
          setQty("");
        }}
      >
        Add line item
      </button>
    </div>
  );
}

function CreateShipmentForm() {
  const utils = trpc.useUtils();
  const warehousesQuery = trpc.catalog.listWarehouses.useQuery();
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const skusById = new Map((skusQuery.data ?? []).map((s) => [s.id, s]));
  const [shipmentRef, setShipmentRef] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [lineItems, setLineItems] = useState<NewShipmentLineItem[]>([]);
  const createShipment = trpc.shipments.create.useMutation({
    onSuccess: () => {
      setShipmentRef("");
      setWarehouseId("");
      setLineItems([]);
      utils.shipments.list.invalidate();
    },
  });

  if (warehousesQuery.error) return <div>Failed to load warehouses: {warehousesQuery.error.message}</div>;

  const canCreate = shipmentRef.trim().length > 0 && warehouseId !== "" && lineItems.length > 0;

  return (
    <div>
      <h2>New Shipment</h2>
      <input type="text" placeholder="shipment ref" value={shipmentRef} onChange={(e) => setShipmentRef(e.target.value)} />
      <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
        <option value="">Warehouse…</option>
        {(warehousesQuery.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
      </select>
      {lineItems.length > 0 && (
        <ul>
          {lineItems.map((li, i) => (
            <li key={i}>
              {skuLabel(skusById.get(li.skuId) ?? { id: li.skuId })} — qty {li.qty} (weight {li.weightShare}, value {li.valueShare}){" "}
              <button onClick={() => setLineItems((prev) => prev.filter((_, idx) => idx !== i))}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <NewLineItemPicker onAdd={(li) => setLineItems((prev) => [...prev, li])} />
      <button
        disabled={!canCreate || createShipment.isPending}
        onClick={() => createShipment.mutate({ shipmentRef, warehouseId: Number(warehouseId), lineItems })}
      >
        Create shipment
      </button>
      {createShipment.error && <div>Failed to create: {createShipment.error.message}</div>}
    </div>
  );
}

export function ShipmentsPage() {
  const { data: shipmentsList, error, isLoading } = trpc.shipments.list.useQuery();

  if (error) return <div>Failed to load: {error.message}</div>;
  if (isLoading || !shipmentsList) return <div>Loading…</div>;

  return (
    <div>
      <h1>Shipments</h1>
      <p>Each shipment lists the PO line items it carries — one shipment can pool cargo from multiple POs.</p>
      <CreateShipmentForm />
      <table>
        <thead><tr><th>Ref</th><th>Status</th><th>Line items</th><th>Costs</th><th>Links</th><th>Method</th><th>Payments</th></tr></thead>
        <tbody>
          {shipmentsList.map((shipment) => (
            <ShipmentRow key={shipment.id} shipment={shipment} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
