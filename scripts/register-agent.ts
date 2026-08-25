import { TrueForge } from "@truefoundry/trueforge-sdk";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  loadProjectionWitnessAgentManifest,
  registerProjectionWitnessAgent,
} from "./lib/trueforge-agent.js";

function environmentVariable(name: string): string | undefined {
  return process.env[name];
}

function requiredEnvironmentVariable(name: string): string {
  const value = environmentVariable(name);
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

const commitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .parse(process.argv[2]);
const manifestPath = fileURLToPath(
  new URL("../agents/projection-witness.agent.json", import.meta.url),
);
const manifest = await loadProjectionWitnessAgentManifest(manifestPath);
const client = new TrueForge({
  baseUrl: environmentVariable("TRUEFORGE_BASE_URL") ?? "http://127.0.0.1:8790",
});
const modelName = environmentVariable("TRUEFORGE_MODEL_NAME");
const result = await registerProjectionWitnessAgent(client, {
  agentName: environmentVariable("TRUEFORGE_AGENT_NAME") ?? "projection-witness",
  manifest,
  ...(modelName === undefined ? {} : { modelName }),
  readMcpUrl: requiredEnvironmentVariable("TRUEFORGE_MCP_READ_URL"),
  writeMcpUrl: requiredEnvironmentVariable("TRUEFORGE_MCP_WRITE_URL"),
  repositoryUrl: "https://github.com/karan68/ProjectionWitness",
  repositoryCommitSha: commitSha,
});

console.log(
  JSON.stringify({
    event: "trueforge.agent.registered",
    action: result.action,
    agentId: result.agentId,
    agentName: environmentVariable("TRUEFORGE_AGENT_NAME") ?? "projection-witness",
    modelName: result.manifest.model.name,
    repositoryCommitSha: commitSha,
  }),
);
