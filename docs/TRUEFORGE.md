# TrueForge Verification

Last verified: 2026-08-25

## Local launch

TrueForge runs in the `Ubuntu` WSL2 distribution with a native Linux Node executable. Using the
Windows Node executable through WSL reports `win32` and fails ESM path handling, so it is not a
supported launch path for this repository.

```bash
export PATH="/root/.local/share/node/node-v22.23.2-linux-x64/bin:$PATH"
npx @truefoundry/trueforge@0.1.4 --port 8790
```

The running process resolves Node from:

```text
/root/.local/share/node/node-v22.23.2-linux-x64/bin/node
```

Windows reached `http://127.0.0.1:8790/healthz` with HTTP 200. Local mode is bound for local
development only and must not be exposed because this standalone instance has no login boundary.

## Configured resources

- TrueForge server: `0.1.4`.
- SDK dependency: `0.1.3`.
- Model provider: Google Gemini.
- Verified smoke model FQN: `google-gemini/gemini-3-6-flash`.
- Also configured: `google-gemini/gemini-3-1-pro-preview`.
- Sandbox provider: Daytona, status `ready`.

Provider and model keys were entered directly into TrueForge settings. They are not project
environment variables and are not committed. Settings API responses redact both credentials.

## Projection Witness saved agent

The checked-in `agents/projection-witness.agent.json` uses the pinned SDK's API field names. It
enables the Daytona sandbox, file downloads, user questions, generative UI, and one-level dynamic
subagents. The read MCP connector exposes the seven investigation, staging, and verification tools
without approval. The write connector exposes only `apply_projection_repair` and requires native
approval for that literal tool.

Registration is an idempotent API operation. It upserts both MCP connector settings and the public
Git skill at an exact 40-character commit, asks TrueForge for each live connector's tool list, and
refuses to save the agent if either list differs from the repository contract. It then creates the
named agent or updates its manifest by immutable agent ID.

With the MCP servers reachable from TrueForge, register the exact public commit:

```powershell
$env:TRUEFORGE_MCP_READ_URL = "http://<reachable-host>:8781/mcp"
$env:TRUEFORGE_MCP_WRITE_URL = "http://<reachable-host>:8782/mcp"
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run trueforge:register -- <40-char-commit>
```

The registration script has no provider, Daytona, database, or GitHub credential input. Those
credentials remain in their owning systems.

## Turn and reconnect client

Start a saved-agent turn without streaming so the immutable turn ID is known and checkpointed
before subscription:

```powershell
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run trueforge:run -- "Investigate order ORD-..."
```

The client atomically stores `sessionId`, `turnId`, and the last observed server SSE sequence
under `.projection-witness/`. It handles each event, then persists the SDK metadata `id` as the
next exclusive cursor, refusing missing, unsafe, or noncontiguous IDs. It does not approve tools.
When a native approval event appears, it reloads every persisted event page and
proves that the event references one `apply_projection_repair` call on the write connector with a
schema-valid evidence binding.

After deliberately stopping only the client, reconnect with:

```powershell
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run trueforge:reconnect
```

Reconnect first calls `getTurn`. A running turn is subscribed with the saved exclusive
`afterSequenceNumber`; a completed/cancelled/error turn is rebuilt from bounded persisted events.
The reconnect path has no create-turn method and cannot silently replace the original work.

The saved-agent manifest, registration behavior, approval binding, atomic checkpoint, and both
reconnect branches are covered by deterministic unit tests.

No persisted non-root subagent thread exists in the current local store. Three real parallel
subagent threads and a disconnect while the turn is still running remain external release gates;
they are not replaced by deterministic contract tests.

The dedicated sandbox-only evidence agent now uses `google-gemini/gemini-3-6-flash`, an 8192-token
output cap, minimal reasoning, no MCP servers, no subagents, and no approval surface. The Daytona
provider remains ready with a 180000 ms execution timeout. Exact-reducer attempts are accepted
only by the strict persisted-event verifier; sandbox creation or partial command output alone is
not represented as success.

