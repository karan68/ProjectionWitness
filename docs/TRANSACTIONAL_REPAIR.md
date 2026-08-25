# Transactional Projection Repair

Last verified: 2026-08-25

## Scope

`@projection-witness/repair` stages an immutable version-1 evidence envelope and applies exactly
one order projection repair through fixed, parameterized SQL. It accepts no SQL, table name, column
name, or model-authored candidate. MCP transport and native TrueForge approval are not part of this
package; they will call this typed boundary in later PRs.

## Plan Staging

`stageRepairPlan` first requires canonical millisecond-UTC timestamps and safe-integer decimal
cents. In a repeatable-read transaction it reloads the live runtime, bounded stream, and current
row, runs the approved reducer artifact, and requires every resulting digest to equal the envelope
before insertion. A structurally valid or self-hashed caller-authored candidate is therefore not
stageable. The database stores stream, runtime, current-row, candidate, expiry, and envelope
digests as immutable columns and independently constrains plan cents to the safe-integer range.
Staging the same `evidenceSha256` is idempotent and returns the existing plan. A trigger permits no
evidence changes and allows `PREPARED -> APPLIED` only when the same transaction has already
inserted the plan's audit row.

## Apply Transaction

`applyRepairPlan` validates approval fields against the locked persisted plan, then takes locks in
this order:

1. Repair plan row.
2. Runtime manifest row.
3. Event stream head row.
4. Projection row.

While those locks are held, it:

- Checks database time against plan expiry.
- Requires the known gap-aware runtime and exact generation/source/reducer identity.
- Reads and fingerprints the bounded immutable stream.
- Fingerprints the current row without volatile timestamps.
- Executes only the reducer digest approved by the projector build, twice from fresh modules, in a
  resource-limited worker with a hard deadline.
- Compares live stream, runtime, row, and candidate evidence with the plan.
- Performs a one-row `row_version` compare-and-swap.
- Inserts one append-only audit receipt.
- Marks the plan applied.

The row update, audit insert, and plan completion commit together. Any exception rolls the entire
transaction back.

Event count and raw serialized bytes are checked in PostgreSQL over at most `maxEvents + 1` rows
before event payloads are returned to Node. Canonical byte limits are then enforced again by the
evidence package. Repeated apply checks the stored audit immediately after locking the plan and can
return `ALREADY_APPLIED` without waiting on runtime or stream locks.

## Database Boundary

`pw_mcp_write` is agent-facing and can validate/read live evidence plus insert a prepared plan. It
cannot update plans, runtime/stream lock rows, projection rows, or audit rows. Apply uses a separate
non-agent-facing `pw_repair_executor` pool. That identity can take the fixed lock sequence, update
only typed projection fields (never `order_id`), insert one audit, and complete a plan. Defensive
triggers reject its attempts to mutate runtime or stream rows. Compromise of the public MCP write
credential therefore does not grant a projection mutation path.
`pw_mcp_read` can inspect plans and audits but cannot mutate them. Audit updates and deletes are
rejected even for the schema owner.

## Stable Outcomes

- `APPLIED`: one row, one audit, one completed plan.
- `ALREADY_APPLIED`: the stored receipt is returned after current-row verification.
- `NOOP_ALREADY_CORRECT`: no database state changes.
- `STALE_PLAN`: stream, runtime, row, or candidate changed; no repair writes.
- `PLAN_EXPIRED` / `PLAN_INVALID` / `ROOT_CAUSE_UNSAFE` / `RUNTIME_UNATTESTED`: no repair writes.
- `LOCK_TIMEOUT`: bounded lock acquisition failed; no repair writes.
- `APPLY_FAILED`: unexpected work rolled back and details are redacted.

## Executable Evidence

The PostgreSQL suite proves:

- Idempotent staging and apply receipt reuse.
- Successful one-row repair with row-version increment.
- Stream, runtime, and row changes return `STALE_PLAN` with zero repair writes.
- Expiry, mismatched approval, and already-correct rows write nothing.
- An injected audit failure rolls back the earlier row CAS.
- A concurrent append waits behind the repair's stream lock and commits afterward.
- Plan-lock waits are bounded and map to `LOCK_TIMEOUT`.
- Plan evidence, runtime/stream lock rows, and audit history reject forbidden mutations.