# Canonical Evidence And Reducer Provenance

Last verified: 2026-08-28

## Canonicalization

Evidence uses pinned `canonicalize@4.0.0`, the JavaScript implementation listed by RFC 8785,
followed by UTF-8 encoding and SHA-256 from `node:crypto`. Inputs pass a strict `z.json()` boundary
before canonicalization. NaN, infinity, bigint values, lone surrogates, undefined values, and
non-JSON objects are rejected.

The unit suite includes the exact primitive serialization sample from RFC 8785 sections 3.2.2 and
3.2.3, the section 3.2.3 UTF-16 property-order vector, failure vectors, and project-specific
known-answer hashes. It compares canonical wire text directly; reparsing would reorder the
integer-like property name `"1"` under JavaScript enumeration rules.

Database `bigint` fields are canonical decimal strings. Stream fingerprints cover the ordered
array of event ID, global position, stream identity/version, event type, payload, metadata, and
recorded time. Stream versions must be contiguous from one and match the locked head; global
positions intentionally need not be contiguous.

Current-row fingerprints include business state and `rowVersion` but exclude `updated_at`.
Candidate fingerprints contain reducer-derived business state. Runtime fingerprints contain
generation, reducer digest, source commit, algorithm, and gap strategy but exclude registration
time.

## Envelope

`buildRepairEnvelope` receives the current canonical database row, runtime manifest, plan ID,
injected clock, and opaque evidence returned by `runReducerArtifactEvidence`. It does not accept a
separate reducer callback or caller-authored candidate. The executed artifact digest must equal the
runtime manifest digest. The builder computes rather than accepts the four proof flags:

- Contiguous stream versions.
- Deterministic reducer output across two fresh runs.
- Candidate stream version equal to the locked stream head.
- Active `gap-aware-v1` / `TRACKED_NON_BLOCKING` root fix.

The builder also requires matching projection, stream, current-row, and candidate identities. It
checks nested current/candidate hashes, then computes `evidenceSha256` over the RFC 8785 envelope
with only `evidenceSha256` omitted. The fixed project vector is:

```text
c45752e3a38ef7656eb121e5aa5b1aff5412b5645ed91408ea0a07df6c1366c7
```

Plan staging and transactional apply consume this envelope without accepting a caller-authored
candidate. Their lock, compare-and-swap, and audit contracts are documented separately.

## Reducer Artifact

Pinned `esbuild@0.28.2` bundles the reducer, domain validation, and dependencies into one
content-addressed CommonJS file.
No source map, timestamp, absolute output path, or legal-comment side file is emitted. Two clean
builds must be byte-identical, and the unit suite pins the current known answer:

```text
byteLength  495300
sha256      4decce13b48e3aeff9402b36c13bf2a995b176f2c7e11e203c83d03b8b23e637
```

Build and execute the bounded fixture:

```powershell
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run build:reducer
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run evidence:run-reducer -- `
  .\artifacts\order-reducer.4decce13b48e3aeff9402b36c13bf2a995b176f2c7e11e203c83d03b8b23e637.cjs `
  .\tests\fixtures\reducer-evidence-input.json
```

The public runner accepts only the reducer digest compiled into the projector build. It rejects an
artifact over 1 MiB or invalid UTF-8, reads and checks the bytes once, clears the worker environment,
and evaluates the source in a VM context within a resource-limited worker. The VM is a fixed-name
loader, not the security boundary; the approved digest is the code-trust control, while the worker
provides termination and keeps database objects out of the reducer heap. The parent safely validates
the message and terminates the worker at a trusted deadline (2 seconds by default). Regressions cover
channel-forgery attempts, malformed messages, path replacement, infinite loops, oversized artifacts,
and pre-execution digest mismatch. Event, canonical-byte, and execution-time limits are trusted
runner options, not fields the evidence JSON can raise. The CLI rejects an input file larger than
2 MiB before reading it.

Verified fixture output:

```text
stream sha256     e574755a41608e81eca0cc7bc33412c96d35f39be51d30fd4f77ff963e5fe903
candidate sha256  9c586ffed5924a0d8d5b7a517a633f0c264e6212b4fb995e00886cf102850fb2
deterministic     true
```

## PostgreSQL Evidence

The integration test appends through `pw_api`, projects and registers runtime through
`pw_projector`, and reads through `pw_mcp_read`. Repeated stream, row, runtime, and envelope reads
produce identical hashes. Updating only `order_view.updated_at` leaves the row fingerprint
unchanged.

## TrueForge And Daytona Status

The repository includes `npm run evidence:trueforge-daytona -- <commit> <reducer-sha256>`. The
launcher creates a named TrueForge session, requires the sandbox execution tool, downloads only the
exact public commit, checksum-verifies Node 22.23.2, installs npm 10.9.9, runs `npm ci`, rebuilds the
artifact, compares the runtime digest, and executes the bounded fixture. Verification requires
all persisted event pages, exactly one system `exec` call whose command matches byte-for-byte, one linked successful
response with exit code zero, one `sandbox.created`, one successful `turn.done`, and a complete
schema-valid final JSON result matching the fixed stream, candidate, and reducer hashes. Model prose
or arbitrary substrings cannot satisfy the verifier. Event count and every persisted text field are
bounded before JSON parsing.

The exact merge-commit reducer run is successful and accepted by the strict persisted-event
verifier:

- Public commit: `7c3732db5394eab931bd99cbdb9bca6a3a98c142`.
- TrueForge session: `01m1285jm6s9xxxjqhqexxzqp6`.
- Turn: `01m1285jmm5kq6ypqrpz870zg5.local`.
- Daytona sandbox: `v1:daytona:default.126a924-a948-467e-92ab-0ec4da122eed`.
- Exact `exec` call: `call_d6gzk9y0`.
- Downloaded script SHA-256:
  `619fab9f4375c84b402c52b21597aeafcd3d414e942f7dca347cf6f53ca7f3ab`.
- Reducer SHA-256:
  `4decce13b48e3aeff9402b36c13bf2a995b176f2c7e11e203c83d03b8b23e637`.
- Stream SHA-256: `e574755a41608e81eca0cc7bc33412c96d35f39be51d30fd4f77ff963e5fe903`.
- Candidate SHA-256: `9c586ffed5924a0d8d5b7a517a633f0c264e6212b4fb995e00886cf102850fb2`.
- Tool exit code: `0`; turn status: `done`; deterministic double replay: `true`.

The command used a local Ollama `qwen3:8b` model through a temporary OpenAI-compatible streaming
adapter because the configured Gemini free tier was exhausted. Tool execution still occurred in
the real TrueForge-created Daytona sandbox. The model did not supply evidence acceptance: the
repository verifier independently required one byte-exact command, one linked zero-exit response,
one `sandbox.created`, a successful terminal turn, and the complete known-answer JSON.

Rerun that independent check while the local TrueForge store is available:

```powershell
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run trueforge:verify-daytona -- `
  01m1285jm6s9xxxjqhqexxzqp6 `
  7c3732db5394eab931bd99cbdb9bca6a3a98c142 `
  4decce13b48e3aeff9402b36c13bf2a995b176f2c7e11e203c83d03b8b23e637
```

Earlier failed sessions remain in the persisted TrueForge store and are not counted as proof. They
exposed provider quota, executor timeout, missing `xz`, omitted development dependencies, and
transient install failures; PR #11 converted those observations into bounded retries, hard
TERM/KILL deadlines, same-byte hash/execution, complete event-listing deadlines, and cleanup on
every launcher exit.