# Intents and Customization patches

An **Intent** is one user-approved semantic outcome for one Skill identity in one Installation scope. Record the outcome before editing installed content; the document remains authoritative if application is interrupted.

## Resolve identity and sidecar

Run both project and global public listings:

```sh
npx skills list --json
npx skills list --json --global
```

Use the returned `name`, `path`, `scope`, `source` or `sourceUrl`, `sourceType`, and `agents`. Required fields must be present and well-formed. A same-name project/global pair is ambiguous: ask the user to choose the Installation. A same-name document with another normalized source or upstream Skill name is a different Skill identity; present explicit keep/new/manual-migration choices before changing either document.

Store project documents in `.skills-manager/intents/`. Store global documents in `${XDG_CONFIG_HOME:-~/.config}/skills-manager/intents/`, independent of every Agent runtime directory. Name each file `<source-slug>--<skill-slug>.md`, replacing every run outside letters, digits, `.`, `_`, and `-` with `--`; this lets one Installation ignore malformed documents assigned to other Skills. Bind authority through frontmatter:

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
2. Create the document lazily for the first Intent, or edit the active bullet list. Keep its content exactly within the identity-and-active-outcomes form above.
3. Save the approved Intent before applying it.
4. Edit only the installed `path` returned by public upstream listing. This operation leaves the upstream version unchanged.
5. Verify the installed Skill satisfies every active Intent. Implementation adaptation is allowed when it preserves the same semantic result; weakening, broadening, replacing, or otherwise revising the result requires user approval.
6. When removing an Intent, delete its active bullet. Delete the document when its final active Intent is removed.

Intent mutation is complete when the document contains exactly the approved active outcomes and the selected Installation satisfies each outcome, or when a semantic Conflict has been presented without an Agent-chosen revision.

## Review a Customization patch

Normal invocation takes only the Skill name:

```sh
node <skill-directory>/scripts/customization-patch.mjs <skill-name>
```

Use `--scope project` or `--scope global` only after the helper reports a real cross-scope ambiguity and the user resolves it. The helper reads public upstream listing output, acquires clean upstream content in temporary storage, compares without modifying the Installation, and cleans temporary content on success and failure.

Interpret its three terminal states exactly:

- **No Intent document:** end the semantic branch. Acquire and apply no patch.
- **Active Intents, empty patch:** determine whether clean upstream now fulfills every Intent or application is incomplete. Propose removing an upstream-fulfilled Intent, and remove it only after user confirmation.
- **Non-empty patch:** translate the raw text into ephemeral natural-language Customization evidence. Verify every observed change corresponds to an active Intent and surface unrelated changes.

The patch is best-effort because public upstream metadata may not expose the exact installed revision. Local Skills and missing source metadata have no supported clean-upstream comparison.

Content containing NUL bytes or invalid UTF-8 is reported as a binary difference; its bytes are not decoded into the textual patch.

Review is complete when every active Intent is classified as applied, adapted, upstream-fulfilled, incomplete, or conflicting, and every observed customization is accounted for without persisting evidence or a report.
