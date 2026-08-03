# Changelog

All notable changes to Skills Manager are documented here.

## Unreleased

### Changed

- Replaced the earlier Public Preview customization format with one human-readable Patch document per Installation. A Patch now records a user-approved result to preserve, not edits to replay.
- Simplified Update to ordinary Agent completion judgment: exact identity and Patch documents are resolved before mutation, then every Active Patch is preserved together.
- Made project and global Patch ownership independent and stable across installation-path or target-Agent changes.
- Added explicit guidance for one-off unmanaged edits, Patch Conflict, Local Skills, final-target removal, batch independence, and Skills Manager self-Update.

### Removed

- Removed the previous preview format and its runtime application machinery without a compatibility reader or migration workflow.
- Removed generated application diffs, temporary review state, clean-source comparisons, fulfillment classifications, and helper-specific tests.

## [0.1.0] - 2026-07-30

Initial public release as a Public Preview of need-aware Skill discovery, installation, semantic customization, Update, removal, and clean-checkout compatibility checks for Node.js 22 and 24 with `npx skills` 1.x.

[0.1.0]: https://github.com/Flower-F/skills-manager/releases/tag/v0.1.0
