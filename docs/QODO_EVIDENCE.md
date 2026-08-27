# Qodo Evidence

## Installation

- Installation date: 2026-08-25.
- GitHub repository: `karan68/ProjectionWitness`.
- Installation timing: completed before the repository's first commit.
- Repository access: the operator confirmed Qodo was granted access to this repository.
- Portal settings: the operator confirmed review-every-push and persistent comment notification
  are enabled.
- Repository settings: `.pr_agent.toml` records the same push-trigger and review-history policy.

Qodo posted a summary and a full code review on the first implementation PR. Installation and
configuration alone are not represented as review evidence.

## Pull request record

| PR | Scope | Qodo result | Material response |
|---:|---|---|---|
| [1](https://github.com/karan68/ProjectionWitness/pull/1) | Foundation, toolchain, CI, and versions | Two valid findings on `d28215d`; both resolved on `9a6e0c5` with zero new findings | Accepted and fixed |
| [2](https://github.com/karan68/ProjectionWitness/pull/2) | Typed order domain, reducer, migration, and expected-version event store | Three valid findings on `ab7efd6`; all resolved on `cc3cfcf` with zero new findings | Accepted and fixed |
| [3](https://github.com/karan68/ProjectionWitness/pull/3) | Naive projector, API read, deterministic gap reproducer, and reliability gate | Eight findings on `efabb2a`; corrections committed in `27b979c` | Accepted and fixed; final persistent review remains visible on the PR |
| [4](https://github.com/karan68/ProjectionWitness/pull/4) | Gap-aware projector and runtime attestation | Multiple exact-head rounds found bigint bounds, path validation, publication races, source disclosure, execution bounds, and determinism gaps | Accepted and fixed through reviewed head `8451e23`; merged as `d6bb9cc` |
| [5](https://github.com/karan68/ProjectionWitness/pull/5) | Canonical evidence and reducer provenance | Review found artifact TOCTOU, unbounded execution/text, forgeable tool output, unbound provenance, pagination, and fresh-module replay gaps | Accepted and fixed through reviewed head `6e145f1`; merged as `0373a2f` |
| [6](https://github.com/karan68/ProjectionWitness/pull/6) | Evidence-bound transactional repair | Review found timestamp normalization, unattested staging, receipt lock ordering, unsafe cents, and over-broad write privileges | Accepted and fixed through `93605aa`; merged as `ea82bbd` |
| [7](https://github.com/karan68/ProjectionWitness/pull/7) | Role-separated MCP connectors | Review found cross-order verification and mixed PostgreSQL statement snapshots | Accepted and fixed through `e2da192`; merged as `4734413` |
| [8](https://github.com/karan68/ProjectionWitness/pull/8) | Approval-gated TrueForge saved agent | Review found approval verification parsing unrelated parallel sibling calls as apply calls | Accepted and fixed on the reviewed stack before merge |
| [9](https://github.com/karan68/ProjectionWitness/pull/9) | Approval-bound end-to-end demo | Review found synthetic reconnect cursors and alleged first-page-only approval history | Cursor accepted and fixed with real SSE IDs; pagination finding disproved against pinned SDK automatic page iteration and a 101-event regression |
| [10](https://github.com/karan68/ProjectionWitness/pull/10) | Reliability, clean-clone, and submission hardening | Findings covered release-gate behavior and documentation consistency | Accepted findings fixed before merge; exact-head CI and persistent review passed |
| [11](https://github.com/karan68/ProjectionWitness/pull/11) | Retryable, bounded exact-commit Daytona evidence | Review found retry, hard-timeout, event-listing, pathname TOCTOU, path validation, complete-launcher budget, cleanup, and focused-test gaps | Accepted and fixed through reviewed head `56f9770`; final review reported zero bugs and zero rule violations; merged as `7c3732d` |

### PR 1 findings

1. **High: npm 10.9.8 bundled vulnerable `tar` 7.5.11.** Accepted. The project now pins npm
  `10.9.9`, whose installed package was inspected and contains `tar` 7.5.22. CI installs and
  asserts the exact npm version before `npm ci`. A clean local install and production audit pass.
2. **Medium: `ubuntu-latest` is a moving CI target.** Accepted. CI now pins `ubuntu-24.04`.

Qodo updated its persistent review for commit `9a6e0c5` on 2026-08-25. It reported zero bugs,
zero rule violations, and marked both prior findings resolved.

### PR 2 findings

1. **Runtime roles could not authenticate.** Accepted. Runtime roles are login-capable but receive
  no committed password. A bootstrap validates the four secret runtime URLs and provisions
  passwords transactionally; integration tests authenticate directly as every runtime identity.
2. **`DATABASE_URL_MIGRATOR` was absent from the canonical environment contract.** Accepted and
  added to `SOURCE_OF_TRUTH.md`.
3. **Typecheck emitted build artifacts.** Accepted. Typecheck now uses a flat strict no-emit
  configuration, while build retains emitting project references. An executable check confirmed
  zero artifacts after typecheck.

Qodo updated its persistent review for commit `cc3cfcf` on 2026-08-25. It reported zero bugs,
zero rule violations, and marked all three findings resolved.

### PR 3 findings

All eight findings were accepted: connection-string override bypass, missing readiness/metadata
routes, event-table truncation, negative money parsing, accidental workspace self-dependency,
unbounded commit-gate failure, public internal-error leakage, and incomplete standalone proof
verification. Commit `27b979c` fixes each with focused regressions. The same correction also fixed
numeric projector ordering across bigint digit boundaries, which the ten-run race gate exposed.

### PR 4 and PR 5 findings

The repeated deep reviews materially changed the design. Reducer artifacts are now immutable,
content-addressed, size-bounded CommonJS files. Projector and evidence execution accept only the
digest compiled into the projector build, run in killable workers with cleared environments, and
compare fresh module executions. TrueForge evidence verification consumes every persisted page,
requires one exact linked `exec` call, bounds all text before parsing, and validates the complete
fixture result rather than matching substrings. Plan envelopes can consume only opaque evidence
returned by the verified artifact runner.

The final PR 5 summary carried an `Artifact size check races` item after the code had moved to one
`O_NOFOLLOW` file handle with pre-read `fstat` and a post-read byte-length check. Exact-head CI was
green and no current inline thread remained; this was treated as an evidence-backed disagreement.

### PR 6 through PR 9 findings

The transactional repair reviews forced authoritative reducer execution before plan staging,
canonical timestamp and money bounds, early receipt reuse, and a split between agent-facing plan
staging and an internal least-privilege repair executor. The MCP reviews made the persisted plan's
stream ID authoritative and moved plan, audit, and row reads into one read-only repeatable-read
snapshot.

The TrueForge review corrected approval verification so it selects the referenced tool-call ID
before validating only that call as the write-side apply tool; unrelated parallel read calls are
permitted. The demo review replaced synthetic event counts with the pinned SDK's actual SSE
metadata IDs and now refuses missing, unsafe, or noncontiguous cursors.

The PR 9 `Approval history truncates` finding was investigated and rejected. In SDK `0.1.3`,
`listTurnEvents` returns `core.Page`, whose async iterator calls `getNextPage()` until
`hasNextPage()` is false. `collectPersistedTurnEvents` consumes that iterator and independently
caps the aggregate at 10,000 events. A focused 101-event regression proves an approval after the
first API page is collected.

For every PR, record the URL, reviewed commit, findings, fixes, and evidence-backed disagreements
before merge.
