---
status: superseded by ADR-0017
---

# Intents bind to upstream skill identity

An Intent record belongs to a Skill identity composed of normalized upstream source and upstream skill identifier. The installed directory name or display alias is mutable deployment metadata and is not sufficient identity.

Installing a same-named skill from a different source returns `conflict`. The user explicitly chooses whether to migrate the existing Intents to the new identity, manage the new skill without those Intents, or cancel. Migration changes ownership only; the new content still goes through the complete application, validation, and review workflow.

This prevents local semantic customizations from being silently applied to unrelated upstream content that happens to share a folder name.

Intent record filenames use `<sanitized-install-name>__<identity-hash-8>.json`, where the suffix is the first eight hexadecimal characters of SHA-256 over the normalized source and upstream skill identifier separated by a NUL byte. The suffix prevents same-name collisions; the complete identity inside the JSON remains authoritative, and callers never derive identity from the filename.
