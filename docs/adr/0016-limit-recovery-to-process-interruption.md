# Limit recovery to process interruption

Skills Manager guarantees deterministic recovery from an interrupted mutating invocation when callers serialize mutations. Concurrent mutation and sudden operating-system or hardware power loss remain outside the first-version guarantee, keeping recovery focused on atomic publication, explicit rollback failures, and next-invocation reconciliation without adding cross-process locking or claiming unverified cross-platform fsync semantics.
