---
status: superseded by ADR-0017
---

# Single CLI owns the managed skill workflow

Use one `skills-manager` CLI as the deterministic execution boundary for managed skill operations. It owns runtime mapping, repository and symlink inspection, `npx skills` argument planning, temporary staging, structural validation, complete publication, and abort, and reports structured states to the Agent.

Keep `SKILL.md` thin: it selects and explains workflows, performs semantic interpretation of user-approved Intents, and obtains confirmations that cannot be derived mechanically. The user remains the authority for security exceptions, Untracked change classification, semantic relocation or scope expansion, copy fallback, and final publication.

Update attempts are intentionally disposable. Their working state lives in a securely created operating-system temporary directory; interruption or cleanup means downloading and applying again, not resuming. Durable state is limited to Intents, final hashes, and necessary installation metadata.

`begin` returns the absolute temporary `workDir`; every later command receives that path explicitly. There is no transaction id or registry. A manifest inside the directory is the only process state, and the CLI rejects a work directory unless its resolved path is below the OS temporary root and its manifest schema and nonce are valid.

This adopts Impeccable's separation between canonical agent-facing guidance and deterministic tooling, but not its in-place update algorithm. The CLI must preserve the previous published rendering until a complete candidate has been accepted, copied to a short-lived sibling directory on the target filesystem, revalidated, and published as a whole.
