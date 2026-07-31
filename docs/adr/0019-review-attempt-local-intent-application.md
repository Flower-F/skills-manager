---
status: superseded by ADR-0020
---

# Review attempt-local Intent application

Capture an ephemeral Intent application baseline immediately before modifying an Installation, and compare the final Installation with that baseline through a short-lived `capture → review → close` handle. The resulting Intent application patch and evidence describe only changes made in the current Managed workflow attempt; they do not inventory historical local differences from clean upstream. Acquire clean upstream content only when needed to verify an Upstream-fulfilled Intent, sharing ordinary baseline reads by scope and clean acquisition by normalized source while keeping every Installation result independent.

This refines ADR-0017's original review model without adding publication, rollback, resumable workflow state, a package-command wrapper, or historical cleanup. Intent removal deletes its authoritative outcome only after the applied behavior has been removed and reviewed. A Skills Manager self-Update is rejected while its own Installation has active Intents rather than introducing cross-session reconciliation state.
