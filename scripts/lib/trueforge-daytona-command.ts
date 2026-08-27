import { z } from "zod";

export const DaytonaNodeArchiveName = "node-v22.23.2-linux-x64.tar.gz";
export const DaytonaNodeArchiveSha256 =
  "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a";

const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const TimeoutSecondsSchema = z.number().int().positive().max(180);

export function buildBoundedNpmCiCommand(
  aggregateTimeoutSeconds = 80,
  attemptTimeoutSeconds = 35,
): string {
  const aggregateTimeout = TimeoutSecondsSchema.parse(aggregateTimeoutSeconds);
  const attemptTimeout = TimeoutSecondsSchema.parse(attemptTimeoutSeconds);
  if (attemptTimeout * 2 >= aggregateTimeout) {
    throw new Error("Aggregate npm timeout must leave time for two attempts and cleanup");
  }
  return `timeout ${aggregateTimeout}s sh -c 'for attempt in 1 2; do timeout ${attemptTimeout}s npm ci --include=dev --no-audit --no-fund --loglevel warn --fetch-retries 2 --fetch-retry-mintimeout 1000 --fetch-retry-maxtimeout 5000 --fetch-timeout 20000 && exit 0; rm -rf node_modules; done; exit 1'`;
}

export function buildTrueForgeDaytonaEvidenceCommand(
  commitShaInput: string,
  reducerSha256Input: string,
): string {
  const commitSha = CommitShaSchema.parse(commitShaInput);
  const reducerSha256 = Sha256Schema.parse(reducerSha256Input);
  return `set -euo pipefail
work=/tmp/projection-witness-evidence
rm -rf "$work"
mkdir -p "$work"
cd "$work"
timeout 15s curl --fail --show-error --location --retry 5 --retry-all-errors --connect-timeout 8 --max-time 8 --retry-max-time 13 \
  --output ${DaytonaNodeArchiveName} \
  https://nodejs.org/dist/v22.23.2/${DaytonaNodeArchiveName}
printf '%s  %s\n' '${DaytonaNodeArchiveSha256}' '${DaytonaNodeArchiveName}' | sha256sum -c -
tar -xzf ${DaytonaNodeArchiveName}
export PATH="$work/node-v22.23.2-linux-x64/bin:$PATH"
test "$(node --version)" = 'v22.23.2'
printf '%s\n' 'stage=node-bootstrap-ok'
timeout 15s npm install --global npm@10.9.9 --no-audit --no-fund
test "$(npm --version)" = '10.9.9'
printf '%s\n' 'stage=npm-bootstrap-ok'
timeout 15s curl --fail --show-error --location --retry 5 --retry-all-errors --connect-timeout 8 --max-time 8 --retry-max-time 13 \
  --output source.tar.gz \
  'https://codeload.github.com/karan68/ProjectionWitness/tar.gz/${commitSha}'
tar -xzf source.tar.gz
cd 'ProjectionWitness-${commitSha}'
${buildBoundedNpmCiCommand()}
printf '%s\n' 'stage=repository-install-ok'
timeout 10s npm run --silent build:reducer
artifact_path='artifacts/order-reducer.${reducerSha256}.cjs'
actual_digest="$(sha256sum "$artifact_path" | cut -d' ' -f1)"
test "$actual_digest" = '${reducerSha256}'
printf '%s\n' 'stage=reducer-digest-ok'
timeout 5s npm run --silent evidence:run-reducer -- "$artifact_path" tests/fixtures/reducer-evidence-input.json`;
}
