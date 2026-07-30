# Contributing to Skills Manager

Skills Manager is a maintainer-led project. Flower-F retains final authority over scope, design, merge, and release decisions. Contributions are welcome, but acceptance is not guaranteed.

## Before opening a pull request

Small bug fixes, documentation improvements, and narrow compatibility fixes may be submitted directly. Open a GitHub Issue and agree on the direction before investing in a new feature, domain-model change, or breaking behavior. GitHub Issues are the authoritative public backlog; local Agent planning under `.scratch/` is disposable execution state and is never synchronized back to Issues.

Use [Support](SUPPORT.md) for routing questions and upstream defects. Report vulnerabilities privately as described in [Security](SECURITY.md), and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Requirements:

- Node.js 22 or 24
- Git
- `npx skills` in the supported `>=1.5.19 <2.0.0` range

Install any contributor Skills you personally use into `.agents/` with the public `npx skills` interface. For example, inspect a source before choosing individual tools:

```sh
npx skills add <source> --list
npx skills add <source> --skill <skill-name>
```

Contributor Skills, `skills-lock.json`, and `.scratch/` are intentionally ignored. They can be recreated locally without being redistributed as Skills Manager product content.

## Required checks

Before submitting:

```sh
npm test
npm run typecheck
npm run check:distribution
```

Pull requests also run clean-checkout installation smoke tests, Node 22/24 checks, Markdown link and repository-policy validation, and DCO sign-off validation. Do not add runtime dependencies or a build step.

## Developer Certificate of Origin

Every commit must be signed off under the [Developer Certificate of Origin 1.1](https://developercertificate.org/):

```sh
git commit --signoff
```

The sign-off certifies that you have the right to submit the contribution under this project's license. This project does not require a CLA, copyright assignment, or transfer of ownership.

## Review and support

Keep changes focused and explain user-visible behavior and migration impact. Ordinary support and review are best effort, with no response or resolution SLA. See [Changelog](CHANGELOG.md) for Public Preview compatibility expectations.
