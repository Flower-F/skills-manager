# Semantic Update

An **Update** advances selected Installations through one upstream package operation, then preserves active Intents through direct semantic application.

## One Installation

1. Before mutation, run Update preflight. Pass `--scope project|global` only when the user has selected one member of an observed same-name cross-scope pair:

   ```sh
   node <skill-directory>/scripts/intent-application.mjs preflight --name <skill-name>
   node <skill-directory>/scripts/intent-application.mjs preflight --name <skill-name> --scope <project|global>
   ```

   Preflight always reads both project and global public listings, resolves exactly one Installation, and validates its exact scope-specific Intent document. Any failed scope inspection, malformed identity, ambiguity, or malformed matching Intent blocks mutation; do not run an upstream Update.
2. Use the returned scope explicitly in one direct upstream operation. Do not route this command through the helper or another package-command wrapper:

   ```sh
   npx skills update <skill-name> --project
   npx skills update <skill-name> --global
   ```

3. Exit code zero means upstream success. Preserve any upstream warnings and summarize them conversationally without parsing their wording. A non-zero exit, interruption, or platform timeout is an **Unknown mutation outcome**: mark this Installation incomplete, inspect current state through a new preflight before any retry, and never automatically retry the mutation.
4. **No active Intent:** after upstream success, the Installation is complete. Do not capture an Intent application baseline and do not invoke `verify-fulfillment`.
5. **Active Intent:** after upstream success, capture using the preflight snapshot's exact name, normalized source, scope, and path. This selected-scope refresh is the fourth and final ordinary `npx skills` invocation on the normal customized path. Apply every active outcome, review against the returned Baseline handle, classify every Intent, and close the handle after completion, Conflict, or cancellation.
6. A `no_application_change` review means the desired behavior may already exist in the baseline. Classify each such outcome as a **Baseline-satisfied Intent** and let it remain active; an empty Intent application patch never proves an Intent is Upstream-fulfilled.
7. Only when ready to propose a specific Intent as **Upstream-fulfilled**, invoke optional clean verification:

   ```sh
   node <skill-directory>/scripts/intent-application.mjs verify-fulfillment \
     --name <skill-name> --source <normalized-source> \
     --scope <project|global> --path <installed-path>
   ```

   Interpret the temporary clean comparison semantically. Even when it supports the proposal, remove the Intent only after user confirmation. If verification fails, retain every affected Intent, report a warning, and allow an otherwise correct Update to complete.
8. Report the upstream result and each applied, adapted, Baseline-satisfied, Upstream-fulfilled, incomplete, or conflicting Intent as a conversational Update summary framed as performed semantic work rather than an exact historical before/after diff.

A normal customized single-Skill Update uses at most four ordinary `npx skills` invocations before optional fulfillment verification: project preflight listing, global preflight listing, the direct upstream Update, and one selected-scope capture listing.

An Installation Update is complete after upstream success plus classification of every active Intent. An incomplete mutation attempt recovers only through a new preflight and a user-visible decision about whether another direct mutation is appropriate.

## Multiple Installations

1. The main Agent invokes one `npx skills update <skill...>` package operation for the full user-approved selection.
2. Use public listing to separate no-Intent Installations, which complete immediately, from customized Installations.
3. When concurrency is available, assign at most one subagent to each customized Installation. Give it only that Installation identity, path, and Intent document. Semantic subagents capture, edit, review, close, and return one per-Installation summary; package operations remain with the main Agent.
4. Retain each successful Installation when another conflicts, fails, or is interrupted. Report partial success and name only incomplete Installations for user action or targeted retry.

A batch Update is complete when every Installation is either complete by its own criterion or explicitly reported as incomplete. Recovery reruns only affected Installations; successful work stays in place.
