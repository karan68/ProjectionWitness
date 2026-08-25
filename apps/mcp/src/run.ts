import { createDatabasePool } from "@projection-witness/database";
import { ProjectionRepairService } from "@projection-witness/repair";
import express, { type Request, type Response } from "express";
import { createRequire } from "node:module";
import { z } from "zod";
import { createReadMcpServer, createWriteMcpServer } from "./servers.js";
import { ProjectionWitnessTools } from "./tools.js";

interface NodeStreamableTransport {
  close: () => Promise<void>;
  handleRequest: (request: Request, response: Response, body?: unknown) => Promise<void>;
}

interface NodeStreamableTransportConstructor {
  new (options: { sessionIdGenerator: (() => string) | undefined }): NodeStreamableTransport;
}

const require = createRequire(import.meta.url);
const { StreamableHTTPServerTransport } =
  require("@modelcontextprotocol/sdk/server/streamableHttp.js") as {
    StreamableHTTPServerTransport: NodeStreamableTransportConstructor;
  };

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function port(name: string, fallback: number): number {
  return z.coerce
    .number()
    .int()
    .min(1)
    .max(65_535)
    .parse(process.env[name] ?? fallback);
}

const readPool = createDatabasePool({
  databaseUrl: requiredEnvironmentVariable("DATABASE_URL_MCP_READ"),
  applicationName: "projection-witness-mcp-read",
});
const stagePool = createDatabasePool({
  databaseUrl: requiredEnvironmentVariable("DATABASE_URL_MCP_WRITE"),
  applicationName: "projection-witness-mcp-stage",
});
const executorPool = createDatabasePool({
  databaseUrl: requiredEnvironmentVariable("DATABASE_URL_REPAIR_EXECUTOR"),
  applicationName: "projection-witness-repair-executor",
});
const repairService = new ProjectionRepairService(stagePool, {
  executorPool,
  reducerArtifactPath: requiredEnvironmentVariable("REDUCER_BUNDLE_PATH"),
});
const tools = new ProjectionWitnessTools({
  readPool,
  repairService,
  apiBaseUrl: requiredEnvironmentVariable("API_BASE_URL"),
});

async function startConnector(
  connectorPort: number,
  serverFactory: () => ReturnType<typeof createReadMcpServer>,
) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((request, response, next) => {
    const hostname = request.hostname.toLowerCase();
    if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
      response.status(403).json({ error: "Invalid Host header" });
      return;
    }
    next();
  });
  app.post("/mcp", async (request: Request, response: Response) => {
    const mcpServer = serverFactory();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcpServer.connect(transport as unknown as Parameters<typeof mcpServer.connect>[0]);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "mcp.transport.error",
          message: error instanceof Error ? error.message : "Unknown transport error",
        }),
      );
      if (!response.headersSent) {
        response.status(500).json({ error: "MCP transport failed" });
      }
    } finally {
      response.once("close", () => {
        void transport.close();
        void mcpServer.close();
      });
    }
  });
  app.all("/mcp", (_request, response) => {
    response.status(405).json({ error: "Method not allowed" });
  });
  const httpServer = app.listen(connectorPort, "127.0.0.1");
  return { httpServer };
}

const read = await startConnector(port("MCP_READ_PORT", 8781), () => createReadMcpServer(tools));
const write = await startConnector(port("MCP_WRITE_PORT", 8782), () => createWriteMcpServer(tools));
const abortController = new AbortController();
process.once("SIGINT", () => abortController.abort());
process.once("SIGTERM", () => abortController.abort());
console.log(
  JSON.stringify({
    event: "mcp.connectors.ready",
    readUrl: "http://127.0.0.1:8781/mcp",
    writeUrl: "http://127.0.0.1:8782/mcp",
  }),
);

await new Promise<void>((resolvePromise) => {
  abortController.signal.addEventListener("abort", () => resolvePromise(), { once: true });
});
for (const connector of [read, write]) {
  connector.httpServer.close();
}
await Promise.all([readPool.end(), stagePool.end(), executorPool.end()]);
