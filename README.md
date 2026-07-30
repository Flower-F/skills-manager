<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Skills Manager preserves a user-approved semantic Intent across upstream Agent Skill updates">
</p>

<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

Skills Manager manages Agent Skills through `npx skills` and preserves the behavior you approved when upstream content changes.

> [!IMPORTANT]
> `v0.1.0` is a **Public Preview**. The workflow and Intent format may change.

## Quick start

Supported runtimes: **Node.js 22 and 24** with **`npx skills >=1.5.19 <2.0.0`**.

```sh
npx skills add Flower-F/skills-manager
```

Start a new Agent session, then ask:

> Find Skills that can review accessibility in my frontend, explain the best candidates, and let me choose before installing anything.

## Core experience

<p align="center">
  <img src="./assets/readme/workflow.svg" width="100%" alt="Choose a Skill through npx skills, approve and record a semantic Intent, then reapply and review it after an upstream Update">
</p>

1. **Discover** — describe what you need; the Agent finds and explains relevant Skills.
2. **Install** — approve the exact Skill selection; `npx skills` handles scope, targets, security prompts, and installation.
3. **Customize** — describe the behavior you want; Skills Manager records it as an Intent before editing the installed Skill.
4. **Update** — ask to update; upstream content advances, then every active Intent is reapplied semantically and reviewed.

For example:

> Customize this Installation so it always checks migration notes, and save that outcome as an Intent.

Skills Manager records the desired result—not a brittle textual patch:

```markdown
---
source: owner/repository
skill: release-notes
scope: project
---

# Active Intents

- Always check migration notes before drafting release notes.
```

Later, “Update my installed Skills and preserve every active Intent” updates the upstream Skill and adapts the implementation while keeping that approved outcome. Any semantic change still requires your approval.

## How Managed Updates work

Every Update starts with an **Update preflight** that resolves the exact Installation and validates its Intent document before upstream mutation. If no active Intent exists, a successful upstream package operation is the fast-path completion: no baseline or clean acquisition is created.

For an Installation with active Intents, Skills Manager captures an ephemeral **Intent application baseline** after upstream success and returns a short-lived **Baseline handle**. The Agent reapplies the approved outcomes, reviews the resulting **Intent application patch** as conversational **Intent application evidence**, classifies every Intent, and closes the handle. A behavior already present in that baseline is a **Baseline-satisfied Intent** and remains active. Clean upstream content is acquired only when proposing an **Upstream-fulfilled Intent**, which remains authoritative until you confirm removal.

If an upstream mutation fails, times out, or is interrupted after it starts, Skills Manager reports an **Unknown mutation outcome** and begins any recovery with a new preflight—never an automatic retry. Batch Updates share public listings by scope and optional clean acquisition by normalized source while keeping each Installation's result and Baseline handle independent.

## Boundaries

- `npx skills` remains the sole package manager. Skills Manager adds recommendations, approvals, Intents, and semantic reapplication.
- Project and global Installations keep independent Intent documents.
- Local Skills have no tracked upstream Update.
- Direct Intent mutation captures before editing, records the approved Intent before changing installed content, reviews the attempt, and closes its Baseline handle. Intent removal deletes the active outcome only after the applied behavior has been removed and reviewed.
- A customized Skills Manager self-Update is rejected before mutation; an uncustomized self-Update ends by asking for a new Agent session.
- Distribution is GitHub-only; this project is not published as an npm package, and `npx skills` 2.x is unsupported during the preview.

> [!CAUTION]
> Intent application patches are raw and **not automatically redacted**. They may expose private Skill content in terminal output, Agent conversations, or shared logs. Avoid storing credentials in Skills and review output before sharing it.

## Development and project docs

The implementation has no runtime dependencies or build step.

```sh
npm test
npm run typecheck
npm run check:distribution
```

[Contributing](CONTRIBUTING.md) · [Release notes](docs/releases/v0.1.0.md) · [Architecture decisions](docs/adr/README.md) · [Security](SECURITY.md) · [Support](SUPPORT.md) · [MIT License](LICENSE)
