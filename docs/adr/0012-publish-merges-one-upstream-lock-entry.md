---
status: superseded by ADR-0017
---

# Publish merges one upstream lock entry

Because `npx skills` runs inside the disposable operating-system work directory, the lock file it creates is also temporary. Publication extracts only the target Skill identity's entry and merges it into the lock file for the actual installation scope. It never copies the complete staging lock file, which could overwrite unrelated installed-skill metadata.

The upstream `computedHash` remains the hash of pristine upstream content. The customized Rendering's `renderedHash` belongs in `skills-manager` state. A same-named lock entry for another Skill identity returns `conflict`; a corrupt or unsupported lock schema returns `failed`.

The lock entry participates in publication with the complete Rendering and Intent/state update, while retaining its narrower role as upstream package-manager metadata.
