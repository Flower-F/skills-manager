---
status: accepted
---

# Replace Intents with semantic Patches

Skills Manager will be rewritten around user-approved semantic Patches: it manages Agent Skills and preserves the results users want across updates, while implementation details such as the underlying package command stay outside the user-facing model. The distributed Skill will state capabilities and boundaries rather than prescribe an application-review state machine; it retains identity resolution before mutation, user approval, per-Installation ownership, independent project and global Patches, and user resolution when a Patch cannot be preserved safely. Because the existing release is an effectively unused public preview, the old Intent format, baseline/review protocol, and compatibility or migration paths will be removed instead of carried forward.
