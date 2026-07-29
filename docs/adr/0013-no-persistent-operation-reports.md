---
status: superseded by ADR-0017
---

# Do not persist operation reports

The first version does not create `.skills/reports/` or any other permanent prose report for installs, updates, or Intent mutations. The CLI returns the current operation's normalized security summary, per-Intent result statuses, validation result, and diff for immediate review.

Durable state is limited to authoritative Intents, upstream and rendered hashes, installation topology, location caches, and upstream lock metadata. A prose report does not improve recovery and would add generated files, Agent writing work, and another consistency surface.

Historical audit export may be added later as an explicit optional capability; it is not part of the core workflow.
