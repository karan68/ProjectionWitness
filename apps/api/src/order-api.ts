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

interface RuntimeMetadataRow {
  generation: string;
  reducer_sha256: string;
  source_commit_sha: string;
  algorithm_version: string;
  gap_strategy: string;
}

export interface OrderApiOptions {
  logger?: boolean;
}

async function getRuntimeMetadata(pool: Pool): Promise<RuntimeMetadataRow | undefined> {
  const tableResult = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.projection_runtime') IS NOT NULL AS exists",
  );
  if (tableResult.rows[0]?.exists !== true) {
    return undefined;
  }

  const runtimeResult = await pool.query<RuntimeMetadataRow>(
    `SELECT
       generation::text,
       reducer_sha256,
       source_commit_sha,
       algorithm_version,
       gap_strategy
     FROM projection_runtime
     WHERE projection_name = 'orders'`,
  );
  return runtimeResult.rows[0];
}

export function buildOrderApi(pool: Pool, options: OrderApiOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error, requestId: request.id }, "Order API request failed");
    return reply.code(500).send({
      code: "INTERNAL_ERROR",
      message: "The request could not be completed",
    });
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/readyz", async (_request, reply) => {
    try {
      await pool.query("SELECT 1");
      const runtime = await getRuntimeMetadata(pool);
      if (runtime === undefined) {
        return reply.code(503).send({ ready: false, code: "RUNTIME_UNATTESTED" });
      }
      return { ready: true };
    } catch {
      return reply.code(503).send({ ready: false, code: "DATABASE_UNAVAILABLE" });
    }
  });

  app.get("/meta", async (_request, reply) => {
    const runtime = await getRuntimeMetadata(pool);
    if (runtime === undefined) {
      return reply.code(503).send({ code: "RUNTIME_UNATTESTED" });
    }
    return {
      sourceCommitSha: runtime.source_commit_sha,
      reducerSha256: runtime.reducer_sha256,
      projectorGeneration: runtime.generation,
      algorithmVersion: runtime.algorithm_version,
      gapStrategy: runtime.gap_strategy,
    };
  });

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
