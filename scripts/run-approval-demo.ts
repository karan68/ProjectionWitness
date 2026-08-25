import { PreparedProjectionRepairDemoFileSchema } from "@projection-witness/demo-driver";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  collectPersistedTurnEvents,
  startTurn,
  writeTurnCheckpoint,
} from "./lib/trueforge-turn.js";
import { verifyApplyApprovalBinding } from "./lib/trueforge-agent.js";

function environmentVariable(name: string): string | undefined {
  return process.env[name];
}

const planPathInput = process.argv[2];
if (planPathInput === undefined) {
  throw new Error("Usage: npm run demo:request-approval -- <prepared-demo-plan.json>");
}
const planPath = resolve(planPathInput);
const planStats = await stat(planPath);
if (!planStats.isFile() || planStats.size > 131_072) {
  throw new Error("Prepared demo plan must be a file no larger than 131072 bytes");
}
const prepared = PreparedProjectionRepairDemoFileSchema.parse(
  JSON.parse(await readFile(planPath, "utf8")),
);
const checkpointPath = resolve(
  environmentVariable("TRUEFORGE_CHECKPOINT_PATH") ??
    `.projection-witness/approval-${prepared.approval.planId}.json`,
);
const client = new TrueForge({
  baseUrl: environmentVariable("TRUEFORGE_BASE_URL") ?? "http://127.0.0.1:8790",
});
let activeSessionId = "";
let activeTurnId = "";
const prompt = `This is the controlled local Projection Witness approval demo. The repository's trusted preparation command executed the approved reducer and staged this immutable plan. First call verify_projection_repair with only this plan ID: ${prepared.approval.planId}. If its status is PREPARED, present the exact summary and then call apply_projection_repair directly once with the exact JSON below. Do not change, omit, or add any argument. Do not use Code Mode or a subagent for apply. Stop for native human approval when TrueForge requests it.\n\nSummary:\n${JSON.stringify(prepared.summary)}\n\nExact apply arguments:\n${JSON.stringify(prepared.approval)}`;

async function reportEvent(event: { type: string }) {
  if (event.type === "tool.approval_required") {
    const persisted = await collectPersistedTurnEvents(
      await client.sessions.listTurnEvents(activeSessionId, activeTurnId, {
        limit: 100,
        order: "asc",
      }),
    );
    const binding = verifyApplyApprovalBinding(persisted, event);
    console.log(JSON.stringify({ event: event.type, ...binding }));
    return;
  }
  console.log(JSON.stringify({ event: event.type }));
}

const checkpoint = await startTurn(
  client,
  environmentVariable("TRUEFORGE_AGENT_NAME") ?? "projection-witness",
  prompt,
  async (next) => {
    activeSessionId = next.sessionId;
    activeTurnId = next.turnId;
    await writeTurnCheckpoint(checkpointPath, next);
  },
  reportEvent,
);
console.log(
  JSON.stringify({
    event: "demo.approval_turn_observed",
    checkpointPath,
    ...checkpoint,
  }),
);
