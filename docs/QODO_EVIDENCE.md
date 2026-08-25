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
| [2](https://github.com/karan68/ProjectionWitness/pull/2) | Typed order domain, reducer, migration, and expected-version event store | Pending | Pending |
| [3](https://github.com/karan68/ProjectionWitness/pull/3) | Naive projector, API read, deterministic gap reproducer, and reliability gate | Pending | Pending |

### PR 1 findings

1. **High: npm 10.9.8 bundled vulnerable `tar` 7.5.11.** Accepted. The project now pins npm
  `10.9.9`, whose installed package was inspected and contains `tar` 7.5.22. CI installs and
  asserts the exact npm version before `npm ci`. A clean local install and production audit pass.
2. **Medium: `ubuntu-latest` is a moving CI target.** Accepted. CI now pins `ubuntu-24.04`.

Qodo updated its persistent review for commit `9a6e0c5` on 2026-08-25. It reported zero bugs,
zero rule violations, and marked both prior findings resolved.

For every PR, record the URL, reviewed commit, findings, fixes, and evidence-backed disagreements
before merge.
