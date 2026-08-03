# Update

An **Update** advances an Installation to current upstream content while preserving its entire Active Patch set.

## One Installation

1. Before upstream mutation, read project and global `npx skills list --json` output, resolve the exact Skill identity and Installation scope, and locate its collision-safe Patch document as defined in [Patches](patches.md). Confirm that any matching document is readable, valid, and identity-consistent. Ambiguity or invalid durable state blocks the Update.
2. Run the ordinary package operation with the resolved scope:

   ```sh
   npx skills update <skill-name> --project
   npx skills update <skill-name> --global
   ```

3. If the command fails, times out, or is interrupted after mutation begins, stop this Update. Explain that the current state is uncertain; do not retry automatically and do not continue Patch work. A later user-requested Update starts from a fresh view of current state.
4. After success, reread the selected Installation. If no Patch document exists, report completion without inventing protection for manual edits.
5. If Active Patches exist, make the updated Installation satisfy all of them simultaneously. Adapt implementation details as needed, but obtain approval before changing any outcome, rationale, or constraint. An already-satisfied Patch remains active without an edit.
6. Use normal task-completion judgment to verify the current Skill, then report the upstream result and any adapted, already-satisfied, or conflicting Patch conversationally. Do not create a named application phase, raw diff, second-source comparison, status record, or recovery journal.

When a Patch is outdated, ambiguous, incompatible with upstream content, or incompatible with another Active Patch, explain the concrete **Conflict** and wait for the user. Leave every approved Patch intact until the user decides.

## Multiple Installations

1. Resolve every selected Installation and readable Patch document before starting shared package mutation. Any unresolved selection blocks mutation for the selection that has not begun.
2. Obtain approval for the exact selection, then let the main Agent coordinate the ordinary upstream package mutation.
3. After shared mutation succeeds, handle each Installation independently. Work may proceed separately, but each worker receives only one exact Installation and its Active Patch set; package mutation remains coordinated by the main Agent.
4. Preserve successful Installations even when another reaches a Conflict. Report each completed Installation and identify only those still waiting for user action.

A batch Update is complete when every selected Installation either satisfies its own Active Patch set or is explicitly reported as a Conflict or incomplete operation. One Installation never rolls back or silently changes another.
