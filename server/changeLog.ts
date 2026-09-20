import { and, desc, eq } from "drizzle-orm";
import { db, type DbClient } from "./dbClient";
import { changeLog, REASON_CATEGORIES } from "../drizzle/schema";

export type ReasonCategory = (typeof REASON_CATEGORIES)[number];

export interface LogChangeInput {
  entityType: string;
  entityId: number;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  reasonCategory?: ReasonCategory;
  reasonNote?: string;
  changedBy: number;
}

export async function logChange(input: LogChangeInput, dbClient: DbClient = db): Promise<void> {
  if (input.reasonCategory === "other" && !input.reasonNote) {
    throw new Error("reasonNote is required when reasonCategory is 'other'");
  }
  await dbClient.insert(changeLog).values({
    entityType: input.entityType,
    entityId: input.entityId,
    field: input.field,
    oldValue: input.oldValue,
    newValue: input.newValue,
    reasonCategory: input.reasonCategory ?? null,
    reasonNote: input.reasonNote ?? null,
    changedBy: input.changedBy,
  });
}

export async function listChangeLog(entityType: string, entityId: number) {
  return db
    .select()
    .from(changeLog)
    .where(and(eq(changeLog.entityType, entityType), eq(changeLog.entityId, entityId)))
    .orderBy(desc(changeLog.changedAt));
}
