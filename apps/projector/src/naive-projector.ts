import { parseSafeDatabaseInteger } from "@projection-witness/database";
import {
  OrderEventDataSchema,
  OrderProjectionSchema,
  versionOrderEvent,
  type OrderProjection,
} from "@projection-witness/domain";
import { reduceOrder } from "@projection-witness/reducer";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

const ProjectionNameSchema = z.string().trim().min(1).max(128);
const PositiveIntegerSchema = z.number().int().positive().safe();

interface CheckpointRow {
  last_global_position: string;
}

interface ProjectorEventRow {
  global_position: string;
  stream_id: string;
  stream_version: number;
  event_type: string;
  payload: unknown;
}

interface OrderViewRow {
  order_id: string;
  total_cents: string;
  paid_cents: string;
  payment_status: string;
  fulfillment_status: string;
  last_stream_version: number;
  row_version: string;
}

export interface NaiveProjectorOptions {
  projectionName?: string;
  batchSize?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}

export interface ProjectorPollResult {
  projectionName: string;
  processedCount: number;
  checkpointBefore: string;
  checkpointAfter: string;
  processedGlobalPositions: readonly string[];
}

function projectionFromRow(row: OrderViewRow): OrderProjection {
  return OrderProjectionSchema.parse({
    orderId: row.order_id,
    totalCents: parseSafeDatabaseInteger(row.total_cents, "order_view.total_cents"),
    paidCents: parseSafeDatabaseInteger(row.paid_cents, "order_view.paid_cents"),
    paymentStatus: row.payment_status,
    fulfillmentStatus: row.fulfillment_status,
    lastStreamVersion: row.last_stream_version,
  });
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original projector failure remains authoritative.
  }
}

export class NaiveOrderProjector {
  private readonly pool: Pool;
  private readonly projectionName: string;
  private readonly batchSize: number;
  private readonly lockTimeoutMs: number;
  private readonly statementTimeoutMs: number;

  constructor(pool: Pool, options: NaiveProjectorOptions = {}) {
    this.pool = pool;
    this.projectionName = ProjectionNameSchema.parse(options.projectionName ?? "orders");
    this.batchSize = PositiveIntegerSchema.parse(options.batchSize ?? 100);
    this.lockTimeoutMs = PositiveIntegerSchema.parse(options.lockTimeoutMs ?? 2_000);
    this.statementTimeoutMs = PositiveIntegerSchema.parse(options.statementTimeoutMs ?? 5_000);
  }

  async poll(): Promise<ProjectorPollResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('lock_timeout', $1, true)", [
        `${String(this.lockTimeoutMs)}ms`,
      ]);
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${String(this.statementTimeoutMs)}ms`,
      ]);
      await client.query(
        `INSERT INTO projection_checkpoints (projection_name, last_global_position)
         VALUES ($1, 0)
         ON CONFLICT (projection_name) DO NOTHING`,
        [this.projectionName],
      );

      const checkpointResult = await client.query<CheckpointRow>(
        `SELECT last_global_position::text
         FROM projection_checkpoints
         WHERE projection_name = $1
         FOR UPDATE`,
        [this.projectionName],
      );
      const checkpoint = checkpointResult.rows[0];
      if (checkpoint === undefined) {
        throw new Error("Projection checkpoint disappeared while polling");
      }

      const eventsResult = await client.query<ProjectorEventRow>(
        `SELECT
           global_position::text,
           stream_id,
           stream_version,
           event_type,
           payload
         FROM events
         WHERE global_position > $1::bigint
         ORDER BY events.global_position
         LIMIT $2`,
        [checkpoint.last_global_position, this.batchSize],
      );

      const processedGlobalPositions: string[] = [];
      for (const eventRow of eventsResult.rows) {
        const payload = OrderEventDataSchema.parse(eventRow.payload);
        if (payload.type !== eventRow.event_type) {
          throw new Error("Stored event type does not match its payload type");
        }
        const event = versionOrderEvent(eventRow.stream_id, eventRow.stream_version, payload);
        const rowResult = await client.query<OrderViewRow>(
          `SELECT
             order_id,
             total_cents::text,
             paid_cents::text,
             payment_status,
             fulfillment_status,
             last_stream_version,
             row_version::text
           FROM order_view
           WHERE order_id = $1
           FOR UPDATE`,
          [event.streamId],
        );
        const currentRow = rowResult.rows[0];
        const candidate = reduceOrder(
          currentRow === undefined ? null : projectionFromRow(currentRow),
          event,
        );

        if (currentRow === undefined) {
          await client.query(
            `INSERT INTO order_view (
               order_id,
               total_cents,
               paid_cents,
               payment_status,
               fulfillment_status,
               last_stream_version
             )
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              candidate.orderId,
              candidate.totalCents,
              candidate.paidCents,
              candidate.paymentStatus,
              candidate.fulfillmentStatus,
              candidate.lastStreamVersion,
            ],
          );
        } else {
          const updateResult = await client.query(
            `UPDATE order_view
             SET total_cents = $2,
                 paid_cents = $3,
                 payment_status = $4,
                 fulfillment_status = $5,
                 last_stream_version = $6,
                 row_version = row_version + 1,
                 updated_at = clock_timestamp()
             WHERE order_id = $1
               AND row_version = $7::bigint
               AND last_stream_version = $8`,
            [
              candidate.orderId,
              candidate.totalCents,
              candidate.paidCents,
              candidate.paymentStatus,
              candidate.fulfillmentStatus,
              candidate.lastStreamVersion,
              currentRow.row_version,
              event.streamVersion - 1,
            ],
          );
          if (updateResult.rowCount !== 1) {
            throw new Error("Projection row compare-and-swap affected an unexpected row count");
          }
        }

        processedGlobalPositions.push(eventRow.global_position);
      }

      const checkpointAfter = processedGlobalPositions.at(-1) ?? checkpoint.last_global_position;
      if (processedGlobalPositions.length > 0) {
        await client.query(
          `UPDATE projection_checkpoints
           SET last_global_position = $2::bigint, updated_at = clock_timestamp()
           WHERE projection_name = $1`,
          [this.projectionName, checkpointAfter],
        );
      }

      await client.query("COMMIT");
      return {
        projectionName: this.projectionName,
        processedCount: processedGlobalPositions.length,
        checkpointBefore: checkpoint.last_global_position,
        checkpointAfter,
        processedGlobalPositions,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
