import { TrueForge } from "@truefoundry/trueforge-sdk";
import { z } from "zod";
import { collectPersistedSessionEvents } from "./lib/verify-trueforge-reducer-evidence.js";
import { verifyTrueForgeApprovedRepair } from "./lib/trueforge-agent.js";

function environmentVariable(name: string): string | undefined {
  return process.env[name];
}

const sessionId = z.string().min(1).max(256).parse(process.argv[2]);
const planId = z.uuid().parse(process.argv[3]);
const streamId = z.string().trim().min(1).max(128).parse(process.argv[4]);
const toolCallId = z.string().min(1).max(256).parse(process.argv[5]);
const receiptSha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .parse(process.argv[6]);
const client = new TrueForge({
  baseUrl: environmentVariable("TRUEFORGE_BASE_URL") ?? "http://127.0.0.1:8790",
});
const events = await collectPersistedSessionEvents(await client.sessions.listEvents(sessionId));
const verified = verifyTrueForgeApprovedRepair(events, {
  planId,
  streamId,
  toolCallId,
  receiptSha256,
});
console.log(
  JSON.stringify({
    event: "trueforge.approved_repair.verified",
    sessionId,
    planId,
    streamId,
    toolCallId,
    auditId: verified.receipt.auditId,
    receiptSha256: verified.receipt.receiptSha256,
    persistedEventCount: events.length,
  }),
);
