import { TrueForge } from "@truefoundry/trueforge-sdk";
import { z } from "zod";
import { buildTrueForgeDaytonaEvidenceCommand } from "./lib/trueforge-daytona-command.js";
import {
  collectPersistedSessionEvents,
  verifyTrueForgeReducerEvidence,
} from "./lib/verify-trueforge-reducer-evidence.js";

const SessionIdSchema = z.string().regex(/^[0-9a-z]{26}$/);
const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const sessionId = SessionIdSchema.parse(process.argv[2]);
const commitSha = CommitShaSchema.parse(process.argv[3]);
const reducerSha256 = Sha256Schema.parse(process.argv[4]);
const { TRUEFORGE_BASE_URL: baseUrl = "http://127.0.0.1:8790" } = process.env;
const client = new TrueForge({
  baseUrl,
});
const persistedEvents = await collectPersistedSessionEvents(
  await client.sessions.listEvents(sessionId),
);
const result = verifyTrueForgeReducerEvidence(persistedEvents, {
  command: buildTrueForgeDaytonaEvidenceCommand(commitSha, reducerSha256),
  reducerSha256,
  streamId: "ORD-DAYTONA-FIXTURE",
  streamSha256: "e574755a41608e81eca0cc7bc33412c96d35f39be51d30fd4f77ff963e5fe903",
  candidateSha256: "9c586ffed5924a0d8d5b7a517a633f0c264e6212b4fb995e00886cf102850fb2",
});

console.log(
  JSON.stringify({
    event: "trueforge.daytona.reducer_evidence.verified",
    sessionId,
    commitSha,
    reducerSha256,
    streamSha256: result.stream.sha256,
    candidateSha256: result.candidate.sha256,
    reducerDeterministic: result.reducerDeterministic,
  }),
);
