# Discovery, installation, and listing

Use only public, unversioned `npx skills` commands. Upstream owns scope, target Agents, physical locations, topology, security prompts, and telemetry behavior.

## Discover by need

1. Run `npx skills find <need>` and explain the returned candidates from search metadata.
2. Recommend the candidates that directly meet the stated need and label the remainder optional. Base recommendations exclusively on search metadata; load candidate instructions only after the upstream installation and security flow completes.
3. Present the exact Skill selection with the platform's Agent-native choice interface. When it is unavailable, present a concise numbered Markdown choice.
4. Obtain approval for the exact selection, then invoke one `npx skills add <source> --skill <name> ...` operation. Leave scope, Agent, security, topology, and telemetry choices to the upstream interaction.

Need-driven installation is complete when the approved Skills appear in `npx skills list` for the user-selected scope and targets.

## Curate a supplied source

1. Run `npx skills add <source> --list`.
2. Explain which Skills match the user's goal, separating recommendations from optional candidates.
3. Obtain approval through the same Agent-native selection step, then pass every approved `--skill` value in one upstream `add` operation.

Source-driven installation is complete when public upstream listing shows every approved Skill. If `find`, `add --list`, `add`, or `list` is unavailable or incompatible, stop clearly at that public boundary and report the missing public capability.

## List and Local Skills

- Use `npx skills list` for people and `npx skills list --json` only when machine-readable Installation identity is required.
- Local sources follow ordinary upstream discovery, installation, listing, and removal. They are user-maintained at their local source, so Skills Manager offers no semantic upstream Update for them.

Listing is complete when the upstream result has been explained without inferring undisclosed runtime directories or copies.
