import {
  loadProjectionWitnessAgentManifest,
  registerProjectionWitnessAgent,
  verifyApplyApprovalBinding,
  verifyTrueForgeReadSmoke,
} from "../../scripts/lib/trueforge-agent.js";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const manifestPath = fileURLToPath(
  new URL("../../agents/projection-witness.agent.json", import.meta.url),
);
const commitSha = "a".repeat(40);

function fakeClient(existingAgent = false) {
  const createOrUpdateMcp = vi.fn(async () => ({}));
  const createOrUpdateSkill = vi.fn(async () => ({}));
  const createAgent = vi.fn(async () => ({
    data: { id: "agent-created", name: "projection-witness" },
  }));
  const updateAgent = vi.fn(async () => ({
    data: { id: "agent-existing", name: "projection-witness" },
  }));
  return {
    client: {
      settings: {
        mcpServers: { createOrUpdate: createOrUpdateMcp },
        skills: { createOrUpdate: createOrUpdateSkill },
      },
      mcpServers: {
        listTools: vi.fn(async (name: string) => ({
          data:
            name === "projection-witness-read"
              ? [
                  "find_projection_case",
                  "get_public_order_state",
                  "inspect_projection_case",
                  "snapshot_event_stream",
                  "get_projection_runtime",
                  "stage_projection_repair",
                  "verify_projection_repair",
                ].map((toolName) => ({ name: toolName }))
              : [{ name: "apply_projection_repair" }],
        })),
      },
      agents: {
        list: vi.fn(async () => ({
          data: existingAgent ? [{ id: "agent-existing", name: "projection-witness" }] : [],
        })),
        create: createAgent,
        update: updateAgent,
      },
    },
    createOrUpdateMcp,
    createOrUpdateSkill,
    createAgent,
    updateAgent,
  };
}

