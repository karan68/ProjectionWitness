import { parseSafeDatabaseInteger } from "@projection-witness/database";
import { OrderIdSchema, OrderProjectionSchema } from "@projection-witness/domain";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";

interface OrderViewRow {
  order_id: string;
  total_cents: string;
  paid_cents: string;
  payment_status: string;
  fulfillment_status: string;
  last_stream_version: number;
}

export function buildOrderApi(pool: Pool): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ ok: true }));

  app.get<{ Params: { orderId: string } }>("/orders/:orderId", async (request, reply) => {
    const parsedOrderId = OrderIdSchema.safeParse(request.params.orderId);
    if (!parsedOrderId.success) {
      return reply.code(400).send({ code: "INVALID_ORDER_ID" });
    }

    const result = await pool.query<OrderViewRow>(
      `SELECT
         order_id,
         total_cents::text,
         paid_cents::text,
         payment_status,
         fulfillment_status,
         last_stream_version
       FROM order_view
       WHERE order_id = $1`,
      [parsedOrderId.data],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return reply.code(404).send({ code: "CASE_NOT_FOUND" });
    }

    return OrderProjectionSchema.parse({
      orderId: row.order_id,
      totalCents: parseSafeDatabaseInteger(row.total_cents, "order_view.total_cents"),
      paidCents: parseSafeDatabaseInteger(row.paid_cents, "order_view.paid_cents"),
      paymentStatus: row.payment_status,
      fulfillmentStatus: row.fulfillment_status,
      lastStreamVersion: row.last_stream_version,
    });
  });

  return app;
}
