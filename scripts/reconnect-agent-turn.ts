import { TrueForge } from "@truefoundry/trueforge-sdk";
import { resolve } from "node:path";
import { verifyApplyApprovalBinding } from "./lib/trueforge-agent.js";
import {
  collectPersistedTurnEvents,
  readTurnCheckpoint,
  reconnectTurn,
  writeTurnCheckpoint,
} from "./lib/trueforge-turn.js";

function environmentVariable(name: string): string | undefined {
  return process.env[name];
}

const checkpointPath = resolve(
  environmentVariable("TRUEFORGE_CHECKPOINT_PATH") ?? ".projection-witness/turn.json",
);
const checkpoint = await readTurnCheckpoint(checkpointPath);
const client = new TrueForge({
  baseUrl: environmentVariable("TRUEFORGE_BASE_URL") ?? "http://127.0.0.1:8790",
});

async function reportEvent(event: { type: string }) {
  if (event.type === "tool.approval_required") {
    const persisted = await collectPersistedTurnEvents(
      await client.sessions.listTurnEvents(checkpoint.sessionId, checkpoint.turnId, {
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

const result = await reconnectTurn(
  client,
  checkpoint,
  async (next) => writeTurnCheckpoint(checkpointPath, next),
  reportEvent,
);
if (result.mode === "persisted") {
  for (const event of result.events) {
    console.log(JSON.stringify({ event: (event as { type: string }).type, source: "persisted" }));
  }
}
console.log(
  JSON.stringify({
    event: "trueforge.turn.reconnected",
    mode: result.mode,
    checkpointPath,
    ...result.checkpoint,
  }),
);
