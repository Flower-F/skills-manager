# Architecture decision records

Read the current decisions first. Superseded records are retained only to explain the design history and must not be treated as current product behavior.

## Current

- [ADR-0015: Use native Node ESM without a build step](0015-use-native-node-esm.md) — the helper uses native ESM, has no build step or runtime dependencies, and supports Node 22 and later.
- [ADR-0017: Delegate package management to npx skills](0017-delegate-package-management-to-npx-skills.md) — `npx skills` remains the implementation boundary for package management.
- [ADR-0018: Resolve Update identity before mutation](0018-resolve-update-before-mutation.md) — every Update resolves its exact Installation and Patch document before upstream mutation.
- [ADR-0020: Replace Intents with semantic Patches](0020-replace-intents-with-semantic-patches.md) — the product is rewritten around a small capability-and-boundary contract with no legacy Intent compatibility.

## Superseded by ADR-0020

- [ADR-0019: Review attempt-local Intent application](0019-review-attempt-local-intent-application.md)

## Superseded by ADR-0017

- [ADR-0001: Publish only complete skill updates](0001-publish-only-complete-updates.md)
- [ADR-0002: Single CLI owns the managed skill workflow](0002-single-cli-owns-managed-workflow.md)
- [ADR-0003: CLI owns the security assessment boundary](0003-cli-owns-security-assessment.md)
- [ADR-0004: Copy targets are eventually consistent](0004-copy-targets-are-eventually-consistent.md)
- [ADR-0005: User resolves semantic state conflicts](0005-user-resolves-semantic-conflicts.md)
- [ADR-0006: Intents bind to upstream skill identity](0006-intents-bind-to-source-identity.md)
- [ADR-0007: Global and project Intents merge explicitly](0007-global-and-project-intents-merge-explicitly.md)
- [ADR-0008: Intent mutations rerender the installed skill](0008-intent-mutations-rerender-installed-skill.md)
- [ADR-0009: Project Intents require project Renderings](0009-project-intents-require-project-renderings.md)
- [ADR-0010: Self-update completes before a new session](0010-self-update-requires-a-new-session.md)
- [ADR-0011: Upstream skill content remains untrusted data](0011-upstream-content-remains-untrusted.md)
- [ADR-0012: Publish merges one upstream lock entry](0012-publish-merges-one-upstream-lock-entry.md)
- [ADR-0013: Do not persist operation reports](0013-no-persistent-operation-reports.md)
- [ADR-0014: Disable upstream skills telemetry](0014-disable-upstream-telemetry.md)
- [ADR-0016: Limit recovery to process interruption](0016-limit-recovery-to-process-interruption.md)
