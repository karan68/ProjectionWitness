# Projection Witness

Projection Witness is a TrueForge agent for proof-carrying, stale-safe repair of exactly one
corrupted event-sourced PostgreSQL order projection row.

The model investigates and coordinates. The immutable event stream plus the exact attested
reducer produces the candidate. PostgreSQL locks and compare-and-swap checks decide whether the
approved candidate is still safe to apply.

## Current status

The complete one-row workflow is implemented and merged: genuine gap reproduction, safe runtime
attestation, reducer-derived evidence, immutable plan staging, native TrueForge denial and allow,
transactional apply, append-only audit, and independent API/database verification. The local and
CI gates pass. Persisted TrueForge evidence now covers exact reducer execution in a real Daytona
sandbox, parallel dynamic subagents, running-turn reconnect, and native denial/allow. Only the
operator-owned video and official submission steps remain, as tracked in
[docs/SUBMISSION.md](docs/SUBMISSION.md).

Hackathon write-up: [Projection Witness: Approval For One Proven Repair](docs/BLOG.md).

## Qodo Code Review Evidence

Representative substantive merge: [PR #11, retryable and bounded exact-commit Daytona
evidence](https://github.com/karan68/ProjectionWitness/pull/11). Qodo surfaced hard-timeout,
pathname TOCTOU, input-validation, cleanup, and focused-test gaps. The accepted fixes bind hashing
and execution to the same bytes, enforce aggregate TERM/KILL deadlines, clean every launcher exit,
and add executable regressions; the follow-up review on the final head reported zero bugs and zero
rule violations. The complete finding, decision, fix, and merge history is in
[docs/QODO_EVIDENCE.md](docs/QODO_EVIDENCE.md).

## Prerequisites

- Node.js `22.23.2` with npm `10.9.9` installed over the bundled npm release.
- Docker Engine with Compose support.
- On this Windows host, Docker runs in the `Ubuntu` WSL2 distribution.

## Foundation commands

```powershell
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" ci
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run db:up
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run db:down
```

Set the migration owner and all five least-privilege runtime identities before applying migrations
and provisioning login passwords. The example passwords are local-only placeholders and must
match the values used to create the disposable database:

```powershell
$env:DATABASE_URL_MIGRATOR = "postgresql://pw_migrator:<local-password>@127.0.0.1:55432/projection_witness"
$env:DATABASE_URL_API = "postgresql://pw_api:<local-api-password>@127.0.0.1:55432/projection_witness"
$env:DATABASE_URL_PROJECTOR = "postgresql://pw_projector:<local-projector-password>@127.0.0.1:55432/projection_witness"
$env:DATABASE_URL_MCP_READ = "postgresql://pw_mcp_read:<local-read-password>@127.0.0.1:55432/projection_witness"
$env:DATABASE_URL_MCP_WRITE = "postgresql://pw_mcp_write:<local-stage-password>@127.0.0.1:55432/projection_witness"
$env:DATABASE_URL_REPAIR_EXECUTOR = "postgresql://pw_repair_executor:<local-executor-password>@127.0.0.1:55432/projection_witness"
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run db:migrate
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run db:bootstrap-roles
```

The migration runner applies each file once, records its SHA-256 checksum, and refuses an applied
filename whose contents have changed. The role bootstrap reads the five runtime URLs, validates
their fixed usernames and database target, and provisions their passwords without committing
secrets. See [docs/EVENT_STORE.md](docs/EVENT_STORE.md) for the implemented append and
immutability contracts.

## Genuine gap reproduction

The naive projector failure can be reproduced through normal event appends on the guarded local
demo database:

```powershell
$env:DEMO_MODE = "true"
$env:DATABASE_URL_MIGRATOR = "postgresql://pw_migrator:<local-password>@127.0.0.1:55432/projection_witness"
$env:CONFIRM_DATABASE_RESET = "projection-witness-local"
$env:POSTGRES_PORT = "55432"
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run demo:reset
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run demo:reproduce-gap
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run demo:verify
```

The reset command recreates the disposable Docker database volume. The reproducer refuses a
non-empty database, then allocates the payment at global position 3, commits an unrelated event at
position 4 first, and advances naive projector v1 to checkpoint 4. The API remains
`AWAITING_PAYMENT` while immutable stream replay returns `PAID`.

See [docs/GAP_REPRODUCTION.md](docs/GAP_REPRODUCTION.md) for the mechanism, ablation, safety
guard, and exact expected evidence.

## Gap-aware runtime

Projector v2 records newly observed missing global positions, continues unrelated streams, and
rechecks tracked positions on later polls. It registers a locked runtime manifest containing its
generation, source commit, algorithm, gap strategy, and the SHA-256 of the reducer module it
actually loads. It intentionally cannot discover a historical position already skipped by v1.

See [docs/GAP_AWARE_PROJECTOR.md](docs/GAP_AWARE_PROJECTOR.md) for the algorithm, explicit
permanent-hole retirement policy, runtime refusal contract, startup command, and PostgreSQL proof.

## Canonical evidence

The evidence package implements RFC 8785 canonicalization, SHA-256 stream/row/runtime/candidate
fingerprints, deterministic double replay, a self-derived repair envelope, and an exact reducer
artifact runner. The PostgreSQL role-split path and local artifact known answers pass. The exact
merge-commit reducer run also passes the strict persisted-event verifier in a real
TrueForge-created Daytona sandbox; it is not inferred from local execution or model prose.

See [docs/EVIDENCE.md](docs/EVIDENCE.md) for the trust boundary, known hashes, executable commands,
and persisted TrueForge attempt status.

## Transactional repair

The repair package now stages immutable evidence plans and atomically applies one projection-row
CAS with an append-only audit receipt and plan completion. Runtime, stream, row, candidate, expiry,
and approval fields are rechecked under a fixed lock order. Stale, expired, no-op, lock-timeout, and
injected audit-failure paths leave repair state unchanged.

See [docs/TRANSACTIONAL_REPAIR.md](docs/TRANSACTIONAL_REPAIR.md) for the lock order, role boundary,
stable outcomes, and PostgreSQL evidence.

## MCP connectors

The loopback read connector exposes seven bounded investigation, staging, and verification tools.
The separate write connector exposes only the destructive, idempotent
`apply_projection_repair` tool so TrueForge can place native approval on that exact operation.
The write-facing database credential can stage immutable plans but cannot mutate projections;
apply runs through the internal executor identity.

See [docs/MCP_CONNECTORS.md](docs/MCP_CONNECTORS.md) for the exact tool surfaces, database roles,
limits, startup command, and official-client smoke test. The checked-in TrueForge manifest,
projection repair sandbox skill, idempotent
registration client, approval-event verifier, and sequence-based reconnect client are documented
in [docs/TRUEFORGE.md](docs/TRUEFORGE.md); deterministic contract tests, real registration, a
read-tool turn, completed-turn reconnect, native denial, and native allow now pass at exact public
commits.

## Approval-bound demo

The exact public-commit demo reproduces the real projector gap, stages a reducer-derived plan,
shows the native TrueForge approval card, proves denial leaves plan/audit/row/API unchanged, and
records a separate native allow that applies one audited row. Persisted post-write reads and an
independent verifier agree that the database and public API are `PAID`.

See [docs/DEMO.md](docs/DEMO.md) for commands, hashes, persisted TrueForge IDs, zero-mutation denial
evidence, native allow, audit receipt, and post-write verification.

## End-to-end local run

Keep PostgreSQL running, then start the public API and both MCP connectors in separate terminals:

```powershell
$env:POSTGRES_PORT = "55432"
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run db:serve

$env:API_PORT = "3000"
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run dev:api

$env:API_BASE_URL = "http://127.0.0.1:3000"
$env:REDUCER_BUNDLE_PATH = ".\artifacts\order-reducer.4decce13b48e3aeff9402b36c13bf2a995b176f2c7e11e203c83d03b8b23e637.cjs"
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run build:reducer
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run dev:mcp
```

Run TrueForge `0.1.4` on WSL loopback using the launch command in
[docs/TRUEFORGE.md](docs/TRUEFORGE.md). Register the exact public commit after setting
`TRUEFORGE_MCP_READ_URL` and `TRUEFORGE_MCP_WRITE_URL`, then follow the guarded reset,
reproduction, preparation, approval, and verification commands in [docs/DEMO.md](docs/DEMO.md).
TrueForge local mode has no authentication and must remain on localhost.

On this host, native WSL PostgreSQL already owns port `5432`, and WSL stops detached services when
its last Windows handle closes. Use the tested override and keep the foreground database terminal
open during development:

```powershell
$env:POSTGRES_PORT = "55432"
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run db:serve
```

To deliberately recreate the local database and delete its Compose volume:

```powershell
$env:CONFIRM_DATABASE_RESET = "projection-witness-local"
$env:POSTGRES_PORT = "55432"
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run db:reset
```

The reset command refuses `NODE_ENV=production` and requires the exact confirmation token.

## Safety boundary

- No arbitrary SQL tool.
- No event update or delete.
- No LLM-authored candidate row.
- No repair before native TrueForge approval.
- No write when stream, runtime, row, candidate, plan, or expiry evidence is stale.

See [SOURCE_OF_TRUTH.md](SOURCE_OF_TRUTH.md) for the complete contract and
[docs/SECURITY.md](docs/SECURITY.md) for trust boundaries and residual risk,
[docs/VERSIONS.md](docs/VERSIONS.md) for verified pins,
[docs/TRUEFORGE.md](docs/TRUEFORGE.md) for the tested harness path, and
[docs/QODO_EVIDENCE.md](docs/QODO_EVIDENCE.md) for review history. Submission narration and
operator steps are in [docs/SUBMISSION.md](docs/SUBMISSION.md); AI assistance and human
verification are disclosed in [docs/AI_DISCLOSURE.md](docs/AI_DISCLOSURE.md).

## License

MIT. See [LICENSE](LICENSE).