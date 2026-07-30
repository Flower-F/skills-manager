---
status: accepted
---

# Resolve Update identity before mutation

Every Update begins with a non-mutating Update preflight that lists both Installation scopes, resolves the exact Skill identity and scope, and validates its matching Intent document before `npx skills update` may run. A failed preflight blocks mutation; after a successful upstream command, baseline capture refreshes only the selected scope and verifies the expected identity. This adds a read-availability dependency to the fast path, but prevents an ambiguous scope or malformed semantic state from being discovered only after installed content has already been overwritten.
