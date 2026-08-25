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
| [1](https://github.com/karan68/ProjectionWitness/pull/1) | Foundation, toolchain, CI, and versions | Two valid findings on `d28215d` | Remediated; awaiting review of the follow-up commit |

### PR 1 findings

1. **High: npm 10.9.8 bundled vulnerable `tar` 7.5.11.** Accepted. The project now pins npm
  `10.9.9`, whose installed package was inspected and contains `tar` 7.5.22. CI installs and
  asserts the exact npm version before `npm ci`. A clean local install and production audit pass.
2. **Medium: `ubuntu-latest` is a moving CI target.** Accepted. CI now pins `ubuntu-24.04`.

The follow-up commit must receive a new Qodo review before PR 1 is merged. This file will record
that reviewed commit and final result after the push-triggered review completes.

For every PR, record the URL, reviewed commit, findings, fixes, and evidence-backed disagreements
before merge.
