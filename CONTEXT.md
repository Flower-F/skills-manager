# Skill Customization Management

This context defines the language used to manage installed skills and preserve local customizations across upstream changes.

## Language

**Intent**:
A user-approved statement of the desired local behavior of an installed skill. It describes the result to preserve rather than a textual edit to replay.
_Avoid_: Rule, operation, patch command

**Update**:
A complete managed operation that advances a skill to its latest upstream content, reapplies every active intent, validates the rendered result, and presents the resulting changes for review. Running the upstream update command alone is not a completed update.
_Avoid_: Refresh, fetch

**Untracked change**:
Local skill content that matches neither the known upstream content nor the most recent managed rendering. It may represent an intentional customization, a temporary experiment, or an accidental edit and must be classified by the user before update continues.
_Avoid_: Unknown drift, unexplained modification

**Archaeology**:
The recovery process that compares known upstream content with an untracked local version, lets the agent propose candidate intents, and requires the user to confirm, revise, or discard each candidate before it enters an intent record.
_Avoid_: Automatic migration, diff import

**Update attempt**:
One isolated run from fetching upstream content through intent application, validation, review, and publication or abort. Its working state lives in the operating system's temporary directory and may be discarded; restarting from upstream is the recovery strategy.
_Avoid_: Durable transaction, resumable workflow

**Conflict**:
A state in which the requested operation would discard, contradict, or ambiguously preserve user-approved semantic state. The CLI must stop and present concrete choices; it cannot choose a default on the user's behalf.
_Avoid_: Technical failure, warning

**Skill identity**:
The stable pair of normalized upstream source and upstream skill identifier to which Intents belong. An installed directory name or display alias is not identity and cannot authorize reusing Intents for content from another source.
_Avoid_: Folder name, display name

**Effective intents**:
The union of active global and project Intents for one Skill identity, minus global Intent ids explicitly suppressed by the project. Any ambiguous or contradictory combination is a Conflict until the user records a project-specific resolution.
_Avoid_: Project override, implicit precedence

**Rendering**:
The complete installed skill produced from upstream content plus its Effective intents. It is replaceable output, while the Intent records are authoritative local semantic state.
_Avoid_: Intent record, source

**Installation scope**:
The visibility boundary of a Rendering: global or project. Project Intents may only affect a project Rendering; they never mutate a global Rendering shared by other projects.
_Avoid_: Intent scope, runtime directory
