import { TrueForge } from "@truefoundry/trueforge-sdk";
import { resolve } from "node:path";
import { z } from "zod";
import { verifyApplyApprovalBinding } from "./lib/trueforge-agent.js";
import {
  collectPersistedTurnEvents,
  startTurn,
  writeTurnCheckpoint,
} from "./lib/trueforge-turn.js";

function environmentVariable(name: string): string | undefined {
  return process.env[name];
}

const prompt = z.string().trim().min(1).max(16_384).parse(process.argv.slice(2).join(" "));
const baseUrl = environmentVariable("TRUEFORGE_BASE_URL") ?? "http://127.0.0.1:8790";
const agentName = environmentVariable("TRUEFORGE_AGENT_NAME") ?? "projection-witness";
const checkpointPath = resolve(
  environmentVariable("TRUEFORGE_CHECKPOINT_PATH") ?? ".projection-witness/turn.json",
);
const client = new TrueForge({ baseUrl });
let activeSessionId = "";
let activeTurnId = "";

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
  agentName,
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
    event: "trueforge.turn.observed",
    checkpointPath,
    ...checkpoint,
  }),
);
