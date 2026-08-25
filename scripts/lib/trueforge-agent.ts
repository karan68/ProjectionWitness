import { ApplyProjectionRepairInputSchema } from "@projection-witness/repair";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const ResourceNameSchema = z.string().trim().min(1).max(128);
const HttpUrlSchema = z
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
    message: "MCP URL must use HTTP or HTTPS",
  })
  .refine((value) => {
    const url = new URL(value);
    return url.username === "" && url.password === "" && url.hash === "";
  }, "MCP URL must not contain credentials or a fragment");
const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

const AgentManifestSchema = z
  .object({
    model: z
      .object({
        name: z.string().trim().min(1).max(256),
        params: z
          .object({
            temperature: z.number().min(0).max(2),
            parallelToolCalls: z.literal(true),
          })
          .passthrough(),
      })
      .strict(),
    instructions: z.string().min(1).max(32_768),
    mcpServers: z
      .array(
        z
          .object({
            name: ResourceNameSchema,
            enableTools: z.array(z.string().min(1).max(256)).max(64),
            requireApprovalForTools: z.array(z.string().min(1).max(256)).max(64),
            preload: z.literal(true),
          })
          .strict(),
      )
      .length(2),
    skills: z.array(z.object({ name: ResourceNameSchema }).strict()).length(1),
    config: z
      .object({
        sandbox: z.object({ enabled: z.literal(true), fileDownloads: z.literal(true) }).strict(),
        generativeUi: z.object({ enabled: z.literal(true) }).strict(),
        askUserQuestions: z.object({ enabled: z.literal(true) }).strict(),
        dynamicSubAgents: z.object({ enabled: z.literal(true) }).strict(),
        iterationLimit: z.number().int().min(1).max(1_024),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const read = manifest.mcpServers.find((server) => server.name === "projection-witness-read");
    const write = manifest.mcpServers.find((server) => server.name === "projection-witness-write");
    if (
      read === undefined ||
      read.enableTools.length !== 1 ||
      read.enableTools[0] !== "@all" ||
      read.requireApprovalForTools.length !== 0
    ) {
      context.addIssue({ code: "custom", message: "Read connector policy is invalid" });
    }
    if (
      write === undefined ||
      write.enableTools.length !== 1 ||
      write.enableTools[0] !== "apply_projection_repair" ||
      write.requireApprovalForTools.length !== 1 ||
      write.requireApprovalForTools[0] !== "apply_projection_repair"
    ) {
      context.addIssue({ code: "custom", message: "Write connector approval policy is invalid" });
    }
    if (manifest.skills[0]?.name !== "projection-repair") {
      context.addIssue({ code: "custom", message: "Projection repair skill is required" });
    }
  });

export type ProjectionWitnessAgentManifest = z.infer<typeof AgentManifestSchema>;

interface AgentRecord {
  id: string;
  name: string;
}

interface TrueForgeAdminClient {
  agents: {
    list(): Promise<{ data: AgentRecord[] }>;
    create(request: {
      name: string;
      manifest: ProjectionWitnessAgentManifest;
    }): Promise<{ data: AgentRecord }>;
    update(
      agentId: string,
      request: { manifest: ProjectionWitnessAgentManifest },
    ): Promise<{ data: AgentRecord }>;
  };
  mcpServers: {
    listTools(name: string): Promise<{ data: Record<string, unknown>[] }>;
  };
  settings: {
    mcpServers: {
      createOrUpdate(request: {
        manifest: {
          name: string;
          description: string;
          type: "remote";
          url: string;
        };
      }): Promise<unknown>;
    };
    skills: {
      createOrUpdate(request: {
        manifest: {
          name: string;
          description: string;
          type: "git";
          url: string;
          ref: string;
          path: string;
        };
      }): Promise<unknown>;
    };
  };
}

export interface RegisterProjectionWitnessAgentOptions {
  agentName: string;
  manifest: ProjectionWitnessAgentManifest;
  modelName?: string;
  readMcpUrl: string;
  writeMcpUrl: string;
  repositoryUrl: string;
  repositoryCommitSha: string;
}

const ToolListSchema = z
  .array(z.object({ name: z.string().min(1).max(256) }).passthrough())
  .max(64);
const ExpectedReadTools = [
  "find_projection_case",
  "get_public_order_state",
  "inspect_projection_case",
  "snapshot_event_stream",
  "get_projection_runtime",
  "stage_projection_repair",
  "verify_projection_repair",
] as const;
const ExpectedWriteTools = ["apply_projection_repair"] as const;

function assertToolList(input: unknown, expected: readonly string[], connectorName: string): void {
  const names = ToolListSchema.parse(input).map((tool) => tool.name);
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`${connectorName} MCP tool surface does not match the agent contract`);
  }
}

