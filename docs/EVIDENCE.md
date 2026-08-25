# Canonical Evidence And Reducer Provenance

Last verified: 2026-08-26

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

This PR does not persist a repair plan or authorize a write. Plan immutability, transactional apply,
and stale-state rechecks belong to the next safety PR.

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

The runner reads the artifact once, checks those bytes, and evaluates that source inside a restricted
VM context within a resource-limited worker. The artifact context has no worker channel, `require`,
or `process`; only the wrapper can return replay results. The parent safely validates the message and
terminates the worker at a trusted deadline (2 seconds by default). Regressions cover channel-forgery
attempts, malformed messages, path replacement, infinite loops, and pre-execution digest mismatch.
Event, canonical-byte, and execution-time limits are trusted runner options, not fields the evidence
JSON can raise. The CLI rejects an input file larger than 2 MiB before reading it.

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

The exact reducer run is not yet claimed as successful in Daytona:

- Flash session `01m0wdmwq3kw0add7ch5ekxd2y` remained in model dispatch before
  `sandbox.created` and was cancelled.
- Pro session `01m0wdwe0mt1gtcwf7c3nwcbv4` ended before `sandbox.created` with Gemini HTTP 429;
  the provider reported both free-tier request and input-token limits as `0`.

Neither attempt executed project code. The earlier infrastructure smoke in [TRUEFORGE.md](TRUEFORGE.md)
still proves real Daytona sandbox creation and checksum-pinned Node execution. Once model quota is
available, rerun the launcher against the final commit/digest and replace this blocker with the
persisted successful session evidence.