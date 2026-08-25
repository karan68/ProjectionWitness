import { buildOrderApi } from "@projection-witness/api";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

interface FakeQueryResult {
  rows: unknown[];
}

function poolWithQuery(query: (queryText: string) => Promise<FakeQueryResult>): Pool {
  return { query } as unknown as Pool;
}

describe("Order API safety surface", () => {
  it("redacts unexpected internal errors", async () => {
    const pool = poolWithQuery(async () => {
      throw new Error("sensitive database schema detail");
    });
    const app = buildOrderApi(pool);
    try {
      const response = await app.inject({ method: "GET", url: "/orders/ORD-1042" });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        code: "INTERNAL_ERROR",
        message: "The request could not be completed",
      });
      expect(response.body).not.toContain("sensitive database schema detail");
    } finally {
      await app.close();
    }
  });

  it("reports unattested readiness and metadata without inventing runtime identity", async () => {
    const pool = poolWithQuery(async (query: string) => {
      if (query.includes("to_regclass")) {
        return { rows: [{ exists: false }] };
      }
      return { rows: [{ "?column?": 1 }] };
    });
    const app = buildOrderApi(pool);
    try {
      const readiness = await app.inject({ method: "GET", url: "/readyz" });
      const metadata = await app.inject({ method: "GET", url: "/meta" });

      expect(readiness.statusCode).toBe(503);
      expect(readiness.json()).toEqual({ ready: false, code: "RUNTIME_UNATTESTED" });
      expect(metadata.statusCode).toBe(503);
      expect(metadata.json()).toEqual({ code: "RUNTIME_UNATTESTED" });
    } finally {
      await app.close();
    }
  });
});
