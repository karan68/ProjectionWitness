import { TrueForge } from "@truefoundry/trueforge-sdk";
import { z } from "zod";
import { verifyTrueForgeReadSmoke } from "./lib/trueforge-agent.js";
import { collectPersistedTurnEvents } from "./lib/trueforge-turn.js";

function environmentVariable(name: string): string | undefined {
  return process.env[name];
}

const sessionId = z.string().min(1).max(256).parse(process.argv[2]);
const turnId = z.string().min(1).max(256).parse(process.argv[3]);
const orderId = z.string().trim().min(1).max(128).parse(process.argv[4]);
const client = new TrueForge({
  baseUrl: environmentVariable("TRUEFORGE_BASE_URL") ?? "http://127.0.0.1:8790",
});
const events = await collectPersistedTurnEvents(
  await client.sessions.listTurnEvents(sessionId, turnId, { limit: 100, order: "asc" }),
);
const verified = verifyTrueForgeReadSmoke(events, orderId);
console.log(
  JSON.stringify({
    event: "trueforge.read_smoke.verified",
    sessionId,
    turnId,
    persistedEventTypes: events.map((item) => (item as { type: string }).type),
    ...verified,
  }),
);
