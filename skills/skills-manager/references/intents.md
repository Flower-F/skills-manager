# Intents and Intent application

An **Intent** is one user-approved semantic outcome for one Skill identity in one Installation scope. Record the outcome before editing installed content; the document remains authoritative if application is interrupted.

## Resolve identity and sidecar

Run both project and global public listings:

```sh
npx skills list --json
npx skills list --json --global
```

Use the returned `name`, `path`, `scope`, `source` or `sourceUrl`, `sourceType`, and `agents`. Required fields must be present and well-formed. A same-name project/global pair is ambiguous: ask the user to choose the Installation. A same-name document with another normalized source or upstream Skill name is a different Skill identity; present explicit keep/new/manual-migration choices before changing either document.

Store project documents in `.skills-manager/intents/`. Store global documents in `${XDG_CONFIG_HOME:-~/.config}/skills-manager/intents/`, independent of every Agent runtime directory. Name each file exactly `<source-slug>--<skill-slug>.md`: normalize the public upstream source as described below; in each identifier retain ASCII letters, digits, `.`, and `_`, and encode every other UTF-8 byte as `-HH` with uppercase hexadecimal. This injective encoding prevents distinct identities from sharing a filename. Exact filename lookup lets one Installation ignore malformed or suffix-colliding documents assigned to other Skills. Bind authority through frontmatter:

```markdown
---
source: owner/repository
skill: example-skill
scope: project
---

# Active Intents

- Preserve the user-approved semantic outcome.
```

Normalize a GitHub source to lowercase `owner/repository`, removing URL syntax and `.git`. Each document contains only `source`, `skill`, and `scope` identity plus active semantic outcomes. Project and global documents are independent; Agent labels are upstream metadata, not paths to scan.

Identity resolution is complete when exactly one public Installation and matching scope-specific document location are selected, or a concrete ambiguity has been returned to the user without mutation.

## Mutate and apply

1. Obtain approval for the semantic outcome.
2. Before changing the Intent document, capture an Intent application baseline for the selected Installation:

   ```sh
   node <skill-directory>/scripts/intent-application.mjs capture \
     --name <skill-name> --source <normalized-source> \
     --scope <project|global> --path <installed-path>
   ```

   Capture refreshes exactly the selected scope through public listing, verifies the expected name, normalized source, scope, and path, then returns stable JSON containing a Baseline handle. If capture fails, leave both the Intent document and Installation unchanged.
3. Create the document lazily for the first Intent, or edit the active bullet list. Save the approved Intent, then modify the Installation. Keep the document exactly within the identity-and-active-outcomes form above.
4. Modify only the selected Installation `path` to satisfy every active Intent. This leaves the upstream version unchanged. Implementation adaptation is allowed when it preserves the same semantic result; weakening, broadening, replacing, or otherwise revising the result requires user approval.
5. Review the Intent application against the same Baseline handle. Translate the machine result into conversational Intent application evidence describing only changes made during the current Managed workflow attempt:

   ```sh
   node <skill-directory>/scripts/intent-application.mjs review \
     --name <skill-name> --source <normalized-source> \
     --scope <project|global> --path <installed-path> \
     --handle <handle-path> --marker <random-marker>
   ```

   A `no_application_change` result has an empty patch and does not authorize Intent deletion. A `review_required` result contains changes that the Agent must account for through every `changedPaths` entry. Binary and invalid UTF-8 changes use bounded size-and-hash `summaries`; ordinary text uses focused local unified hunks.

   A `targeted_review_required` result means oversized text, a bounded diff-alignment or line budget, or the 2 MiB total patch limit withheld detail. The Managed workflow cannot complete until every `targetedReviewPaths` entry is accounted for through targeted inspection. Treat every changed path as covered only when it appears in the patch, a bounded summary, or that targeted-review list.

   Review performs only workflow-integrity checks: the Installation exists, `SKILL.md` is readable UTF-8 with the same Skill identity, every changed symlink remains contained, the handle identity still matches, and every changed path is accounted for. It does not execute upstream scripts, judge Skill quality, validate untouched content, or become a generic Skill validator.

   Review is repeatable: correct any unrelated or incomplete change, then review again against the original baseline. Never present the result as an inventory of historical local customization.
6. Close the Baseline handle after successful completion, a Conflict, or cancellation. Use the matching `--outcome complete|conflict|cancelled` value:

   ```sh
   node <skill-directory>/scripts/intent-application.mjs close \
     --name <skill-name> --source <normalized-source> \
     --scope <project|global> --path <installed-path> \
     --handle <handle-path> --marker <random-marker> --outcome <outcome>
   ```

   Close validates the handle before deleting its temporary baseline. Do not retain a registry, report, rollback copy, or resume state. Abrupt-session residue remains operating-system temporary content.

Intent mutation is complete when the document contains exactly the approved active outcomes and the selected Installation satisfies each outcome, or when a semantic Conflict has been presented without an Agent-chosen revision.

## Remove an Intent

1. Resolve the exact Installation and obtain approval to remove the selected semantic outcome.
2. Capture the current Installation before changing either installed content or active outcomes. The existing Intent document remains authoritative throughout removal review.
3. Remove only the selected Intent's applied behavior from the Installation. Do not edit or delete the Intent document yet; every other active outcome must remain satisfied.
4. Review the removal against the Baseline handle. Account for every changed path and verify that the selected behavior is gone while unrelated behavior and every remaining Intent are preserved.
5. If review finds an unrelated removal, incomplete semantic cleanup, or a Conflict, leave the Intent document unchanged and keep the same Baseline handle available. Correct the Installation and review again. If the Conflict terminates the removal instead of proceeding to correction, close the handle with `--outcome conflict`; on cancellation, leave the Intent authoritative and close with `--outcome cancelled`.
6. Only after successful review, delete the selected outcome from the Intent document. If other active outcomes remain, save the reduced document. If this was the final active outcome, delete the Intent document. This document mutation is the final semantic commit point: interruption before it leaves the old Intent authoritative; interruption after it cannot leave applied customization without authority.
7. Close the Baseline handle with `--outcome complete`. Do not create a tombstone, pending state, or removal history.

Intent removal is complete only after the applied behavior has been removed and reviewed, the authoritative active outcomes have been committed last, and the Baseline handle has been closed.
