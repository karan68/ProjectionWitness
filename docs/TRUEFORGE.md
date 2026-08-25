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
2. Verified SHA-256
   `b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a` before extraction.
3. Executed Node `v22.23.2` and a deterministic SHA-256 workload.
4. Returned exit code `0` through TrueForge's persisted tool response.

This proves the pinned Node bootstrap and JavaScript execution path in a real Daytona sandbox. It
does not yet prove an exact reducer artifact: that digest and source commit remain blocked on the
reducer implementation and bundle produced in the dedicated evidence PR.

## Current security boundary

- Daytona receives no database URL, database password, model key, GitHub token, or Daytona key.
- TrueForge retains provider credentials in its local settings store.
- The sandbox receives only bounded case artifacts and the exact reducer artifact when that flow
  is implemented.
- A real `sandbox.created` event is required for every clean end-to-end evidence run; local shell
  execution cannot substitute for it.
