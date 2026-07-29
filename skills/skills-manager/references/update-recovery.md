# Update and recover managed Skills

Use Update for one explicit installation scope. It verifies the recorded Rendering, fetches latest upstream, reapplies Effective Intents, validates the result, and publishes only after review.

## Update

Project scope is the default:

```sh
node <skill-directory>/scripts/skills-manager.mjs update --skill <installed-skill> --runtime <runtime-id>
```

Select a global installation explicitly:

```sh
node <skill-directory>/scripts/skills-manager.mjs update --skill <installed-skill> --runtime <runtime-id> --scope global
```

Route the result:

- `complete` with `data.noChange`: The selected Rendering, upstream revision, and Effective Intents already agree. Update is complete without publication.
- Terminal status with `data.recovered`: Interrupted publication was healed from a complete desired copy. Every managed target now matches `data.renderedHash`.
- `ready` with `data.nextAction: "work_order"`: Load [intents.md](intents.md), request the work order, and return every Effective-Intent result.
- `needs_confirmation` with semantic result `not_required`: Review the bare-upstream total diff and publish the exact candidate after approval.
- Security `needs_confirmation`: Load [inspect-install.md](inspect-install.md#discover-and-assess), explain the normalized risk, and resume that exact work directory through the documented risk-confirmation command.
- `conflict` with `untracked_change`: Route to Archaeology below.
- `failed`: Report the integrity or technical failure and end the attempt.

If interrupted state has no complete desired copy, Update automatically returns a normal reviewed candidate whose `data.operation.recovery` is `regeneration_required`. It is rebuilt from latest upstream plus Effective Intents; there is no separate resume registry or `regenerate` confirmation command.

Update is complete at `data.noChange`, a recovered terminal status, or successful `publish`; every selected-scope target then matches managed state.

## Recover an Untracked change through Archaeology

For `untracked_change`, explain that installed bytes have no recorded semantic Intent and ask whether the user authored them. Record declined ownership without fetching or mutation:

```sh
node <skill-directory>/scripts/skills-manager.mjs archaeology --skill <installed-skill> --runtime <runtime-id> --decline-ownership
```

Confirmed ownership starts comparison with latest upstream:

```sh
node <skill-directory>/scripts/skills-manager.mjs archaeology --skill <installed-skill> --runtime <runtime-id> --confirm-ownership
node <skill-directory>/scripts/skills-manager.mjs archaeology-work-order --work-dir <work-directory>
```

Compare every read-only `untrackedRenderings` entry with `latestUpstream.root`. Derive concise semantic outcomes and report every proposal independently:

```sh
node <skill-directory>/scripts/skills-manager.mjs archaeology-result --work-dir <work-directory> --proposals '[{"id":"candidate-1","text":"<semantic-outcome>","status":"candidate"}]'
```

Use `uncertain` or `contradictory` with a concise summary when interpretation is unsafe. Present each `candidate`; after individual approval, record only those ids:

```sh
node <skill-directory>/scripts/skills-manager.mjs archaeology-approve --work-dir <work-directory> --approved-ids '["candidate-1"]'
```

Load [intents.md](intents.md) for the returned Effective-Intent work order. Archaeology is complete only after `publish` returns `complete` and reconciles every target and managed hash, or declined ownership returns `complete` with the installed content unchanged.

## Update Skills Manager itself

Use the same scoped Update command with `--skill skills-manager`. Security assessment, Effective Intents, structural validation, diff review, and complete publication remain identical to another managed Skill.

A manager re-publication—including an Intent mutation or interrupted-publication recovery—returns `restart_required` after committing its Rendering and durable state. End the current workflow immediately and ask the user to start a new Agent session before any further manager command.
