import { z } from "zod";

export const DaytonaNodeArchiveName = "node-v22.23.2-linux-x64.tar.gz";
export const DaytonaNodeArchiveSha256 =
  "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a";

const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

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
timeout 20s curl --fail --show-error --location --retry 5 --retry-all-errors --connect-timeout 10 --max-time 10 --retry-max-time 18 \
  --output ${DaytonaNodeArchiveName} \
  https://nodejs.org/dist/v22.23.2/${DaytonaNodeArchiveName}
printf '%s  %s\n' '${DaytonaNodeArchiveSha256}' '${DaytonaNodeArchiveName}' | sha256sum -c -
tar -xzf ${DaytonaNodeArchiveName}
export PATH="$work/node-v22.23.2-linux-x64/bin:$PATH"
test "$(node --version)" = 'v22.23.2'
printf '%s\n' 'stage=node-bootstrap-ok'
timeout 25s npm install --global npm@10.9.9 --no-audit --no-fund
test "$(npm --version)" = '10.9.9'
printf '%s\n' 'stage=npm-bootstrap-ok'
timeout 20s curl --fail --show-error --location --retry 5 --retry-all-errors --connect-timeout 10 --max-time 10 --retry-max-time 18 \
  --output source.tar.gz \
  'https://codeload.github.com/karan68/ProjectionWitness/tar.gz/${commitSha}'
tar -xzf source.tar.gz
cd 'ProjectionWitness-${commitSha}'
timeout 55s npm ci --include=dev --no-audit --no-fund --silent
printf '%s\n' 'stage=repository-install-ok'
timeout 15s npm run --silent build:reducer
artifact_path='artifacts/order-reducer.${reducerSha256}.cjs'
actual_digest="$(sha256sum "$artifact_path" | cut -d' ' -f1)"
test "$actual_digest" = '${reducerSha256}'
printf '%s\n' 'stage=reducer-digest-ok'
timeout 10s npm run --silent evidence:run-reducer -- "$artifact_path" tests/fixtures/reducer-evidence-input.json`;
}