describe("TrueForge saved-agent contract", () => {
  it("loads the exact connector, sandbox, subagent, and approval policy", async () => {
    const manifest = await loadProjectionWitnessAgentManifest(manifestPath);

    expect(manifest.config).toMatchObject({
      sandbox: { enabled: true, fileDownloads: true },
      dynamicSubAgents: { enabled: true },
      iterationLimit: 50,
    });
    expect(manifest.mcpServers).toEqual([
      {
        name: "projection-witness-read",
        enableTools: ["@all"],
        requireApprovalForTools: [],
        preload: true,
      },
      {
        name: "projection-witness-write",
        enableTools: ["apply_projection_repair"],
        requireApprovalForTools: ["apply_projection_repair"],
        preload: true,
      },
    ]);
  });

  it("upserts resources, verifies live tools, and creates or updates by immutable id", async () => {
    const manifest = await loadProjectionWitnessAgentManifest(manifestPath);
    const created = fakeClient();
    const createResult = await registerProjectionWitnessAgent(created.client, {
      agentName: "projection-witness",
      manifest,
      modelName: "google-gemini/gemini-3-1-pro-preview",
      readMcpUrl: "http://127.0.0.1:8781/mcp",
      writeMcpUrl: "http://127.0.0.1:8782/mcp",
      repositoryUrl: "https://github.com/karan68/ProjectionWitness",
      repositoryCommitSha: commitSha,
    });
    expect(createResult).toMatchObject({ action: "created", agentId: "agent-created" });
    expect(createResult.manifest.model.name).toBe("google-gemini/gemini-3-1-pro-preview");
    expect(created.createOrUpdateMcp).toHaveBeenCalledTimes(2);
    expect(created.createOrUpdateSkill).toHaveBeenCalledWith({
      manifest: expect.objectContaining({ ref: commitSha, path: "skills/projection-repair" }),
    });
    expect(created.createAgent).toHaveBeenCalledOnce();
    expect(created.updateAgent).not.toHaveBeenCalled();

    const updated = fakeClient(true);
    const updateResult = await registerProjectionWitnessAgent(updated.client, {
      agentName: "projection-witness",
      manifest,
      readMcpUrl: "http://127.0.0.1:8781/mcp",
      writeMcpUrl: "http://127.0.0.1:8782/mcp",
      repositoryUrl: "https://github.com/karan68/ProjectionWitness",
      repositoryCommitSha: commitSha,
    });
    expect(updateResult).toMatchObject({ action: "updated", agentId: "agent-existing" });
    expect(updated.updateAgent).toHaveBeenCalledWith(
      "agent-existing",
      expect.objectContaining({ manifest }),
    );
    expect(updated.createAgent).not.toHaveBeenCalled();
  });

  it("refuses to save an agent when a live connector tool surface drifts", async () => {
    const manifest = await loadProjectionWitnessAgentManifest(manifestPath);
    const harness = fakeClient();
    harness.client.mcpServers.listTools.mockImplementation(async () => ({ data: [] }));

    await expect(
      registerProjectionWitnessAgent(harness.client, {
        agentName: "projection-witness",
        manifest,
        readMcpUrl: "http://127.0.0.1:8781/mcp",
        writeMcpUrl: "http://127.0.0.1:8782/mcp",
        repositoryUrl: "https://github.com/karan68/ProjectionWitness",
        repositoryCommitSha: commitSha,
      }),
    ).rejects.toThrow(/tool surface/);
    expect(harness.createAgent).not.toHaveBeenCalled();
  });

  it("binds native approval to one exact write MCP call and validated arguments", () => {
    const planId = "018f47b2-7c6a-7ca4-b75a-4b748f41e001";
    const approvalArguments = {
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
      trueforgeToolCallId: "call-1",
    };
    const sourceEvent = {
      id: "event-1",
      type: "model.message",
      threadId: "main",
      toolCalls: [
        {
          id: "call-1",
          function: {
            name: "apply_projection_repair",
            arguments: JSON.stringify(approvalArguments),
          },
          toolInfo: {
            type: "mcp",
            serverId: "server-1",
            serverName: "projection-witness-write",
            name: "apply_projection_repair",
          },
        },
      ],
    };
    const approval = {
      id: "approval-1",
      type: "tool.approval_required",
      threadId: "main",
      toolCalls: [{ id: "call-1", sourceEventId: "event-1" }],
    };

    expect(verifyApplyApprovalBinding([sourceEvent], approval)).toEqual({
      threadId: "main",
      toolCallId: "call-1",
      arguments: approvalArguments,
    });
    expect(() =>
      verifyApplyApprovalBinding(
        [
          {
            ...sourceEvent,
            toolCalls: [
              {
                ...sourceEvent.toolCalls[0],
                toolInfo: {
                  type: "mcp",
                  serverName: "projection-witness-read",
                  name: "apply_projection_repair",
                },
              },
            ],
          },
        ],
        approval,
      ),
    ).toThrow();
  });

  it("verifies one persisted read smoke with both connectors and no approval", () => {
    const toolCall = {
      id: "call-1",
      function: {
        name: "find_projection_case",
        arguments: JSON.stringify({ orderId: "MISSING-TRUEFORGE-SMOKE" }),
      },
      toolInfo: {
        type: "mcp",
        serverId: "projection-witness-read",
        serverName: "projection-witness-read",
        name: "find_projection_case",
      },
    };
    const events = [
      {
        type: "mcp.initialize",
        mcpServers: [{ name: "projection-witness-read" }, { name: "projection-witness-write" }],
      },
      { type: "model.message", toolCalls: [toolCall] },
      {
        type: "tool.response",
        toolCallId: "call-1",
        content: JSON.stringify({
          found: false,
          streamExists: false,
          projectionExists: false,
        }),
      },
      { type: "model.message", content: "No repair was staged or applied." },
      { type: "turn.done", state: { status: "done", requiredActions: [] } },
    ];

    expect(verifyTrueForgeReadSmoke(events, "MISSING-TRUEFORGE-SMOKE")).toEqual({
      arguments: { orderId: "MISSING-TRUEFORGE-SMOKE" },
      result: { found: false, streamExists: false, projectionExists: false },
      toolCallId: "call-1",
    });
    expect(() =>
      verifyTrueForgeReadSmoke(
        [...events, { type: "tool.approval_required" }],
        "MISSING-TRUEFORGE-SMOKE",
      ),
    ).toThrow(/unexpectedly requested/);
  });
});
