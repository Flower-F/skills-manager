---
status: superseded by ADR-0017
---

# Self-update completes before a new session

`skills-manager` may update or customize its own Skill identity through the normal isolated staging, validation, review, and publication workflow. The current Agent already loaded the old `SKILL.md`, and the publishing CLI process already loaded the code needed to finish its operation, so this does not by itself prevent complete replacement.

A successful self-publication returns `restart_required`. The Agent stops all further `skills-manager` operations and asks the user to open a new session, where the new instructions will be loaded. It does not attempt to exercise new behavior from the old instruction context.

If the platform refuses replacement of in-use files, publication returns `failed` and preserves the old Rendering. The first version does not add a separate bootstrap updater solely for this case.
