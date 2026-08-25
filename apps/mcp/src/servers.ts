import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import {
  ApplyOutputSchema,
  ApplyRepairInputSchema,
  FindCaseOutputSchema,
  InspectCaseOutputSchema,
  OrderCaseInputSchema,
  ProjectionCaseInputSchema,
  PublicStateOutputSchema,
  RuntimeInputSchema,
  RuntimeOutputSchema,
  SnapshotOutputSchema,
  SnapshotStreamInputSchema,
  StageOutputSchema,
  StageRepairInputSchema,
  VerifyOutputSchema,
  VerifyRepairInputSchema,
} from "./schemas.js";
import { type ProjectionWitnessTools, redactedToolError } from "./tools.js";

export const ReadToolNames = [
  "find_projection_case",
  "get_public_order_state",
  "inspect_projection_case",
  "snapshot_event_stream",
  "get_projection_runtime",
  "stage_projection_repair",
  "verify_projection_repair",
] as const;

export const WriteToolNames = ["apply_projection_repair"] as const;

const ReadOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function success(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function failure(error: unknown): CallToolResult {
  const redacted = redactedToolError(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(redacted) }],
  };
}

function safeHandler<Input, Output extends Record<string, unknown>>(
  handler: (input: Input) => Promise<Output>,
) {
  return async (input: Input): Promise<CallToolResult> => {
    try {
      return success(await handler(input));
    } catch (error) {
      return failure(error);
    }
  };
}

export function createReadMcpServer(tools: ProjectionWitnessTools): McpServer {
  const server = new McpServer({ name: "projection-witness-read", version: "0.0.0" });
  server.registerTool(
    "find_projection_case",
    {
      description: "Resolve an exact order projection case without fuzzy matching.",
      inputSchema: OrderCaseInputSchema,
      outputSchema: FindCaseOutputSchema,
      annotations: ReadOnlyAnnotations,
    },
    safeHandler((input: z.infer<typeof OrderCaseInputSchema>) => tools.findProjectionCase(input)),
  );
  server.registerTool(
    "get_public_order_state",
    {
      description: "Read the customer-visible order API state.",
      inputSchema: OrderCaseInputSchema,
      outputSchema: PublicStateOutputSchema,
      annotations: { ...ReadOnlyAnnotations, openWorldHint: true },
    },
    safeHandler((input: z.infer<typeof OrderCaseInputSchema>) => tools.getPublicOrderState(input)),
  );
  server.registerTool(
    "inspect_projection_case",
    {
      description: "Read the projection row, checkpoint, and bounded tracked gaps.",
      inputSchema: ProjectionCaseInputSchema,
      outputSchema: InspectCaseOutputSchema,
      annotations: ReadOnlyAnnotations,
    },
    safeHandler((input: z.infer<typeof ProjectionCaseInputSchema>) =>
      tools.inspectProjectionCase(input),
    ),
  );
  server.registerTool(
    "snapshot_event_stream",
    {
      description: "Return bounded canonical events and stream fingerprint evidence.",
      inputSchema: SnapshotStreamInputSchema,
      outputSchema: SnapshotOutputSchema,
      annotations: ReadOnlyAnnotations,
    },
    safeHandler((input: z.infer<typeof SnapshotStreamInputSchema>) =>
      tools.snapshotEventStream(input),
    ),
  );
  server.registerTool(
    "get_projection_runtime",
    {
      description: "Return the deployed projector runtime attestation.",
      inputSchema: RuntimeInputSchema,
      outputSchema: RuntimeOutputSchema,
      annotations: ReadOnlyAnnotations,
    },
    safeHandler((input: z.infer<typeof RuntimeInputSchema>) => tools.getProjectionRuntime(input)),
  );
  server.registerTool(
    "stage_projection_repair",
    {
      description: "Revalidate and persist an immutable repair plan without applying it.",
      inputSchema: StageRepairInputSchema,
      outputSchema: StageOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safeHandler((input: z.infer<typeof StageRepairInputSchema>) =>
      tools.stageProjectionRepair(input),
    ),
  );
  server.registerTool(
    "verify_projection_repair",
    {
      description: "Verify plan, audit, row, and public API state after repair.",
      inputSchema: VerifyRepairInputSchema,
      outputSchema: VerifyOutputSchema,
      annotations: { ...ReadOnlyAnnotations, openWorldHint: true },
    },
    safeHandler((input: z.infer<typeof VerifyRepairInputSchema>) =>
      tools.verifyProjectionRepair(input),
    ),
  );
  return server;
}

export function createWriteMcpServer(tools: ProjectionWitnessTools): McpServer {
  const server = new McpServer({ name: "projection-witness-write", version: "0.0.0" });
  server.registerTool(
    "apply_projection_repair",
    {
      description: "Revalidate and atomically apply exactly one persisted projection repair plan.",
      inputSchema: ApplyRepairInputSchema,
      outputSchema: ApplyOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safeHandler((input: z.infer<typeof ApplyRepairInputSchema>) =>
      tools.applyProjectionRepair(input),
    ),
  );
  return server;
}
