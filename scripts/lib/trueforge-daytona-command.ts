import { z } from "zod";

export const DaytonaNodeArchiveName = "node-v22.23.2-linux-x64.tar.gz";
export const DaytonaNodeArchiveSha256 =
  "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a";
export const DaytonaEvidenceScriptName = "daytona-reducer-evidence.sh";
export const DaytonaEvidenceScriptSha256 =
  "bf327e5203918199acf5a8e5d8320dfeb4d10a65616c4cfbed2bf55c68b30759";

const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const TimeoutSecondsSchema = z.number().int().positive().max(180);

export function buildBoundedNpmCiCommand(
  aggregateTimeoutSeconds = 75,
  attemptTimeoutSeconds = 32,
  killAfterSeconds = 2,
): string {
  const aggregateTimeout = TimeoutSecondsSchema.parse(aggregateTimeoutSeconds);
  const attemptTimeout = TimeoutSecondsSchema.parse(attemptTimeoutSeconds);
  const killAfter = TimeoutSecondsSchema.parse(killAfterSeconds);
  if ((attemptTimeout + killAfter) * 2 >= aggregateTimeout) {
    throw new Error("Aggregate npm timeout must leave time for two attempts and cleanup");
  }
  return `timeout --kill-after=${killAfter}s ${aggregateTimeout}s sh -c 'for attempt in 1 2; do timeout --kill-after=${killAfter}s ${attemptTimeout}s npm ci --include=dev --ignore-scripts --no-audit --no-fund --loglevel warn --fetch-retries 2 --fetch-retry-mintimeout 1000 --fetch-retry-maxtimeout 5000 --fetch-timeout 20000 && exit 0; rm -rf node_modules; done; exit 1'`;
}

export function buildTrueForgeDaytonaEvidenceCommand(
  commitShaInput: string,
  reducerSha256Input: string,
): string {
  const commitSha = CommitShaSchema.parse(commitShaInput);
  const reducerSha256 = Sha256Schema.parse(reducerSha256Input);
  return `set -euo pipefail; script=/tmp/${DaytonaEvidenceScriptName}; work=/tmp/projection-witness-evidence; timeout --kill-after=2s 12s curl --fail --show-error --location --retry 5 --retry-all-errors --connect-timeout 6 --max-time 6 --retry-max-time 10 --output "$script" 'https://raw.githubusercontent.com/karan68/ProjectionWitness/${commitSha}/scripts/${DaytonaEvidenceScriptName}'; echo '${DaytonaEvidenceScriptSha256}  /tmp/${DaytonaEvidenceScriptName}' | sha256sum -c -; status=0; timeout --kill-after=5s 155s sh "$script" '${commitSha}' '${reducerSha256}' || status=$?; rm -rf "$work" "$script"; exit "$status"`;
}
