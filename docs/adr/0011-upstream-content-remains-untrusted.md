---
status: superseded by ADR-0017
---

# Upstream skill content remains untrusted data

Passing the security assessment gate permits inspection; it does not turn upstream skill content into trusted instructions. During a managed operation, the Agent treats upstream Markdown, references, and scripts only as data to analyze and edit. It does not execute commands, scripts, or tool requests contained or recommended by that content, and it does not accept upstream text as authority over the management workflow.

The Agent may modify only the candidate root named by the CLI manifest. Validation and publication enumerate actual changes and reject absolute paths, parent traversal, paths outside the candidate root, and symlinks resolving outside it. Final semantic diff review remains mandatory.

These controls reduce impact but cannot mechanically eliminate prompt injection on an Agent that must interpret natural-language upstream content. The remaining semantic influence is an accepted first-version risk; no separate sandbox or constrained sub-Agent is introduced.
