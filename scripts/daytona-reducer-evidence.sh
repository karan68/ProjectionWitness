#!/bin/sh
set -eu

commit_sha="${1:-}"
reducer_sha256="${2:-}"
case "$commit_sha" in
  *[!0-9a-f]*|'') exit 2 ;;
esac
case "$reducer_sha256" in
  *[!0-9a-f]*|'') exit 2 ;;
esac
test "${#commit_sha}" -eq 40
test "${#reducer_sha256}" -eq 64

work=/tmp/projection-witness-evidence
node_archive=node-v22.23.2-linux-x64.tar.gz
rm -rf "$work"
mkdir -p "$work"
cd "$work"

timeout --kill-after=2s 12s curl --fail --show-error --location --retry 5 --retry-all-errors --connect-timeout 6 --max-time 6 --retry-max-time 10 \
  --output "$node_archive" \
  "https://nodejs.org/dist/v22.23.2/$node_archive"
printf '%s  %s\n' 'b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a' "$node_archive" | sha256sum -c -
tar -xzf "$node_archive"
export PATH="$work/node-v22.23.2-linux-x64/bin:$PATH"
test "$(node --version)" = 'v22.23.2'
printf '%s\n' 'stage=node-bootstrap-ok'

timeout --kill-after=2s 12s npm install --global npm@10.9.9 --no-audit --no-fund
test "$(npm --version)" = '10.9.9'
printf '%s\n' 'stage=npm-bootstrap-ok'

timeout --kill-after=2s 12s curl --fail --show-error --location --retry 5 --retry-all-errors --connect-timeout 6 --max-time 6 --retry-max-time 10 \
  --output source.tar.gz \
  "https://codeload.github.com/karan68/ProjectionWitness/tar.gz/$commit_sha"
tar -xzf source.tar.gz
cd "ProjectionWitness-$commit_sha"
timeout --kill-after=2s 75s sh -c 'for attempt in 1 2; do timeout --kill-after=2s 32s npm ci --include=dev --no-audit --no-fund --loglevel warn --fetch-retries 2 --fetch-retry-mintimeout 1000 --fetch-retry-maxtimeout 5000 --fetch-timeout 20000 && exit 0; rm -rf node_modules; done; exit 1'
printf '%s\n' 'stage=repository-install-ok'

timeout --kill-after=2s 8s npm run --silent build:reducer
artifact_path="artifacts/order-reducer.$reducer_sha256.cjs"
actual_digest="$(sha256sum "$artifact_path" | cut -d' ' -f1)"
test "$actual_digest" = "$reducer_sha256"
printf '%s\n' 'stage=reducer-digest-ok'
timeout --kill-after=1s 4s npm run --silent evidence:run-reducer -- "$artifact_path" tests/fixtures/reducer-evidence-input.json