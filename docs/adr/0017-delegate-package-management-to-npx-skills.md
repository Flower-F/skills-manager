---
status: accepted
---

# Delegate package management to npx skills

`npx skills` is the sole package manager and owns discovery, installation scope, target Agents, physical paths and topology, security and telemetry policy, upstream package operations, removal, and installation metadata. Skills Manager is Agent-facing guidance that adds need-aware recommendations and preserves user-approved semantic Patches without pinning an exact upstream version, copying the Agent registry, or maintaining a competing orchestration CLI.

Patch documents are lazy sidecars bound to upstream Skill identity and one Installation scope. Project and global documents are independent and contain only Active Patches. The Agent resolves the exact Installation and readable Patch document before an Update mutates upstream content, then uses ordinary task-completion judgment to preserve every approved result. Package mutation is coordinated by the main Agent; subsequent work and outcomes remain independent per Installation.

Skills Manager provides no package-command wrapper, candidate publication layer, runtime service, generic validation gate, rollback system, copy-topology synchronization, historical report, or automatic retry after an uncertain mutation. Local sources and explicit independent-copy behavior follow `npx skills`; Local Skill changes remain at their user-owned source.

Managed removal deletes a Patch document when the Installation's last target disappears. Skills Manager self-Update rejects an Installation with Active Patches before mutation and otherwise uses the ordinary package Update before requiring a new Agent session. Installed upstream content remains untrusted data rather than management authority.

This decision supersedes ADR-0001 through ADR-0014 and ADR-0016. ADR-0015 remains in force for native repository checks.
