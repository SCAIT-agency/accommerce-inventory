// Human classifications of dry-run findings. Every entry is a decision made
// after reproducing the divergence — never auto-assigned. A finding with no
// matching entry stays "unclassified" and keeps the verdict at NOT SAFE.

import type { Classifier, Classification, Target } from "./reconcile";

export interface ClassificationRule {
  target: Target;
  keyPattern: RegExp;
  classification: Classification;
  note: string;
}

export const CLASSIFICATIONS: ClassificationRule[] = [
  {
    // Landed Cost Summary is rebuilt by buildLandedCostSummary() in
    // jello-sc-tables.gs (2026-09-15). For the one Shipment ID that spans two
    // Sheet rows ("Mutual-PO2-Delivered": Straw 3,240 and Mixer 700) its Qty
    // lookup resolves the first row with that ID for both lines, so the Mixer
    // line restates the Straw qty. Cost/unit on that line is right (verified:
    // R4 cost matched); only the restated qty is wrong. Fix belongs in the
    // Apps Script (key the lookup on Shipment ID + SKU), not here.
    target: "R4",
    keyPattern: /^Mutual-PO2-Delivered \/ Mixer qty$/,
    classification: "sheet_bug",
    note: "Landed Cost Summary restates the Straw row's qty (3,240) on the Mixer line; Shipments says 700. Apps Script lookup keyed on Shipment ID only.",
  },
];

export const classifyKnown: Classifier = (finding) => {
  const rule = CLASSIFICATIONS.find((r) => r.target === finding.target && r.keyPattern.test(finding.key));
  return rule ? { classification: rule.classification, note: rule.note } : { classification: "unclassified" };
};
