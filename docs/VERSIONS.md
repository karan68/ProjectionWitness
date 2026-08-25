# Verified Versions

Last verified: 2026-08-25

## Runtime and infrastructure

| Component | Exact version or digest | Evidence |
|---|---|---|
| Project Node.js | `22.23.2` | Official Windows x64 archive executed locally |
| Project npm | `10.9.9` | Exact npm package installed and executed with Node.js 22.23.2 |
| npm bundled `tar` | `7.5.22` | Inspected at `npm/node_modules/tar/package.json`; fixes CVE-2026-59873 |
| Node Windows archive | `sha256:1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97` | Matched the official Node.js `SHASUMS256.txt` |
| WSL distribution | Ubuntu 26.04 LTS | `wsl -d Ubuntu -- cat /etc/os-release` |
| TrueForge WSL Node.js | `22.23.2` | Native Linux executable used by the running server |
| TrueForge server | `0.1.4` | Exact `npx` package; `/healthz` returned HTTP 200 |
| TrueForge smoke model | `google-gemini/gemini-3-6-flash` | Saved agent completed real sandbox turns |
| Daytona provider | `ready` on 2026-08-25 | Redacted TrueForge settings API and `sandbox.created` event |
| Daytona Node bootstrap | `22.23.2` | Official Linux x64 archive hash verified before execution |
| Daytona Node archive | `sha256:b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a` | Matched official Node.js `SHASUMS256.txt` |
| Docker Engine | `29.6.2` | WSL client and server both verified |
| Docker Compose | `5.3.1` | WSL Compose plugin verified |
| PostgreSQL image | `postgres:18.6-bookworm` | Docker Official Image tag verified |
| PostgreSQL manifest | `sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af` | Docker Hub tag API, multi-architecture manifest |
| PostgreSQL linux/amd64 image | `sha256:a10c981235b4f635e65df0cfb66a5598064628128505dbc6a3ed4ca303717521` | Docker Hub tag API |

The Compose service was executed locally and reported PostgreSQL `18.6`, data checksums `on`, and
a healthy loopback connection. Native WSL PostgreSQL already uses `5432`, so the local container
was verified with `POSTGRES_PORT=55432`. CI retains the contract default `5432`.

## Direct dependencies

| Package | Exact version |
|---|---:|
| `@truefoundry/trueforge` | `0.1.4` |
| `@truefoundry/trueforge-sdk` | `0.1.3` |
| `@modelcontextprotocol/sdk` | `1.30.0` |
| `zod` | `4.4.3` |
| `pg` | `8.23.0` |
| `fastify` | `5.12.1` |
| `canonicalize` | `4.0.0` |
| `vitest` | `4.1.11` |
| TypeScript | `5.9.3` |
| `@biomejs/biome` | `2.5.10` |
| `tsx` | `4.23.12` |

`package-lock.json` is the transitive dependency authority.

## Remaining verification

The following values remain intentionally unset until their producing implementation exists:

- Reducer artifact digest and source commit SHA.
- Final saved-agent model FQN after deterministic agent evaluation. The smoke model above is not
	yet represented as the submission model.

These are implementation gates. They must not be replaced with mocked evidence.
