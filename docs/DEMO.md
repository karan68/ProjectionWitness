# Projection Witness Demo

Last verified: 2026-08-28

## What This Proves

The demo starts from a real out-of-order event commit, not a manually edited projection row. The
naive projector advances its global checkpoint past a temporarily invisible payment and never
revisits it. The customer API remains unpaid while replay of the immutable order stream is paid.

The trusted preparation command then registers the safe gap-aware runtime, executes the exact
content-addressed reducer, stages one immutable repair plan, and writes its approval binding to a
local mode-0600 file. TrueForge independently reads the live plan, API, row, runtime, and bounded
stream before issuing the direct write-tool call. Native approval is required before the MCP write
connector can execute.

## Exact Runtime

- Public commit: `20dff8827db9da56e9007cdd90794b7d42e86fc7`
- TrueForge: `0.1.4`
- TrueForge SDK: `0.1.3`
- Node: `22.23.2`
- npm: `10.9.9`
- Reducer SHA-256: `4decce13b48e3aeff9402b36c13bf2a995b176f2c7e11e203c83d03b8b23e637`
- PostgreSQL image digest: `sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af`

TrueForge, the API, both MCP connectors, and PostgreSQL run on WSL loopback. Standalone TrueForge
is not exposed because local mode has no authentication boundary.

## Reproduction

After the guarded demo database reset, migrations, and role bootstrap:

```powershell
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run demo:reproduce-gap
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run demo:verify
```

The verified corruption is:

- Target order: `ORD-1042`
- Payment global position: `3`
- Unrelated committed position and checkpoint: `4`
- Customer row: `AWAITING_PAYMENT`, paid cents `0`, stream version `1`
- Immutable replay: `PAID`, paid cents `12900`, stream version `2`
- Later naive poll processed count: `0`

Build the reducer in the exact public checkout, then prepare a short-lived plan:

```powershell
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run build:reducer
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run demo:prepare-repair
```

The preparation command refuses any row other than the expected genuine unpaid stale projection.
It checks bounded immutable events, safe runtime identity, approved reducer bytes, deterministic
replay, current-row hash, and canonical envelope before staging.

Request native approval with the emitted local plan file:

```powershell
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run demo:request-approval -- `
  .projection-witness/demo-repair-<plan-id>.json
```

The command creates one saved-agent session and turn, checkpoints cursor zero before subscribing,
and prints the schema-validated binding when `tool.approval_required` arrives. It never submits an
approval response.

After a native decision, independently verify the expected state:

```powershell
# Denied or not yet approved
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run demo:verify-repair -- `
  .projection-witness/demo-repair-<plan-id>.json PREPARED

# Approved and applied
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run demo:verify-repair -- `
  .projection-witness/demo-repair-<plan-id>.json APPLIED
```

## Persisted Native Denial Evidence

The first real approval-path run used plan `b65f6f85-865e-4eb5-ae80-6de3a10722b9`:

- Stream SHA-256: `fc0cf7883c9dbee1f62446e9973a3c716c4b367be470a0ffe9a7dfbab332b42d`
- Current row SHA-256: `9d6757941d7267e3531374a17d04259ab049c710ec6863245ac47083af1a0b0b`
- Candidate row SHA-256: `82a372a9dc217c39dea955c0e4b8a196e1d471c4419e19b711fe8c78bace2ecd`
- Evidence SHA-256: `5cd5700795ba660974acada8827df3026ef2602ff1ab5adf29620cb7630967a1`
- TrueForge session: `01m0x8885wmm1kwnye9ny7qm60`
- Approval turn: `01m0x8886arjax2r3w1bp5a29t.local`
- Approval event: `01m0x89x52v4aerr3s7sz0dhap`
- Exact apply tool call: `call_1422668`
- Denial child turn: `01m0x8f6d14995j5z2s7yhs0z3.local`

Persisted events show both Streamable HTTP connectors initialized, a real Daytona
`sandbox.created` event for the public Git skill, independent read-plane calls, the exact
`apply_projection_repair` arguments, and `tool.approval_required` before any write response. The
native UI displayed the full plan binding, one-row blast radius, stale-evidence refusal guarantee,
and `Allow`/`Deny` controls.

The controlled denial reason was persisted as a `user.tool_approval` event. The write connector
returned a denied response without execution. The agent then independently re-read plan, row, and
public API state. The repository verifier separately confirmed:

- Plan remains `PREPARED`.
- Audit receipt is `null`.
- Row version remains `1`.
- Database and public API remain `AWAITING_PAYMENT` with paid cents `0`.

This is real native denial and zero-mutation evidence. It is not claimed as human approval or a
successful repair.

## Successful Human Approval

A fresh one-hour plan `964b91bc-3329-46cf-bb19-bf2cb67f22cd` was staged after the denial. Its
TrueForge session is `01m0x8gvx485c79ng8v0j1p8qa`, approval turn is
`01m0x8gvxfz4dg9e3njes3jsmw.local`, approval event is `01m0x8jj45473cgzbjsdtbdd6z`, and exact
write call is `call_1435401`. The approval expires at `2026-08-25T21:06:43.905Z`.

The native UI is open at:

```text
http://127.0.0.1:8790/sessions/01m0x8gvx485c79ng8v0j1p8qa
```

The operator selected `Allow`. TrueForge persisted a child turn with
`user.tool_approval { status: "allow" }` for exact call `call_1435401` before the write response.
The write connector returned:

- Status: `APPLIED`
- Audit ID: `240d754c-9dba-4591-895b-6b1c7fd6a391`
- Receipt SHA-256: `1ff27877d3804a20cf4094c0667cfac9f2cb80c84f35f64d2cbba90dde7ffc66`

Persisted post-write tool responses independently reported `planStatus=APPLIED`, the same audit
receipt, `rowMatchesAudit=true`, HTTP 200, and public `paymentStatus=PAID` at stream version `2`.
The repository verifier separately confirmed row version `2`, database status `PAID`, and public
status `PAID`.

The model's final prose generation then hit Gemini HTTP 429 after these verification responses.
That quota error did not affect the already committed transaction or its persisted evidence. The
17-event chain passes the executable verifier:

```powershell
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run trueforge:verify-approved-repair -- `
  01m0x8gvx485c79ng8v0j1p8qa `
  964b91bc-3329-46cf-bb19-bf2cb67f22cd `
  ORD-1042 `
  call_1435401 `
  1ff27877d3804a20cf4094c0667cfac9f2cb80c84f35f64d2cbba90dde7ffc66
```

## Honest Limitations

- The approval turn's reducer preparation used isolated local workers. A separate merge-commit
  TrueForge session executed and strictly verified the exact reducer in a real Daytona sandbox;
  the two evidence chains are not conflated.
- Completed-turn rebuild and live running-turn subscription are both persisted. The running proof
  resumed the same turn from SSE cursor `5` to `11` without replacement work.
- The live successful plan was not invoked a second time because a second direct write-tool call
  would require a separate native approval. Stable `ALREADY_APPLIED` receipt reuse remains covered
  by PostgreSQL integration tests.
- Standalone local TrueForge correlation IDs are audit correlation data, not authenticated human
  identity.