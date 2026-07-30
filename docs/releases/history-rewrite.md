# Private history rewrite and collaborator recovery

The v0.1.0 public candidate removes local contributor Skills, lock metadata, Agent planning, superseded research, and machine-local paths from every published revision. Because rewriting changes commit identities, perform it while the GitHub repository is private.

## Safety gates

1. Record the exact private remote URL and confirm repository visibility separately through GitHub.
2. Create a `git bundle --all` backup outside the repository and all refs intended for publication. Verify the bundle with `git bundle verify`.
3. Export the ordered author name/email pairs before rewriting and compare them byte-for-byte afterward. Author identity is intentional public metadata and must not be rewritten.
4. Rewrite in an isolated clone. Remove `.agents/`, `.scratch/`, `skills-lock.json`, and `docs/research/impeccable-source-research.md` from every revision, then remove every machine-local absolute path containing the macOS user root.
5. Run `npm run check:history`, a dedicated full-history secret scanner, the deterministic checks, and both compatibility endpoint smokes in the isolated clone.
6. Compare the candidate remote URL to the previously recorded exact private target before force-updating it. Do not change visibility.

The backup bundle must remain outside refs that will be pushed. Secret-scanner findings require review; a finding is never dismissed solely because it is old or appears in a test fixture.

## Collaborator recovery

Old clones and branches retain the pre-rewrite objects and must not be merged or pushed into the new history. The safest recovery is a fresh clone. A collaborator who deliberately keeps a clone must fetch the rewritten private default branch, archive any needed work as patches, reset local branches to the rewritten commits, and delete obsolete refs before resuming. Commit IDs quoted before the rewrite are no longer authoritative.
