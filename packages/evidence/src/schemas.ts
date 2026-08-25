import {
  FulfillmentStatusSchema,
  OrderEventDataSchema,
  OrderIdSchema,
  PaymentStatusSchema,
  StreamVersionSchema,
} from "@projection-witness/domain";
import { z } from "zod";

export const DecimalBigintSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const PositiveDecimalBigintSchema = z.string().regex(/^[1-9][0-9]*$/);
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const CanonicalOrderEventSchema = z
  .object({
    eventId: z.uuid(),
    globalPosition: PositiveDecimalBigintSchema,
    streamId: OrderIdSchema,
    streamVersion: StreamVersionSchema,
    eventType: z.enum(["OrderPlaced", "PaymentCaptured", "OrderShipped"]),
    payload: OrderEventDataSchema,
    metadata: z.record(z.string(), z.json()),
    recordedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.eventType !== event.payload.type) {
      context.addIssue({
        code: "custom",
        message: "Event type does not match its payload type",
        path: ["eventType"],
      });
    }
  });

export const CanonicalProjectionValueSchema = z
  .object({
    orderId: OrderIdSchema,
    totalCents: DecimalBigintSchema,
    paidCents: DecimalBigintSchema,
    paymentStatus: PaymentStatusSchema,
    fulfillmentStatus: FulfillmentStatusSchema,
    lastStreamVersion: StreamVersionSchema,
  })
  .strict();

export const CurrentProjectionRowSchema = CanonicalProjectionValueSchema.extend({
  rowVersion: PositiveDecimalBigintSchema,
}).strict();

export const RuntimeEvidenceSchema = z
  .object({
    projectionName: z.string().trim().min(1).max(128),
    generation: PositiveDecimalBigintSchema,
    reducerSha256: Sha256Schema,
    sourceCommitSha: z.string().trim().min(1).max(128),
    algorithmVersion: z.string().trim().min(1).max(128),
    gapStrategy: z.string().trim().min(1).max(128),
  })
  .strict();

export type CanonicalOrderEvent = z.infer<typeof CanonicalOrderEventSchema>;
export type CanonicalProjectionValue = z.infer<typeof CanonicalProjectionValueSchema>;
export type CurrentProjectionRow = z.infer<typeof CurrentProjectionRowSchema>;
export type RuntimeEvidence = z.infer<typeof RuntimeEvidenceSchema>;
