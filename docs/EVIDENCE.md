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
a512dadc2f53f1a9de2cff45b5fbc97d3c9d21e2eb27ed76942a5425e9e87f61
```

This PR does not persist a repair plan or authorize a write. Plan immutability, transactional apply,
and stale-state rechecks belong to the next safety PR.

## Reducer Artifact

Pinned `esbuild@0.28.2` bundles the reducer, domain validation, and dependencies into one ESM file.
No source map, timestamp, absolute output path, or legal-comment side file is emitted. Two clean
builds must be byte-identical, and the unit suite pins the current known answer:

```text
byteLength  494422
sha256      ec1c540fb4f2f9ececf20cdd14ce9c3f6d255074daadbb9d6056498aa2cd1bc6
```

Build and execute the bounded fixture:

```powershell
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run build:reducer
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run evidence:run-reducer -- `
  .\artifacts\order-reducer.mjs `
  .\tests\fixtures\reducer-evidence-input.json
```

The runner reads the artifact once, checks those bytes, converts those same bytes to a data URL, and
imports it inside a resource-limited worker. The parent terminates the worker at a trusted deadline
(2 seconds by default). One regression artifact replaces its own filesystem path during import and
proves the already-hashed bytes still determine the candidate; another loops forever and is
terminated. A digest mismatch is rejected before any artifact code executes. Event, canonical-byte,
and execution-time limits are trusted runner options, not fields the evidence JSON can raise. The
CLI rejects an input file larger than 2 MiB before reading it.

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
exactly one persisted system `exec` call whose command matches byte-for-byte, one linked successful
response with exit code zero, one `sandbox.created`, one successful `turn.done`, and a complete
schema-valid final JSON result matching the fixed stream, candidate, and reducer hashes. Model prose
or arbitrary substrings cannot satisfy the verifier.

The exact reducer run is not yet claimed as successful in Daytona:

- Flash session `01m0wdmwq3kw0add7ch5ekxd2y` remained in model dispatch before
  `sandbox.created` and was cancelled.
- Pro session `01m0wdwe0mt1gtcwf7c3nwcbv4` ended before `sandbox.created` with Gemini HTTP 429;
  the provider reported both free-tier request and input-token limits as `0`.

Neither attempt executed project code. The earlier infrastructure smoke in [TRUEFORGE.md](TRUEFORGE.md)
still proves real Daytona sandbox creation and checksum-pinned Node execution. Once model quota is
available, rerun the launcher against the final commit/digest and replace this blocker with the
persisted successful session evidence.