---
status: accepted
---

# Resolve Update identity before mutation

Every Update begins with non-mutating inspection of both Installation scopes. Skills Manager resolves the exact upstream source, upstream Skill identifier, and scope, then validates any matching Patch document before `npx skills update` may run. A failed listing, ambiguous identity, unreadable document, or frontmatter mismatch blocks mutation.

This read-availability dependency prevents an Installation from losing upstream content before Skills Manager discovers that it cannot identify or understand the durable Active Patch set it must preserve. Physical paths and target-Agent labels help locate current content but never define Patch ownership.

If an upstream mutation later fails, times out, or is interrupted, the current operation stops without automatic retry or further Patch work. A later user-requested Update begins from a fresh view of current state.
