import { ReadToolNames, WriteToolNames } from "@projection-witness/mcp";
import { createRequire } from "node:module";

interface SmokeClient {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  close(): Promise<void>;
}

interface SmokeClientConstructor {
  new (identity: { name: string; version: string }): SmokeClient;
}

interface HttpClientTransportConstructor {
  new (url: URL): unknown;
}

const require = createRequire(import.meta.url);
const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as {
  Client: SmokeClientConstructor;
};
const { StreamableHTTPClientTransport } =
  require("@modelcontextprotocol/sdk/client/streamableHttp.js") as {
    StreamableHTTPClientTransport: HttpClientTransportConstructor;
  };

function environmentVariable(name: string): string | undefined {
  return process.env[name];
}

async function listTools(url: string): Promise<string[]> {
  const client = new Client({ name: "projection-witness-http-smoke", version: "0.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

const readUrl = environmentVariable("MCP_READ_URL") ?? "http://127.0.0.1:8781/mcp";
const writeUrl = environmentVariable("MCP_WRITE_URL") ?? "http://127.0.0.1:8782/mcp";
const readTools = await listTools(readUrl);
const writeTools = await listTools(writeUrl);
if (JSON.stringify(readTools) !== JSON.stringify(ReadToolNames)) {
  throw new Error("Read MCP tool surface does not match the contract");
}
if (JSON.stringify(writeTools) !== JSON.stringify(WriteToolNames)) {
  throw new Error("Write MCP tool surface does not match the contract");
}
console.log(JSON.stringify({ event: "mcp.smoke.passed", readTools, writeTools }));
