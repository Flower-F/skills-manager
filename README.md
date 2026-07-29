# skills-manager

A unified Agent skill for managing other skills. It delegates upstream discovery, download, installation, and removal to `npx skills`, while preserving user-approved local customizations across upstream updates.

## Core model

Local customizations are stored as outcome-oriented Intents rather than textual patches:

```json
{
  "id": "no-auto-commit",
  "intent": "Do not commit automatically; I will commit changes myself."
}
```

Every install, update, or Intent mutation builds a candidate in the operating system's temporary directory:

```text
latest upstream
→ apply Effective intents
→ validate structure and path containment
→ user reviews the diff
→ publish a complete Rendering to runtime directories
```

The previous valid Rendering remains published until the user accepts the candidate. Temporary work is disposable; if it disappears, the workflow downloads and builds again rather than resuming a persistent transaction.

Global and project Intent records are isolated by scope and bound to normalized upstream identity, not installation name. A project Rendering applies their explicit union; a project can suppress an inherited global Intent without rewriting global state. Identity ambiguity or contradictory scoped semantics pauses as a user-visible conflict instead of choosing hidden precedence.

## Boundaries

- One native Node ESM CLI owns paths, runtime mapping, symlink/copy topology, hashes, upstream lock integration, security gates, and publication.
- `SKILL.md` owns semantic interpretation, explanations, and user confirmation.
- Upstream content always remains untrusted data; its scripts and suggested commands are never executed during management.
- The CLI normalizes Gen, Socket, and Snyk assessments. Medium-or-higher risk, Socket alerts, missing data, or request failures require user confirmation.
- Every copy directory remains complete; a set of independent copies is eventually consistent.
- The first version has no persistent operation reports, pristine upstream archive, third-party runtime dependency, or build step.

## CLI

The distributable Skill lives under [`skills/skills-manager/`](./skills/skills-manager/) with a thin routing `SKILL.md`, branch-specific `references/`, Agent metadata, and bundled CLI scripts. Its first read-only command inspects the current installation topology:

```sh
skills-manager inspect --runtime codex
skills-manager inspect --runtime claude-code --scope global
```

`--runtime` identifies the caller's active Agent runtime. Project scope is the default; global scope must be explicit. The supported runtime registry is versioned against `skills@1.5.20` and currently contains `amp`, `antigravity`, `claude-code`, `cline`, `codebuddy`, `codex`, `command-code`, `cursor`, `droid`, `gemini-cli`, `github-copilot`, `kiro-cli`, `neovate`, `opencode`, `openhands`, `pi`, `qoder`, `roo`, `windsurf`, and `zencoder`.

Installation and Update use the same explicit scope rule:

```sh
skills-manager assess --source owner/repository --skill example --runtime codex --scope global
skills-manager update --skill example --runtime codex --scope global
```

Every invocation writes one JSON object to standard output. Successful inspection uses this envelope:

```json
{
  "version": 1,
  "status": "ready",
  "command": "inspect",
  "data": {
    "repositoryRoot": "/absolute/project/path",
    "scope": "project",
    "currentRuntime": "codex",
    "compatibility": {
      "node": { "minimumMajor": 22, "current": "22.0.0" },
      "skillsCli": { "version": "1.5.20", "telemetryDisabled": true },
      "runtimeRegistry": 1
    },
    "topology": "empty",
    "runtimes": [
      {
        "id": "codex",
        "skillsDirectory": "/absolute/project/path/.agents/skills",
        "relativeSkillsDirectory": ".agents/skills",
        "evidence": ["current_runtime"],
        "target": 0
      }
    ],
    "targets": [
      {
        "path": "/absolute/project/path/.agents/skills",
        "relativePath": ".agents/skills",
        "kind": "missing",
        "role": "planned",
        "runtimes": ["codex"]
      }
    ]
  }
}
```

Technical failures use `status: "failed"`, include `error.code` and `error.message`, and exit nonzero. Inspection never creates or rewrites runtime or skill directories and launches no subprocesses, so telemetry is off by default; the compatibility result records that policy for later managed upstream workflows.

The CLI status is also the Agent control-flow protocol: `ready` selects a documented next action, `needs_confirmation` waits for explicit user approval, `conflict` exposes only safe resolutions, `work_order` authorizes bounded candidate editing, `complete` ends the operation, and `failed` stops it. `restart_required` is the successful terminal publication status for any Skills Manager re-publication; the Agent must stop and restart before issuing another management command.

Node 22 or newer is required. From this repository, run `npm test` for the black-box suite and `npm run typecheck` for syntax checks.

## Agent workflow

The bundled `SKILL.md` routes inspection, discovery, assessment, installation, Intent management, update, Archaeology, removal, interrupted-publication recovery, and self-update through the one CLI seam. Agents must not infer topology or edit manager-owned JSON and Renderings directly:

- [Domain language](./CONTEXT.md)
- [Implementation spec](./.scratch/skills-manager/spec.md)
- [Architecture decisions](./docs/adr/)

Before running a bare `npx skills update`, existing manual modifications must go through Archaeology. A bare update destroys the local difference needed to recover their Intents.

Archaeology pauses on an unexplained Rendering hash, asks the user to confirm authorship, compares every changed physical Rendering with latest upstream, and records only individually approved semantic outcomes. Recovery regenerates all copies from upstream plus approved Intents; it never preserves unknown workspace bytes as a patch.

Managed removal is scope-explicit and previewed before mutation. It surfaces durable Intents, project suppressions, inherited exposure, and installations in the other scope; confirmed removal delegates to `skills@1.5.20` and reconciles every recorded Rendering, managed-state entry, and upstream lock entry only after filesystem removal succeeds.

Interrupted publication recovery uses the durable desired-Rendering hash rather than a transaction registry. A later update heals each independent copy as a complete directory from any complete desired copy; if none exists it automatically regenerates from latest upstream and Effective Intents, while any third unexplained hash stops as an Untracked change.

Updating the managed `skills-manager` installation follows the same pinned-upstream acquisition, security gate, validation, review, and complete-publication workflow as any other Skill. A successful re-publication returns `restart_required`; callers must end the current Agent workflow so old and new manager instructions are never mixed.
