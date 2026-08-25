import { TrueForge } from "@truefoundry/trueforge-sdk";
import { resolve } from "node:path";
import { z } from "zod";
import { verifyApplyApprovalBinding } from "./lib/trueforge-agent.js";
import {
  collectPersistedTurnEvents,
  consumeTurnStream,
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
const session = await client.sessions.create({ agent: { name: agentName } });
const turn = await client.sessions.createTurn(session.data.id, {
  input: [{ type: "user.message", content: prompt }],
  previousTurnId: "none",
});
let checkpoint = {
  sessionId: session.data.id,
  turnId: turn.data.id,
  lastSequenceNumber: 0,
};
await writeTurnCheckpoint(checkpointPath, checkpoint);

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

const stream = await client.sessions.subscribeToTurn(checkpoint.sessionId, checkpoint.turnId, {
  afterSequenceNumber: checkpoint.lastSequenceNumber,
});
checkpoint = await consumeTurnStream(
  stream,
  checkpoint,
  async (next) => writeTurnCheckpoint(checkpointPath, next),
  reportEvent,
);
console.log(
  JSON.stringify({
    event: "trueforge.turn.observed",
    checkpointPath,
    ...checkpoint,
  }),
);
