# Verified Versions

Last verified: 2026-08-25

## Runtime and infrastructure

| Component | Exact version or digest | Evidence |
|---|---|---|
| Project Node.js | `22.23.2` | Official Windows x64 archive executed locally |
| Project npm | `10.9.8` | Bundled with Node.js 22.23.2 and executed locally |
| Node Windows archive | `sha256:1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97` | Matched the official Node.js `SHASUMS256.txt` |
| WSL distribution | Ubuntu 26.04 LTS | `wsl -d Ubuntu -- cat /etc/os-release` |
| WSL Node.js | `22.22.1` | `wsl -d Ubuntu -- node --version` |
| WSL npm | `11.16.0` | `wsl -d Ubuntu -- npm --version` |
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

## Pending credentialed verification

The following values remain intentionally unset until real executions occur:

- TrueForge model provider and exact model FQN.
- Daytona snapshot/provider configuration and verification date.
- TrueForge launch command proven from WSL.
- Reducer artifact digest and source commit SHA.

These are setup gates. They must not be replaced with mocked evidence.