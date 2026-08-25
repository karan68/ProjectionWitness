import { ProjectionWitnessTools } from "@projection-witness/mcp";
import type { ProjectionRepairService } from "@projection-witness/repair";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

function tools() {
  return new ProjectionWitnessTools({
    readPool: {} as Pool,
    repairService: {} as ProjectionRepairService,
    apiBaseUrl: "http://127.0.0.1:3000",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP public API boundary", () => {
  it("returns a bounded JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"orderId":"ORD-1"}', { status: 200 })),
    );

    await expect(tools().getPublicOrderState({ orderId: "ORD-1" })).resolves.toEqual({
      statusCode: 200,
      body: { orderId: "ORD-1" },
    });
  });

  it("refuses oversized declared and streamed responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("{}", { headers: { "content-length": String(1_048_576 + 1) } }),
      ),
    );
    await expect(tools().getPublicOrderState({ orderId: "ORD-1" })).rejects.toThrow(/byte limit/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1_048_576 + 1));
            controller.close();
          },
        });
        return new Response(body);
      }),
    );
    await expect(tools().getPublicOrderState({ orderId: "ORD-1" })).rejects.toThrow(/byte limit/);
  });

  it("maps malformed JSON to a stable verification failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json")),
    );

    await expect(tools().getPublicOrderState({ orderId: "ORD-1" })).rejects.toMatchObject({
      code: "VERIFICATION_FAILED",
      message: "Public API returned invalid JSON",
    });
  });
});