### Real saved-agent read and reconnect evidence

On 2026-08-25, TrueForge `0.1.4` and the MCP connectors ran together on WSL loopback from public
commit `ccc886fa96cc9b43c56da91b0d3ddc9f88599103`. Registration first created and then idempotently
updated immutable agent ID `01m0x6xj4e29s239dd9kjryb8x`. Both registrations succeeded only after
TrueForge listed the exact seven-tool read surface and one-tool write surface.

Saved-agent session `01m0x6y8ekwhp85rk1s6rnqbkr`, turn
`01m0x6y8f01n8t77n8tc9mw822.local` initialized both Streamable HTTP connectors, called exactly
`projection-witness-read/find_projection_case` with order ID `MISSING-TRUEFORGE-SMOKE`, and
persisted the structured result `found=false`, `streamExists=false`, `projectionExists=false`.
The persisted turn contains no approval event, staging call, or write call and ends with
`requiredActions=[]`.

After the first client exited, `trueforge:reconnect` used its saved session, turn, and sequence
cursor `15`. `getTurn` found the turn complete, so the client rebuilt the same six persisted event
types ending in `turn.done`; it did not create another turn. This is real reconnect evidence for a
completed turn. A disconnect while the turn is still running remains to be captured separately.

The event verifier can be rerun while the local TrueForge store is available:

```powershell
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run trueforge:verify-read-smoke -- `
  01m0x6y8ekwhp85rk1s6rnqbkr `
  01m0x6y8f01n8t77n8tc9mw822.local `
  MISSING-TRUEFORGE-SMOKE
```

The later approval demo persisted both native denial and allow decisions. See
[DEMO.md](DEMO.md) for the exact plan, call, audit, and post-write evidence.

## Daytona smoke evidence

A saved sandbox-enabled smoke agent executed through the TrueForge session and turn APIs. The
persisted event log contains, in order:

1. `turn.created`.
2. A model tool call to the TrueForge `exec` system tool.
3. `sandbox.created` with a `v1:daytona:` provider identifier.
4. `tool.response` containing output produced in the sandbox.
5. `turn.done` with no required action.

The first command exposed that the TrueForge Daytona image does not contain Node, Bun, or Deno.
It contains Python `3.13.15` and standard download/extraction tools. A follow-up turn therefore:

1. Downloaded the official Node `22.23.2` Linux x64 archive inside Daytona.
2. Verified the `.tar.gz` SHA-256
  `b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a` before extraction. The
  gzip archive is required because the Daytona base image does not include `xz`.
3. Executed Node `v22.23.2` and a deterministic SHA-256 workload.
4. Returned exit code `0` through TrueForge's persisted tool response.

This proves the pinned Node bootstrap and JavaScript execution path in a real Daytona sandbox. It
does not by itself prove an exact reducer artifact.

## Exact reducer run

The evidence implementation now produces a byte-reproducible reducer bundle, checks its digest
before import, replays a bounded canonical stream twice, and verifies persisted TrueForge events.
The local artifact/CLI and PostgreSQL paths pass. Two real TrueForge attempts did not reach Daytona:

- Flash session `01m0wdmwq3kw0add7ch5ekxd2y` stalled before `sandbox.created` and was cancelled.
- Pro session `01m0wdwe0mt1gtcwf7c3nwcbv4` failed before `sandbox.created` with Gemini HTTP 429;
  its free-tier request and input-token quotas were both reported as `0`.

No exact-reducer Daytona success is claimed yet. See [EVIDENCE.md](EVIDENCE.md) for the pinned
artifact digest, fixture hashes, launcher contract, and rerun command.

## Current security boundary

- Daytona receives no database URL, database password, model key, GitHub token, or Daytona key.
- TrueForge retains provider credentials in its local settings store.
- The sandbox receives only bounded case artifacts and the exact reducer artifact when that flow
  is implemented.
- A real `sandbox.created` event is required for every clean end-to-end evidence run; local shell
  execution cannot substitute for it.
