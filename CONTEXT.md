# Skill Customization Management

This context defines the language used to manage installed skills and preserve local customizations across upstream changes.

## Language

**Intent**:
A user-approved statement of the desired local behavior of an installed Skill within one Installation scope. It describes the result to preserve rather than a textual edit to replay.
_Avoid_: Rule, operation, patch command

**Intent document**:
The human-readable collection of only the currently active Intents for one Installation, carrying enough identity information to prevent reuse with another source or Installation scope. It contains no execution history, disabled entries, or implementation evidence.
_Avoid_: JSON record, patch file, update log

**Intent application**:
The Agent's modification of an Installation to satisfy an active Intent. The Intent remains authoritative if application is interrupted or the installed content is temporarily inconsistent with it.
_Avoid_: Patch replay, publication

**Intent removal**:
A Managed workflow that removes an Intent's applied behavior and reviews that change before deleting the active outcome from its Intent document. The existing Intent remains authoritative until deletion becomes the workflow's final commit point.
_Avoid_: Intent deactivation, tombstone, pending removal

**Upstream-fulfilled Intent**:
An Intent whose desired behavior is verified against clean upstream content acquired on demand, without relying on the Intent application baseline alone. The Agent proposes removing it from the Intent document, but it remains authoritative until the user confirms removal.
_Avoid_: Automatically deleted Intent, permanent guarantee

**Baseline-satisfied Intent**:
An Intent whose desired behavior is present in the Intent application baseline but has not been verified against clean upstream content. It remains active, and failure to verify whether it is upstream-fulfilled does not make the Managed workflow incomplete.
_Avoid_: Upstream-fulfilled Intent, unverified fulfilled Intent

**Intent adaptation**:
A change in how an Intent is applied that preserves the same user-approved semantic result. The Agent may adapt implementation details, but any change to the desired result is a semantic revision requiring user approval.
_Avoid_: Intent rewrite, silent semantic change

**Update**:
A managed operation that advances one or more Installations to their latest upstream content, reapplies each Installation's active Intents, and presents the resulting semantic work for review. Package management runs as one coordinated step, while independent Intent applications may proceed in parallel; running the upstream update command alone is not a completed Update for an Installation with active Intents.
_Avoid_: Refresh, fetch

**Update preflight**:
The mandatory, non-mutating phase of an Update that resolves the exact Installation and validates its matching Intent document before any upstream update begins. Failure to inspect either Installation scope blocks mutation.
_Avoid_: Pre-check, dry run

**Intent application baseline**:
An ephemeral copy of an Installation captured immediately before Intent application in a Managed workflow, including after the upstream package operation in an Update. It is used only to review that application, deleted when review ends, and provides no publication, rollback, recovery, or clean-upstream guarantee.
_Avoid_: Candidate, backup, rollback snapshot, pristine copy

**Baseline handle**:
A short-lived reference to one Intent application baseline in secure operating-system temporary storage. It may be reviewed repeatedly until explicitly closed, and provides no workflow resumption, mutation replay, rollback, or durable registry entry.
_Avoid_: Work directory, transaction, recovery token

**Intent application evidence**:
A natural-language account of changes made to satisfy active Intents during the current Managed workflow attempt. It exists only for the current conversation and does not claim to identify local changes that predate or occurred outside that attempt.
_Avoid_: Customization evidence, patch, Intent, update summary

**Intent application patch**:
The textual difference between an Intent application baseline and the Installation after Intent application in the same Managed workflow attempt. It is temporary input interpreted as Intent application evidence, not a durable semantic record or an inventory of every difference from clean upstream content.
_Avoid_: Customization patch, Intent application evidence, Intent, update summary

**Update summary**:
A natural-language account, kept only in the current conversation, of the upstream update result and the Intents the Agent reapplied. It reports performed semantic work rather than an exact before-and-after file comparison.
_Avoid_: Patch, Intent, Intent application evidence

**Update attempt**:
One coordinated run that advances selected Installations and then reapplies their active Intents. An interruption may leave some Installations complete and others with upstream content installed but not every Intent applied; another Update attempt for the incomplete Installations is the recovery strategy.
_Avoid_: Durable transaction, atomic publication, resumable workflow

**Unknown mutation outcome**:
The incomplete state reported when a mutating upstream command exits unsuccessfully, times out, or is interrupted after starting, because its effects cannot be inferred safely. Recovery begins with a new preflight and never an automatic replay of the mutation.
_Avoid_: Conflict, safe no-op, automatic retry

**Managed workflow**:
An install, customization, Update, or removal flow guided by Skills Manager from its initial user decision through its reported result. Operations performed outside that flow create no cleanup, recovery, or reconciliation obligation for Skills Manager.
_Avoid_: Filesystem ownership, external-operation recovery

**Conflict**:
A state in which the requested operation would discard, contradict, or ambiguously preserve user-approved semantic state. The Agent must stop and present concrete choices; it cannot choose a default on the user's behalf.
_Avoid_: Technical failure, warning

**Skill identity**:
The stable pair of normalized upstream source and upstream Skill identifier that identifies upstream content. An installed directory name or display alias is not identity and cannot authorize reusing Intents for content from another source.
_Avoid_: Folder name, display name

**Installation**:
One Skill identity installed in exactly one Installation scope and exposed to one or more target Agents, to which that scope's Intents belong. It continues to exist until its last target is removed; project and global installations remain independent even when they share the same Skill identity.
_Avoid_: Runtime directory

**Installation snapshot**:
A validated view of one Installation returned by public upstream listing and trusted only within the serialized Managed workflow attempt that obtained it. It may be passed between steps in that attempt, but is neither durable installation metadata nor an independently refreshed authority.
_Avoid_: Cache, registry, manifest

**Installation scope**:
The visibility boundary of an Installation: global or project. Each scope has independent Intents; neither inherits from or changes the other.
_Avoid_: Intent scope, runtime directory

**Skill selection**:
The user-approved set of Skills chosen from an upstream source with the Agent's recommendations. It decides what to install, not the Installation scope, target Agents, or physical locations.
_Avoid_: Installation plan, target selection

**Skill discovery**:
A need-driven search across available upstream sources that produces candidates for the Agent to explain and recommend. Discovery ends with a Skill selection rather than an Installation.
_Avoid_: Repository selection, installation

**Local Skill**:
A Skill installed from a user-maintained local source that has no tracked upstream Update. It can be discovered, installed, listed, and removed, while changes are maintained at its local source.
_Avoid_: Upstream-managed Skill, semantic Update target
