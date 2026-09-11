import { describe, it, expect, beforeEach } from "vitest";
import { db } from "./dbClient";
import { changeLog } from "../drizzle/schema";
import { logChange, listChangeLog } from "./changeLog";

beforeEach(async () => {
  await db.delete(changeLog);
});

describe("logChange", () => {
  it("records a plain field change with no reason required", async () => {
    await logChange({
      entityType: "purchase_order",
      entityId: 1,
      field: "notes",
      oldValue: "old note",
      newValue: "new note",
      changedBy: 1,
    });
    const entries = await listChangeLog("purchase_order", 1);
    expect(entries).toHaveLength(1);
    expect(entries[0].reasonCategory).toBeNull();
  });

  it("requires reason_note when reasonCategory is 'other'", async () => {
    await expect(
      logChange({
        entityType: "purchase_order",
        entityId: 1,
        field: "plannedReadyDate",
        oldValue: "2026-09-01",
        newValue: "2026-09-15",
        reasonCategory: "other",
        changedBy: 1,
      }),
    ).rejects.toThrow(/reasonNote is required/);
  });

  it("stores a categorized delay reason", async () => {
    await logChange({
      entityType: "purchase_order",
      entityId: 1,
      field: "plannedReadyDate",
      oldValue: "2026-09-01",
      newValue: "2026-09-15",
      reasonCategory: "customs_hold",
      changedBy: 1,
    });
    const entries = await listChangeLog("purchase_order", 1);
    expect(entries[0].reasonCategory).toBe("customs_hold");
  });
});
