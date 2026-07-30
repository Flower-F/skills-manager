# Changelog

All notable changes to Skills Manager are documented here.

## [0.1.0] - 2026-07-30

Initial public release as a Public Preview.

- Need-aware Skill discovery and installation guidance.
- Scope-specific Markdown Intent documents for approved customizations.
- Mandatory Update preflight before direct upstream mutation, including the no-Intent fast path and Unknown mutation outcome recovery.
- Attempt-local Intent application baselines with independent Baseline handles, bounded patch/evidence review, repeatable review, and explicit close.
- Intent addition, editing, and removal ordering that keeps the Intent document authoritative at every interruption boundary.
- Optional Upstream-fulfilled Intent verification acquired only on demand, with Baseline-satisfied Intents retained by default.
- Batch Update reads shared by Installation scope and clean acquisition shared by normalized source without coupling outcomes.
- Customized Skills Manager self-Update rejection before mutation.
- Raw Intent application patches are not automatically redacted and may expose private Skill content in terminal output, Agent conversations, or shared logs.
- Clean-checkout compatibility checks for Node.js 22 and 24 and `npx skills` 1.x.

[0.1.0]: https://github.com/Flower-F/skills-manager/releases/tag/v0.1.0
