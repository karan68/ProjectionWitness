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

For every PR, record the URL, reviewed commit, findings, fixes, and evidence-backed disagreements
before merge.
