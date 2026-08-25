import { OrderIdSchema } from "@projection-witness/domain";
import { RepairEnvelopeSchema } from "@projection-witness/evidence";
import { ApplyProjectionRepairInputSchema } from "@projection-witness/repair";
import { z } from "zod";

export const ProjectionNameSchema = z.string().trim().min(1).max(128).default("orders");
export const OrderCaseInputSchema = z.object({ orderId: OrderIdSchema }).strict();
export const ProjectionCaseInputSchema = z
  .object({ orderId: OrderIdSchema, projectionName: ProjectionNameSchema })
  .strict();
export const SnapshotStreamInputSchema = z
  .object({
    streamId: OrderIdSchema,
    maxEvents: z.number().int().positive().safe().max(1_000).default(1_000),
    maxCanonicalBytes: z.number().int().positive().safe().max(1_048_576).default(1_048_576),
  })
  .strict();
export const RuntimeInputSchema = z.object({ projectionName: ProjectionNameSchema }).strict();
export const StageRepairInputSchema = z.object({ envelope: RepairEnvelopeSchema }).strict();
export const VerifyRepairInputSchema = z.object({ planId: z.uuid() }).strict();
export const ApplyRepairInputSchema = ApplyProjectionRepairInputSchema;

export const FindCaseOutputSchema = z
  .object({ found: z.boolean(), streamExists: z.boolean(), projectionExists: z.boolean() })
  .strict();
export const PublicStateOutputSchema = z
  .object({ statusCode: z.number().int(), body: z.json() })
  .strict();
export const InspectCaseOutputSchema = z
  .object({
    row: z.json().nullable(),
    checkpoint: z.string().nullable(),
    gapPositions: z.array(z.string()).max(100),
  })
  .strict();
export const SnapshotOutputSchema = z
  .object({ events: z.array(z.json()), evidence: z.json() })
  .strict();
export const RuntimeOutputSchema = z.object({ runtime: z.json().nullable() }).strict();
export const StageOutputSchema = z
  .object({
    planId: z.string(),
    evidenceSha256: z.string(),
    status: z.string(),
    created: z.boolean(),
  })
  .strict();
export const VerifyOutputSchema = z
  .object({
    planStatus: z.string().nullable(),
    auditReceiptSha256: z.string().nullable(),
    rowMatchesAudit: z.boolean().nullable(),
    publicStatusCode: z.number().int(),
  })
  .strict();
export const ApplyOutputSchema = z
  .object({
    status: z.string(),
    planId: z.string(),
    auditId: z.string(),
    receiptSha256: z.string(),
  })
  .strict();

export const ToolErrorSchema = z.object({ code: z.string(), message: z.string() }).strict();
