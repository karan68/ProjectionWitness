import { ProjectionWitnessTools } from "@projection-witness/mcp";
import type { ProjectionRepairService } from "@projection-witness/repair";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

function tools(readPool: Pool = {} as Pool) {
  return new ProjectionWitnessTools({
    readPool,
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

  it("uses the persisted plan stream for row and public verification", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ status: "APPLIED", stream_id: "ORD-A" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: URL) =>
          new Response(JSON.stringify({ orderId: url.pathname.split("/").at(-1) })),
      ),
    );
    const planId = "018f47b2-7c6a-7ca4-b75a-4b748f41e001";

    await expect(
      tools({ query } as unknown as Pool).verifyProjectionRepair({ planId }),
    ).resolves.toEqual({
      planStatus: "APPLIED",
      auditReceiptSha256: null,
      rowMatchesAudit: null,
      publicStatusCode: 200,
    });
    expect(query.mock.calls[2]?.[1]).toEqual(["ORD-A"]);
    expect(fetch).toHaveBeenCalledWith(new URL("http://127.0.0.1:3000/orders/ORD-A"), {
      signal: expect.any(AbortSignal),
    });
    await expect(
      tools({ query } as unknown as Pool).verifyProjectionRepair({ planId, orderId: "ORD-B" }),
    ).rejects.toThrow();
  });
});
