<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Skills Manager keeps an approved Patch while an Agent Skill moves between upstream versions">
</p>

<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

Skills Manager helps you install and update Agent Skills without losing the changes you want to keep. A **Patch** is one approved change that Skills Manager keeps across Updates.

> [!IMPORTANT]
> `v0.1.0` is a **Public Preview**. 

## Quick start

Supported runtimes: **Node.js 22 and 24** with **`npx skills >=1.5.19 <2.0.0`**.

```sh
npx skills add Flower-F/skills-manager
```

Start a new Agent session, then ask:

> Find Skills that can review accessibility in my frontend, explain the best candidates, and let me choose before installing anything.

Skills Manager recommends candidates and waits for approval of the exact selection. The underlying package tool handles scope, target Agents, security prompts, and physical installation.

## Keep a change with a Patch

<p align="center">
  <img src="./assets/readme/workflow.svg" width="100%" alt="Discover and approve a Skill, approve a semantic Patch, then keep its outcome through an Update">
</p>

Ask for a durable customization:

> Make this release-notes Skill always check migration notes. Keep that change across Updates.

Skills Manager proposes a readable Patch for approval, then stores the result rather than brittle file edits:

```markdown
---
source: owner/repository
skill: release-notes
scope: project
---

# Active Patches

## Check migration notes

### Outcome

Always check migration notes before drafting release notes.
```

Later, “Update my installed Skills” advances upstream content and preserves every Active Patch. The implementation may adapt to new wording or file layouts, but changing the approved result requires your approval. An already-satisfied Patch remains active so a later release cannot silently remove it.

## Common requests

- **Discover and install:** “Find release automation Skills, recommend the best fit, and let me approve the exact selection.”
- **Create a Patch:** “Always include migration risk in this Skill's review. Propose a Patch first.”
- **Update:** “Update my project Skills and preserve every Active Patch.”
- **One-off edit:** “Make this temporary experiment without a Patch.” Skills Manager first explains that an Update may overwrite it.
- **Conflict:** If two approved results cannot both hold, or upstream changes make one unsafe or ambiguous, Skills Manager explains the concrete Conflict and waits for you.
- **Remove a Patch:** “Remove the ‘Check migration notes’ Patch.” Durable history and tombstones are not retained.
- **Remove an Installation:** Skills Manager shows the exact selection and warns when its final target and Patch document will disappear before asking for approval.
- **Local Skill:** Discovery, installation, listing, and removal remain available, but customizations belong at the local source and do not receive Patch documents.
- **Self-Update:** A customized Skills Manager cannot update itself. An unpatched successful self-Update ends by asking you to start a new Agent session.

## Boundaries

- One Patch document belongs to one exact Installation, identified by upstream source, upstream Skill identifier, and project or global scope. Project and global documents are independent.
- Each document contains only Active Patches with unique readable titles and self-contained outcomes. Optional rationale and constraints appear only when needed.
- Only Active Patches are protected. Skills Manager does not infer or preserve arbitrary manual edits.
- Every Active Patch must hold together; document order creates no precedence.
- Installation and removal selections and every durable Patch meaning change require approval.
- If an upstream mutation fails, times out, or is interrupted after it starts, the operation stops without automatic retry or continued Patch work.
- Distribution is GitHub-only. This project is not an npm package, and `npx skills` 2.x is unsupported during the preview.

## Development and project docs

The distribution has no runtime dependencies, runtime helper, or build step.

```sh
npm test
npm run typecheck
npm run check:distribution
```

[Contributing](CONTRIBUTING.md) · [Release notes](docs/releases/v0.1.0.md) · [Architecture decisions](docs/adr/README.md) · [Security](SECURITY.md) · [Support](SUPPORT.md) · [MIT License](LICENSE)