export async function loadProjectionWitnessAgentManifest(
  manifestPath: string,
): Promise<ProjectionWitnessAgentManifest> {
  const stats = await import("node:fs/promises").then(({ stat }) => stat(manifestPath));
  if (!stats.isFile() || stats.size > 65_536) {
    throw new Error("TrueForge agent manifest must be a file no larger than 65536 bytes");
  }
  return AgentManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
}

export async function registerProjectionWitnessAgent(
  client: TrueForgeAdminClient,
  input: RegisterProjectionWitnessAgentOptions,
) {
  const options = z
    .object({
      agentName: ResourceNameSchema,
      manifest: AgentManifestSchema,
      modelName: z.string().trim().min(1).max(256).optional(),
      readMcpUrl: HttpUrlSchema,
      writeMcpUrl: HttpUrlSchema,
      repositoryUrl: z.url().refine((value) => new URL(value).protocol === "https:"),
      repositoryCommitSha: CommitShaSchema,
    })
    .strict()
    .parse(input);
  const manifest = AgentManifestSchema.parse({
    ...options.manifest,
    model: {
      ...options.manifest.model,
      name: options.modelName ?? options.manifest.model.name,
    },
  });

  await Promise.all([
    client.settings.mcpServers.createOrUpdate({
      manifest: {
        name: "projection-witness-read",
        description: "Bounded Projection Witness investigation, staging, and verification tools.",
        type: "remote",
        url: options.readMcpUrl,
      },
    }),
    client.settings.mcpServers.createOrUpdate({
      manifest: {
        name: "projection-witness-write",
        description: "Approval-gated one-row Projection Witness repair apply tool.",
        type: "remote",
        url: options.writeMcpUrl,
      },
    }),
    client.settings.skills.createOrUpdate({
      manifest: {
        name: "projection-repair",
        description: "Build reducer-derived proof for one bounded order projection repair.",
        type: "git",
        url: options.repositoryUrl,
        ref: options.repositoryCommitSha,
        path: "skills/projection-repair",
      },
    }),
  ]);

  const [readTools, writeTools] = await Promise.all([
    client.mcpServers.listTools("projection-witness-read"),
    client.mcpServers.listTools("projection-witness-write"),
  ]);
  assertToolList(readTools.data, ExpectedReadTools, "Read");
  assertToolList(writeTools.data, ExpectedWriteTools, "Write");

  const existing = (await client.agents.list()).data.find(
    (agent) => agent.name === options.agentName,
  );
  if (existing === undefined) {
    const created = await client.agents.create({ name: options.agentName, manifest });
    return { action: "created" as const, agentId: created.data.id, manifest };
  }
  const updated = await client.agents.update(existing.id, { manifest });
  return { action: "updated" as const, agentId: updated.data.id, manifest };
}

const ApprovalRequiredSchema = z
  .object({
    type: z.literal("tool.approval_required"),
    threadId: z.string().min(1).max(256),
    toolCalls: z
      .array(
        z
          .object({ id: z.string().min(1).max(256), sourceEventId: z.string().min(1).max(256) })
          .strict(),
      )
      .length(1),
  })
  .passthrough();

export function verifyApplyApprovalBinding(events: readonly unknown[], approvalInput: unknown) {
  const approval = ApprovalRequiredSchema.parse(approvalInput);
  const reference = approval.toolCalls[0];
  if (reference === undefined) {
    throw new Error("Approval event does not reference a tool call");
  }
  const source = events.find((event) => {
    const record = z.object({ id: z.string().optional() }).passthrough().safeParse(event);
    return record.success && record.data.id === reference.sourceEventId;
  });
  const message = z
    .object({
      type: z.literal("model.message"),
      threadId: z.string().min(1),
      toolCalls: z.array(z.unknown()).max(64),
    })
    .passthrough()
    .parse(source);
  if (message.threadId !== approval.threadId) {
    throw new Error("Approval and tool call thread identifiers do not match");
  }
  const call = message.toolCalls
    .map((toolCall) =>
      z
        .object({
          id: z.string().min(1).max(256),
          function: z
            .object({ arguments: z.string().max(131_072), name: z.string().min(1).max(512) })
            .strict(),
          toolInfo: z
            .object({
              type: z.literal("mcp"),
              serverName: z.literal("projection-witness-write"),
              name: z.literal("apply_projection_repair"),
            })
            .passthrough(),
        })
        .passthrough()
        .parse(toolCall),
    )
    .find((toolCall) => toolCall.id === reference.id);
  if (call === undefined) {
    throw new Error("Approval does not reference the expected write MCP tool call");
  }
  return {
    threadId: approval.threadId,
    toolCallId: call.id,
    arguments: ApplyProjectionRepairInputSchema.parse(JSON.parse(call.function.arguments)),
  };
}
