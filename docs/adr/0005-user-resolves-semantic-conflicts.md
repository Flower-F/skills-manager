# User resolves semantic state conflicts

When an operation would discard, contradict, or ambiguously preserve user-approved semantic state, `skills-manager` returns `conflict` and makes no change. It reports the conflicting state and concrete resolution choices; the Agent explains them and obtains the user's decision before invoking the CLI again with that explicit choice.

There is no default resolution and generic `--yes` cannot bypass a conflict. Deleting an installed skill that still has Intents is the baseline example: the user chooses whether to keep the Intents, permanently delete them too, or cancel.

Conflicts are distinct from technical failures. Network errors, invalid paths, corrupt schemas, and other conditions that user preference cannot resolve return `failed` instead.
