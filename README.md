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
```

The migration runner applies each file once, records its SHA-256 checksum, and refuses an applied
filename whose contents have changed. See [docs/EVENT_STORE.md](docs/EVENT_STORE.md) for the
implemented append and immutability contracts.

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