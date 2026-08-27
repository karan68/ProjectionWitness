# Security Model

Last verified: 2026-08-27

## Scope

Projection Witness can repair exactly one `order_view` row derived from one immutable order event
stream. It is not a general database agent, SQL console, projection rebuild system, or source of
business truth. The reducer and PostgreSQL transaction, not model prose, determine the candidate
and whether a write is allowed.

## Trust Boundaries

- Event payloads, metadata, database values, API responses, repository text, and model output are
  untrusted input. Text inside case data is never treated as an instruction.
- The approved reducer artifact is content-addressed and restricted to the SHA-256 compiled into
  the projector build. It runs in disposable resource-limited workers with a hard deadline.
- The read MCP connector exposes fixed, parameterized, bounded reads and authoritative plan
  staging. It exposes no SQL or identifier selection.
- The write MCP connector exposes only `apply_projection_repair`. TrueForge requires native human
  approval for that literal tool.
- Native approval authorizes one persisted evidence binding, not a general repair. PostgreSQL
  rechecks stream, runtime, row, candidate, expiry, and plan evidence under locks.
- Daytona receives bounded public case artifacts and repository code. It does not receive database
  URLs, database passwords, model keys, GitHub write tokens, or Daytona credentials.

## Database Roles

| Identity | Allowed | Explicitly forbidden |
|---|---|---|
| `pw_migrator` | Ordered migrations and local role provisioning | Runtime service use |
| `pw_api` | Expected-version event appends and public projection reads | Event mutation and repair writes |
| `pw_projector` | Projection/checkpoint/gap updates and runtime registration | Repair-plan or audit mutation |
| `pw_mcp_read` | Bounded event, row, runtime, plan, and audit reads | Insert, update, or delete |
| `pw_mcp_write` | Revalidate evidence and insert immutable prepared plans | Projection, audit, runtime, or stream mutation |
| `pw_repair_executor` | Fixed lock sequence, typed projection CAS, audit insert, plan completion | Event mutation, arbitrary columns, `order_id` update |

The agent-facing staging credential cannot repair a row. Apply uses the non-agent-facing executor
pool. Defensive triggers reject event updates/deletes, audit updates/deletes, plan evidence changes,
and executor mutation of runtime or stream lock rows.

## Apply Invariants

The transaction locks plan, runtime, stream head, then projection row. It refuses with zero repair
writes when any approved value is stale or unsafe. A successful transaction performs exactly one
row-version compare-and-swap, inserts one append-only audit record, and completes the plan in the
same commit. An audit insertion failure rolls back the earlier row update.

Stable outcomes include `APPLIED`, `ALREADY_APPLIED`, `STALE_PLAN`, `PLAN_EXPIRED`,
`PLAN_INVALID`, `ROOT_CAUSE_UNSAFE`, `RUNTIME_UNATTESTED`, `NOOP_ALREADY_CORRECT`,
`LOCK_TIMEOUT`, and redacted `APPLY_FAILED`.

## Network And Authentication

The reference MCP and TrueForge services bind to loopback. MCP rejects untrusted `Host` headers,
non-POST MCP requests, and JSON bodies over 1 MiB. Public API responses and event streams have
count and byte limits before materialization.

Standalone TrueForge local mode has no login boundary and must never be exposed to a shared
network. Its session/turn/tool-call identifiers are correlation evidence, not authenticated human
identity. A production deployment requires authenticated MCP transport, OIDC identity, tenant
isolation, and an authorization policy tied to the approver.

## Secrets

Secrets are entered only into their owning system or local environment. `.env*` files, TrueForge
state, Daytona state, tools, logs, generated artifacts, and local approval files are ignored by
Git. Error responses redact database, network, and stack details. Before release, inspect Git
history, Actions logs, issues, screenshots, and video for credentials and private data.

If a credential is exposed, revoke it at the provider, remove it from all public surfaces, rotate
any dependent credential, and document the incident without reproducing the secret. Rewriting Git
history is an exceptional operator action, not an automated default.

## Rollback And Recovery

Events and audit records are append-only and are never rolled back by deleting history. A repair
that committed is independently verifiable from its receipt and before/after hashes. If the
candidate was wrong despite matching the approved reducer, fix the reducer/root projector first,
then append corrective domain events or use a separately reviewed compensating process. Never
silently rewrite event history or the audit ledger.

A stale, denied, expired, timed-out, or failed attempt leaves the prepared plan for investigation
and creates no audit row. Reinvestigation must create fresh evidence and a fresh human approval.

## Residual Risks

- Local TrueForge correlation does not prove authenticated approver identity.
- Business truth cannot be inferred when immutable events are themselves missing or wrong.
- A compromised database owner can bypass role restrictions; owner credentials are excluded from
  runtime services.
- Provider/model/Daytona availability can block investigation but cannot authorize a write.
- This reference supports one order projection schema and one reducer digest, not arbitrary
  frameworks or whole-projection rebuilds.

The executable safety evidence is in `tests/integration/projection-repair.test.ts`,
`tests/integration/repair-demo.test.ts`, and `tests/race/naive-gap-reliability.test.ts`.
