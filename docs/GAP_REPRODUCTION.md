# Genuine Projection Gap Reproduction

Last verified: 2026-08-25

## What This Proves

The demo produces a wrong customer-facing order projection without directly updating the
projection row. The wrong state comes from a genuine cross-stream commit-order race:

1. Two order fixtures are appended and projected normally.
2. Payment transaction A inserts the target order event and allocates global position 3.
3. An injected test/demo gate pauses A after the real insert and stream-head compare-and-swap but
   before commit.
4. Unrelated transaction B inserts global position 4 and commits.
5. Naive projector v1 queries committed rows above checkpoint 2, sees only position 4, applies it,
   and advances the checkpoint to 4.
6. The gate releases transaction A, which commits position 3.
7. A later v1 query for positions above 4 returns no rows forever.

The API still reports `ORD-1042` as awaiting payment at stream version 1. Replaying its immutable
stream with the same reducer reports paid cents 12900, `PAID`, and stream version 2.

## Deterministic Coordination

The coordinator uses an injected `beforeCommit` function on the event-store instance used only
for transaction A. The function resolves a deferred "insert reached" promise, then awaits an
explicit release promise. The driver does not sleep, poll a control table, hold a global lock, or
expose a race-control HTTP endpoint.

Production API wiring does not provide the hook. It is available to tests and the guarded demo
driver through constructor injection.

## Ablation

The integration suite repeats the same event order without hiding position 3 from the projector.
When positions 3 and 4 are both committed before the poll, v1 processes both and the API reports
`PAID`. This isolates commit visibility plus checkpoint advancement as the cause; event schemas,
reducer logic, and direct row mutation are not the cause.

## Commands

The database reset refuses `NODE_ENV=production` and requires the exact confirmation token. The
reproducer requires `DEMO_MODE=true`, rejects URL query/fragment overrides, accepts only a
loopback PostgreSQL authority, and refuses any database that is not freshly initialized.

```powershell
$env:DEMO_MODE = "true"
$env:DATABASE_URL_MIGRATOR = "postgresql://pw_migrator:<local-password>@127.0.0.1:55432/projection_witness"
$env:CONFIRM_DATABASE_RESET = "projection-witness-local"
$env:POSTGRES_PORT = "55432"

& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run demo:reset
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run demo:reproduce-gap
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run demo:verify
```

Expected evidence fields after reproduction:

```json
{
  "pendingPaymentPosition": "3",
  "unrelatedCommittedPosition": "4",
  "checkpointPosition": "4",
  "customerState": {
    "paidCents": 0,
    "paymentStatus": "AWAITING_PAYMENT",
    "lastStreamVersion": 1
  },
  "replayedState": {
    "paidCents": 12900,
    "paymentStatus": "PAID",
    "lastStreamVersion": 2
  },
  "laterPollProcessedCount": 0
}
```

## Reset Boundary

Events reject row-level `UPDATE` and `DELETE`, and PR 3 contains no event-table `TRUNCATE` path.
The guarded local reset destroys and recreates the entire Docker Compose volume, then migrations
initialize a new event store and sequence. This operation is for the disposable loopback demo
database only; it is not exposed by the production API. Reproduction refuses to run unless every
event/projection table is empty and the sequence has never been called.

## Current Limits

- Projector v1 is intentionally unsafe and must not remain active before repair is enabled.
- The current API surface proves the customer-visible read only; domain-write endpoints follow in
  the API workflow PR.
- Gap-aware v2 and runtime attestation are implemented separately and documented in
  [GAP_AWARE_PROJECTOR.md](GAP_AWARE_PROJECTOR.md). They prevent future observed gaps but cannot
  infer the historical v1 gap created by this reproduction.
- MCP evidence, Daytona reducer proof, and repair are not part of this reproduction.