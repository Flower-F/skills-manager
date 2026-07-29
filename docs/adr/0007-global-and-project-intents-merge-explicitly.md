---
status: superseded by ADR-0017
---

# Global and project Intents merge explicitly

Effective intents for one Skill identity are the union of active global and project Intents, minus global Intent ids explicitly suppressed by the project. Project scope has no implicit precedence over global scope.

The CLI returns `conflict` when the same Intent id has different content across scopes. The Agent also reports a conflict when distinct ids express contradictory requirements. The user resolves the conflict by changing or disabling a project Intent, or by recording the rejected global id in the project's `suppressedGlobalIntents` list.

Suppression is durable, project-specific user-approved state. It prevents repeated questions without silently changing the user's global preference in other projects.
