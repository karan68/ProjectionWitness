import { z } from "zod";

export const OrderIdSchema = z.string().trim().min(1).max(128);
export const EventReferenceSchema = z.string().trim().min(1).max(128);
export const StreamVersionSchema = z.number().int().positive().safe();
export const CentsSchema = z.number().int().nonnegative().safe();

const OrderPlacedDataSchema = z
  .object({
    type: z.literal("OrderPlaced"),
    totalCents: CentsSchema,
  })
  .strict();

const PaymentCapturedDataSchema = z
  .object({
    type: z.literal("PaymentCaptured"),
    paymentId: EventReferenceSchema,
    amountCents: CentsSchema,
  })
  .strict();

const OrderShippedDataSchema = z
  .object({
    type: z.literal("OrderShipped"),
    shipmentId: EventReferenceSchema,
  })
  .strict();

export const OrderEventDataSchema = z.discriminatedUnion("type", [
  OrderPlacedDataSchema,
  PaymentCapturedDataSchema,
  OrderShippedDataSchema,
]);

const versionedFields = {
  streamId: OrderIdSchema,
  streamVersion: StreamVersionSchema,
};

export const OrderEventSchema = z.discriminatedUnion("type", [
  OrderPlacedDataSchema.extend(versionedFields).strict(),
  PaymentCapturedDataSchema.extend(versionedFields).strict(),
  OrderShippedDataSchema.extend(versionedFields).strict(),
]);

export type OrderEventData = z.infer<typeof OrderEventDataSchema>;
export type OrderEvent = z.infer<typeof OrderEventSchema>;

export function versionOrderEvent(
  streamId: string,
  streamVersion: number,
  event: OrderEventData,
): OrderEvent {
  return OrderEventSchema.parse({ streamId, streamVersion, ...event });
}
