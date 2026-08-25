# Transactional Projection Repair

Last verified: 2026-08-25

## Scope

`@projection-witness/repair` stages an immutable version-1 evidence envelope and applies exactly
one order projection repair through fixed, parameterized SQL. It accepts no SQL, table name, column
name, or model-authored candidate. MCP transport and native TrueForge approval are not part of this
package; they will call this typed boundary in later PRs.

## Plan Staging

`stageRepairPlan` verifies the complete canonical envelope before insertion. The database stores
stream, runtime, current-row, candidate, expiry, and envelope digests as immutable columns.
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

## Database Boundary

`pw_mcp_write` can lock runtime and stream rows through narrow key-column update privileges, but
defensive triggers reject actual updates to those tables by that role. It can insert plans/audits,
perform the typed order-row update, and complete a plan subject to the evidence and audit triggers.
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