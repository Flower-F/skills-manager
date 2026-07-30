---
status: accepted
---

# Delegate package management to npx skills

`npx skills` is the sole package manager and owns discovery, installation scope, target Agents, physical paths and topology, security and telemetry policy, upstream package operations, removal, and installation metadata. Skills Manager is an Agent-facing documented workflow that adds need-aware recommendations, Markdown Intent documents, semantic Intent application, Update preflight, and attempt-local review while depending only on public `npx skills` commands and machine output; it does not pin an exact upstream version, copy the Agent registry, or maintain a competing orchestration CLI.

Intent documents are lazy sidecars bound to upstream Skill identity and one Installation scope. Project and global documents are independent and contain only active user-approved outcomes; Intent application evidence and Update summaries remain in the current conversation, Upstream-fulfilled Intents are removed only after confirmation, and semantic changes always return to the user. Package management is coordinated once by the main Agent, after which independent Intent applications may run in parallel subagents and complete or fail per Installation.

Intent application edits the installed Skill in place after `npx skills` acts. An ephemeral Intent application baseline and Baseline handle bound review to the current Managed workflow attempt; optional clean acquisition exists only to verify a proposed Upstream-fulfilled Intent. Skills Manager provides no candidate publication, generic validation gate, rollback, copy-topology synchronization, historical inspection, or recovery for operations performed outside a Manager-guided workflow; local sources and explicit independent-copy behavior follow `npx skills` without additional management.

Managed removal deletes its Intent document when the last target disappears. Skills Manager self-Update runs Update preflight, rejects an Installation with active Intents before mutation, and otherwise uses `npx skills update skills-manager` before requiring a new Agent session. Upstream content remains data rather than management authority, but installation security and telemetry decisions remain with `npx skills` and the user's environment.

This decision supersedes ADR-0001 through ADR-0014 and ADR-0016. ADR-0015 remains in force for the small native Node ESM helper scripts.
