import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./dbClient";
import { changeLog, users } from "../drizzle/schema";
import { logChange, listChangeLog } from "./changeLog";
import { createUser } from "./db";

let userId: number;

beforeEach(async () => {
  // Real FKs tie other tables to users now (purchase_orders.createdBy,
  // shipments.createdBy) -- a row left behind by another test file's last
  // test (no afterAll anywhere in this suite) can otherwise block this
  // delete regardless of file order. Disabling FK checks for the cleanup
  // makes this file's reset order-independent again.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      await tx.delete(changeLog);
      await tx.delete(users);
    } finally {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }
  });
  const user = await createUser({ email: "test@accommerce.example", role: "editor" });
  userId = user.id;
});

describe("logChange", () => {
  it("records a plain field change with no reason required", async () => {
    await logChange({
      entityType: "purchase_order",
      entityId: 1,
      field: "notes",
      oldValue: "old note",
      newValue: "new note",
      changedBy: userId,
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
        changedBy: userId,
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
      changedBy: userId,
    });
    const entries = await listChangeLog("purchase_order", 1);
    expect(entries[0].reasonCategory).toBe("customs_hold");
  });
});
