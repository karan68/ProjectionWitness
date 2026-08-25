import {
  createReadMcpServer,
  createWriteMcpServer,
  ReadToolNames,
  WriteToolNames,
} from "@projection-witness/mcp";
import type { ProjectionWitnessTools } from "@projection-witness/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

async function connectedClient(server: ReturnType<typeof createReadMcpServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "projection-witness-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

const unreachableTools = new Proxy(
  {},
  {
    get() {
      return async () => {
        throw new Error("handler should not be reached");
      };
    },
  },
) as ProjectionWitnessTools;

describe("MCP connector contracts", () => {
  it("publishes exactly the seven read connector tools with safe annotations", async () => {
    const connection = await connectedClient(createReadMcpServer(unreachableTools));
    try {
      const listed = await connection.client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(ReadToolNames);
      for (const tool of listed.tools) {
        if (tool.name === "stage_projection_repair") {
          expect(tool.annotations).toMatchObject({
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
          });
        } else {
          expect(tool.annotations?.readOnlyHint).toBe(true);
          expect(tool.annotations?.destructiveHint).toBe(false);
        }
      }
    } finally {
      await connection.client.close();
      await connection.server.close();
    }
  });

  it("publishes only the destructive idempotent apply tool on the write connector", async () => {
    const connection = await connectedClient(createWriteMcpServer(unreachableTools));
    try {
      const listed = await connection.client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(WriteToolNames);
      expect(listed.tools[0]?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
      const invalid = await connection.client.callTool({
        name: "apply_projection_repair",
        arguments: {},
      });
      expect(invalid.isError).toBe(true);
    } finally {
      await connection.client.close();
      await connection.server.close();
    }
  });

  it("forwards the complete approved evidence binding through the write protocol", async () => {
    const planId = "018f47b2-7c6a-7ca4-b75a-4b748f41e001";
    const applyProjectionRepair = vi.fn(async () => ({
      status: "APPLIED" as const,
      planId,
      auditId: "018f47b2-7c6a-7ca4-b75a-4b748f41e002",
      receiptSha256: "f".repeat(64),
    }));
    const connection = await connectedClient(
      createWriteMcpServer({ applyProjectionRepair } as unknown as ProjectionWitnessTools),
    );
    const approval = {
      planId,
      projectionName: "orders",
      streamId: "ORD-1",
      streamSha256: "a".repeat(64),
      currentRowVersion: "1",
      currentRowSha256: "b".repeat(64),
      reducerSha256: "c".repeat(64),
      runtimeGeneration: "2",
      evidenceSha256: "d".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z",
      trueforgeSessionId: "session-1",
      trueforgeTurnId: "turn-1",
      trueforgeToolCallId: "tool-call-1",
    };
    try {
      const result = await connection.client.callTool({
        name: "apply_projection_repair",
        arguments: approval,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ status: "APPLIED", planId });
      expect(applyProjectionRepair).toHaveBeenCalledOnce();
      expect(applyProjectionRepair).toHaveBeenCalledWith(approval);
    } finally {
      await connection.client.close();
      await connection.server.close();
    }
  });
});
