# Remove a managed Skill

Removal is scope-explicit. Preview the exact project or global installation before any mutation:

```sh
node <skill-directory>/scripts/skills-manager.mjs remove --skill <installed-skill> --runtime <runtime-id> --scope <project-or-global>
```

Explain the returned identity, physical targets, active and retained Intents, project suppressions, inherited global Intents, and installation in the other scope.

- If Intent state remains, ask the user to select `retain_intents` or `delete_intents`; map it to `--intent-policy retain` or `--intent-policy delete`.
- If project removal exposes another scoped installation, obtain the separate `expose_other_scope` decision and add `--confirm-exposure` only after approval.
- Ambiguous identity routes through the returned scope-aware `identity-resolve` command described in [intents.md](intents.md).
- A recorded project Untracked change routes through Archaeology in [update-recovery.md](update-recovery.md). Global drift, changed topology links, and unrecorded extra copies must be reconciled before removal can proceed.

After the user confirms the final preview, rerun removal with `--confirm-removal`, the preview's exact `--source`, `--upstream-skill`, `--confirmation-token`, and any selected Intent/exposure options. The token binds approval to the reviewed semantic state, other-scope exposure, topology, and lock entry; a changed preview requires fresh confirmation.

The CLI delegates the base artifact to the pinned upstream adapter, then reconciles recorded targets, managed state, and the single lock entry. Removal is complete only when the latest envelope is terminal `complete`, the selected-scope Rendering is absent, and installations in every other scope still resolve as reported.
