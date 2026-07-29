---
status: superseded by ADR-0017
---

# Project Intents require project Renderings

A project Intent may only affect a project-scoped Rendering. It never mutates a global Rendering shared by other projects. Global Intents may participate in either global or project Renderings.

When a project Intent is requested for a skill that exists only as a global installation, `skills-manager` returns `conflict`. The user chooses whether to create a project-scoped Rendering, promote the Intent to global scope, or cancel. A project Rendering shadows the same Skill identity's global Rendering within that project and applies the project's Effective intents.

This keeps project policy from leaking into unrelated projects while retaining global preferences in project-local installations.
