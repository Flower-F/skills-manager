# Semantic Update

An **Update** advances selected Installations through one upstream package operation, then preserves active Intents through direct semantic application.

## One Installation

1. Run the ordinary upstream command, selecting scope only when needed:

   ```sh
   npx skills update <skill-name>
   npx skills update <skill-name> --project
   npx skills update <skill-name> --global
   ```

2. Resolve the Installation through public listing as described in [Intents](intents.md#resolve-identity-and-sidecar).
3. When no Intent document exists, stop the semantic branch: the Installation is complete after upstream succeeds, and no Intent application baseline is captured.
4. With active Intents, capture an Intent application baseline, reapply every outcome directly to installed content, and review against the returned Baseline handle as described in [Intents](intents.md#mutate-and-apply). Adapt implementation freely while preserving semantics; return any semantic revision or Conflict to the user.
5. Close the Baseline handle after completion, Conflict, or cancellation.
6. Report the upstream result and each applied, adapted, fulfilled, incomplete, or conflicting Intent as a conversational semantic Update summary framed as performed semantic work rather than an exact historical before/after diff.

An Installation Update is complete after upstream success plus classification of every active Intent and customization. An interruption may leave upstream content installed; recover by rerunning this Installation's Update.

## Multiple Installations

1. The main Agent invokes one `npx skills update <skill...>` package operation for the full user-approved selection.
2. Use public listing to separate no-Intent Installations, which complete immediately, from customized Installations.
3. When concurrency is available, assign at most one subagent to each customized Installation. Give it only that Installation identity, path, and Intent document. Semantic subagents capture, edit, review, close, and return one per-Installation summary; package operations remain with the main Agent.
4. Retain each successful Installation when another conflicts, fails, or is interrupted. Report partial success and name only incomplete Installations for user action or targeted retry.

A batch Update is complete when every Installation is either complete by its own criterion or explicitly reported as incomplete. Recovery reruns only affected Installations; successful work stays in place.
