import { z } from "zod";
import { CentsSchema, OrderIdSchema, StreamVersionSchema } from "./order-events.js";

export const PaymentStatusSchema = z.enum(["AWAITING_PAYMENT", "PARTIALLY_PAID", "PAID"]);
export const FulfillmentStatusSchema = z.enum(["NOT_SHIPPED", "SHIPPED"]);

export const OrderProjectionSchema = z
  .object({
    orderId: OrderIdSchema,
    totalCents: CentsSchema,
    paidCents: CentsSchema,
    paymentStatus: PaymentStatusSchema,
    fulfillmentStatus: FulfillmentStatusSchema,
    lastStreamVersion: StreamVersionSchema,
  })
  .strict();

export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;
export type FulfillmentStatus = z.infer<typeof FulfillmentStatusSchema>;
export type OrderProjection = z.infer<typeof OrderProjectionSchema>;
