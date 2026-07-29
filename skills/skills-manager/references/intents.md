# Manage customization Intents

An Intent is one concise desired outcome, not conversation history or a textual patch. Intent changes are proposals until terminal publication commits both semantic state and the regenerated Rendering.

## Add and render an Intent

Add a project Intent by default:

```sh
node <skill-directory>/scripts/skills-manager.mjs intent-add --skill <installed-skill> --intent <semantic-outcome> --runtime <runtime-id>
```

Add `--scope global` only for an outcome the user wants inherited by every Rendering of the same normalized Skill identity. If `project_rendering_required` is returned, explain `data.resolutions`: when the user selects `create_project_rendering`, load [inspect-install.md](inspect-install.md#discover-and-assess) and complete normal assessment and installation; use global scope only when the user selects `promote_to_global`. After completing the selected resolution, restart `intent-add` with the resolved scope so it acquires a fresh baseline and actually creates the Intent.

For security `needs_confirmation`, load [inspect-install.md](inspect-install.md#discover-and-assess) and resume that exact attempt through its risk-confirmation command. On `ready`, request the semantic boundary:

```sh
node <skill-directory>/scripts/skills-manager.mjs work-order --work-dir <work-directory>
```

Apply every `data.effectiveIntents` outcome beneath `data.editingBoundary.root`. Return a singular result only when the order contains one Intent:

```sh
node <skill-directory>/scripts/skills-manager.mjs intent-result --work-dir <work-directory> --result <applied-or-adapted> --summary <concise-summary>
```

For multiple outcomes, return exactly one scoped result per Effective Intent:

```sh
node <skill-directory>/scripts/skills-manager.mjs intent-result --work-dir <work-directory> --results '[{"id":"<intent-id>","status":"<applied-or-adapted>","summary":"<optional-summary>"}]'
```

If `changed_file_scope` needs confirmation, explain every added file and record approval with `continue --work-dir <work-directory> --accept-change-scope`. Review both `data.review.totalDiff`, `data.review.materialDiff`, and the semantic outcome before publication.

## Resolve semantic results

When a per-Intent result is `failed`, explain each returned interpretation. The user's decision to revise is recorded before another edit:

```sh
node <skill-directory>/scripts/skills-manager.mjs continue --work-dir <work-directory> --accept-semantic-revision
```

Only the returned `work_order` opens another candidate edit; report the revised result as `adapted`.

When a result is `obsolete`, explain its evidence and returned Intent ownership. Keep the Intent active when the user says the outcome still matters:

```sh
node <skill-directory>/scripts/skills-manager.mjs continue --work-dir <work-directory> --keep-obsolete-intents
```

Expire it with the Agent's explanatory reason only after explicit user selection:

```sh
node <skill-directory>/scripts/skills-manager.mjs continue --work-dir <work-directory> --mark-obsolete-intents
```

The latter returns a work order for the remaining Effective Intents. Complete that exact order before review.

## List and mutate lifecycle state

List authoritative project/global records before choosing an id or scope:

```sh
node <skill-directory>/scripts/skills-manager.mjs intent-list --skill <installed-skill>
```

Listing is complete when the `ready` envelope's project/global records, suppressions, and Effective Intents have been reported and the filesystem remains unchanged.

Use the exact id and owning scope:

```sh
node <skill-directory>/scripts/skills-manager.mjs intent-edit --skill <installed-skill> --intent-id <intent-id> --intent <new-outcome> --runtime <runtime-id>
node <skill-directory>/scripts/skills-manager.mjs intent-disable --skill <installed-skill> --intent-id <intent-id> --runtime <runtime-id>
node <skill-directory>/scripts/skills-manager.mjs intent-enable --skill <installed-skill> --intent-id <intent-id> --runtime <runtime-id>
node <skill-directory>/scripts/skills-manager.mjs intent-obsolete --skill <installed-skill> --intent-id <intent-id> --reason <reason> --runtime <runtime-id>
```

Add `--scope global` for a global owner. Suppress one inherited global Intent only for this project with:

```sh
node <skill-directory>/scripts/skills-manager.mjs intent-suppress --skill <installed-skill> --intent-id <global-intent-id> --runtime <runtime-id>
```

Equal ids with different scoped meaning, ambiguous normalized identities, and contradictory outcomes remain `conflict`. Use only a returned explicit resolution. For `ambiguous_skill_identity`, select the exact source identity:

```sh
node <skill-directory>/scripts/skills-manager.mjs identity-resolve --skill <installed-skill> --source <normalized-source> --upstream-skill <upstream-skill-id> --choice <manage_clean-or-migrate> --runtime <runtime-id>
```

`manage_clean` keeps the verified Rendering without adopting competing Intents. `migrate` performs a fresh semantic rendering, review, and publication before identity ownership changes.

Permanent deletion uses a proposal followed by explicit confirmation:

```sh
node <skill-directory>/scripts/skills-manager.mjs intent-delete --skill <installed-skill> --intent-id <intent-id> --runtime <runtime-id>
node <skill-directory>/scripts/skills-manager.mjs intent-delete --skill <installed-skill> --intent-id <intent-id> --runtime <runtime-id> --confirm-delete
```

Each mutation regenerates from latest upstream. It is durable only when `publish` returns `complete` for another Skill or `restart_required` for Skills Manager itself.
