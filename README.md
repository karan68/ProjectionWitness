# Projection Witness

Projection Witness is a TrueForge agent for proof-carrying, stale-safe repair of exactly one
corrupted event-sourced PostgreSQL order projection row.

The model investigates and coordinates. The immutable event stream plus the exact attested
reducer produces the candidate. PostgreSQL locks and compare-and-swap checks decide whether the
approved candidate is still safe to apply.

## Current status

Foundation work is in progress. No repair workflow is claimed as implemented until the executable
gates in [SOURCE_OF_TRUTH.md](SOURCE_OF_TRUTH.md) pass.

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

Set `DATABASE_URL_MIGRATOR` to the local migration-owner connection before applying ordered
migrations:

```powershell
$env:DATABASE_URL_MIGRATOR = "postgresql://pw_migrator:<local-password>@127.0.0.1:55432/projection_witness"
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
artifact runner. The PostgreSQL role-split path and local artifact known answers pass. The real
exact-reducer Daytona run is currently blocked before sandbox creation by model quota and is not
claimed as complete.

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
limits, startup command, and official-client smoke test. Native TrueForge approval wiring remains
follow-up work.

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
[docs/VERSIONS.md](docs/VERSIONS.md) for verified pins,
[docs/TRUEFORGE.md](docs/TRUEFORGE.md) for the tested harness path, and
[docs/QODO_EVIDENCE.md](docs/QODO_EVIDENCE.md) for review history.

## License

MIT. See [LICENSE](LICENSE).