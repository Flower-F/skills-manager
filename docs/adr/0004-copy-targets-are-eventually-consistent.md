---
status: superseded by ADR-0017
---

# Copy targets are eventually consistent

Managed skills may have multiple independent copy targets when symlinks are unavailable or the user explicitly accepts copy mode. The CLI prepares and validates a complete sibling candidate for every physical target, then replaces targets one directory at a time.

Each individual target is always a complete old or new rendering. The set of copy targets is eventually consistent, not atomically switched as a group. Ordinary errors trigger best-effort restoration of targets already replaced; a process crash may leave complete copies at different versions, which the next inspection or update detects by hash and resynchronizes.

This avoids a persistent cross-directory transaction journal while preserving the safety property that no runtime observes a partially copied skill directory.
