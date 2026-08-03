# Patches

A **Patch** is one user-approved result that Skills Manager keeps across Updates. It describes what must remain true, not the files, wording, or edits used to make it true. Only Active Patches receive this preservation guarantee; unrecorded manual edits do not.

## Resolve the Installation and document

Read both project and global Installation listings when identity or scope must be resolved:

```sh
npx skills list --json
npx skills list --json --global
```

Select exactly one Installation by its normalized upstream source, upstream Skill identifier, and Installation scope. A display name, target-Agent label, or physical path is not identity. If a same-named project/global pair is ambiguous, ask the user to choose. If listing data is incomplete or the matching Patch document is unreadable or identity-inconsistent, stop without changing upstream content or durable state.

Project documents live in `.skills-manager/patches/`. Global documents live in `${XDG_CONFIG_HOME:-~/.config}/skills-manager/patches/`. The two scopes are independent. Name each file `<source-slug>--<skill-slug>.md`: normalize a GitHub source to lowercase `owner/repository`, removing URL syntax and `.git`; in each component retain ASCII letters, digits, `.`, and `_`, and encode every other UTF-8 byte as `-HH` with uppercase hexadecimal. Frontmatter remains authoritative:

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

### Rationale

Missing a migration note can make a release announcement unsafe.

### Constraints

Mention every breaking migration before non-breaking improvements.
```

One document belongs to one Installation and contains only its Active Patch set. Every Patch has a document-local unique readable title and a self-contained `Outcome`. Include `Rationale` or `Constraints` only when needed for faithful future application. Do not store opaque IDs, paths, diffs, hashes, statuses, ordering rules, retired entries, history, transcripts, or execution state.

## Customize

1. For an ordinary customization request, propose a Patch with a title and outcome. Add rationale or constraints only when they materially limit faithful implementation.
2. Obtain approval for the Patch meaning before writing it. Create the document lazily or add the approved section to the existing Active Patch set.
3. Modify the selected Installation so every Active Patch is satisfied together. Document order gives no Patch precedence.
4. Use normal task-completion judgment to inspect and verify the result. Report what now holds conversationally; do not generate or persist a raw application diff.

Implementation details may change freely while the approved outcome, rationale, and constraints remain intact. If an Active Patch is already satisfied, leave it active and make no unnecessary edit. Do not acquire a second upstream copy merely to decide where that behavior originated.

If the request is ambiguous, contradicts another Active Patch, or cannot be preserved safely, explain the concrete **Conflict** and wait for the user. Do not choose a winner, weaken the Patch, remove it, or introduce a pending, disabled, outdated, or conflict status.

## Change or remove a Patch

Treat any change to a Patch title, outcome, rationale, or constraints as durable semantic meaning and obtain approval before saving it. After approval, update the document and make the current Installation satisfy the full Active Patch set.

For removal, present the readable Patch title and obtain approval before removing its section. Handle the user's requested current behavior in context. Delete the document when its final Patch is removed. Do not create history or tombstones, and do not promise that removing the document alone reverses every prior implementation detail.

## One-off unmanaged edits

When the user explicitly asks for a one-off edit without a Patch, explain before editing that a later Update may overwrite it. Make the edit only after that choice is clear. Do not record, import, preserve, reconcile, or clean up arbitrary manual differences.

Patch work is complete when the document contains exactly the approved Active Patch set and the Installation satisfies all of it, or when a concrete Conflict has been returned without silently changing durable meaning.
