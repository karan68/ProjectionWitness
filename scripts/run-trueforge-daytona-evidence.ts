import { TrueForge } from "@truefoundry/trueforge-sdk";
import { z } from "zod";
import {
  collectPersistedSessionEvents,
  verifyTrueForgeReducerEvidence,
} from "./lib/verify-trueforge-reducer-evidence.js";
import { buildTrueForgeDaytonaEvidenceCommand } from "./lib/trueforge-daytona-command.js";

const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

function environmentVariable(name: string): string | undefined {
  return process.env[name];
}

const commitSha = CommitShaSchema.parse(process.argv[2]);
const expectedReducerSha256 = Sha256Schema.parse(process.argv[3]);
const baseUrl = environmentVariable("TRUEFORGE_BASE_URL") ?? "http://127.0.0.1:8790";
const agentName = environmentVariable("TRUEFORGE_AGENT_NAME") ?? "projection-witness-smoke";
const client = new TrueForge({ baseUrl });
const agents = await client.agents.list();
if (!agents.data.some((agent) => agent.name === agentName)) {
  throw new Error(`TrueForge agent is not configured: ${agentName}`);
}

const command = buildTrueForgeDaytonaEvidenceCommand(commitSha, expectedReducerSha256);

const sessionResponse = await client.sessions.create({ agent: { name: agentName } });
const sessionId = sessionResponse.data.id;
const stream = await client.sessions.createTurnStream(
  sessionId,
  {
    input: [
      {
        type: "user.message",
        content: `Use the sandbox execution tool to run this exact shell command once. Do not alter, split, or simulate it.\n\n${command}`,
      },
    ],
    previousTurnId: "none",
  },
  { timeoutInSeconds: 900 },
);

for await (const event of stream) {
  if (event.type === "sandbox.created") {
    console.log(
      JSON.stringify({
        event: event.type,
        sessionId,
        sandboxId: event.sandboxId,
      }),
    );
  } else if (event.type === "tool.response") {
    console.log(JSON.stringify({ event: event.type, content: event.content }));
  } else if (event.type === "turn.done") {
    console.log(JSON.stringify({ event: event.type, status: event.state.status }));
  }
}

const persistedPage = await client.sessions.listEvents(sessionId);
const persistedEvents = await collectPersistedSessionEvents(persistedPage);
const verifiedResult = verifyTrueForgeReducerEvidence(persistedEvents, {
  command,
  reducerSha256: expectedReducerSha256,
  streamId: "ORD-DAYTONA-FIXTURE",
  streamSha256: "e574755a41608e81eca0cc7bc33412c96d35f39be51d30fd4f77ff963e5fe903",
  candidateSha256: "9c586ffed5924a0d8d5b7a517a633f0c264e6212b4fb995e00886cf102850fb2",
});

console.log(
  JSON.stringify({
    event: "trueforge.daytona.reducer_evidence.verified",
    sessionId,
    commitSha,
    reducerSha256: expectedReducerSha256,
    streamSha256: verifiedResult.stream.sha256,
    candidateSha256: verifiedResult.candidate.sha256,
    persistedEventTypes: persistedEvents.map(
      (event) =>
        z
          .object({ type: z.string().max(128) })
          .passthrough()
          .parse(event).type,
    ),
  }),
);
