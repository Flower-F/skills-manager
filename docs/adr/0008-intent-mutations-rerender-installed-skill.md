---
status: superseded by ADR-0017
---

# Intent mutations rerender the installed skill

Creating, updating, deleting, disabling, or suppressing an Intent is incomplete until the installed Rendering has been regenerated from upstream content plus the new Effective intents, validated, reviewed, and published.

Candidate Intent state and candidate Rendering are prepared together outside the published skill. Cancellation changes neither. After acceptance, authoritative Intent state is saved before the complete Rendering is published; if publication is interrupted, the next inspection detects the Intent/rendered-hash mismatch and regenerates the replaceable Rendering.

Removing an Intent must rebuild from clean upstream content and the remaining Effective intents. It must not attempt to reverse guessed textual edits in the current Rendering.

The clean baseline is always the latest upstream content fetched through `npx skills`. The system does not retain a pristine copy of the previously installed upstream revision. Intent mutation therefore may also advance upstream and uses the same security, validation, and review gates as Update.

Review shows the total diff from the current Rendering to the candidate and the Intent overlay from latest upstream to the candidate. Without the previous pristine upstream, the CLI does not claim to isolate an exact upstream-only diff.
