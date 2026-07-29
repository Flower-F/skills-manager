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

**Upstream-fulfilled Intent**:
An Intent whose desired behavior is now provided by clean upstream content without local customization. The Agent proposes removing it from the Intent document, but it remains authoritative until the user confirms removal.
_Avoid_: Automatically deleted Intent, permanent guarantee

**Intent adaptation**:
A change in how an Intent is applied that preserves the same user-approved semantic result. The Agent may adapt implementation details, but any change to the desired result is a semantic revision requiring user approval.
_Avoid_: Intent rewrite, silent semantic change

**Update**:
A managed operation that advances one or more Installations to their latest upstream content, reapplies each Installation's active Intents, and presents the resulting semantic work for review. Package management runs as one coordinated step, while independent Intent applications may proceed in parallel; running the upstream update command alone is not a completed Update for an Installation with active Intents.
_Avoid_: Refresh, fetch

**Customization evidence**:
A natural-language account of local customization made within a Managed workflow, relative to the clean upstream baseline available for an Installation. It exists only for the current conversation, supports reviewing Intents, and remains best-effort when the exact installed upstream revision is unavailable.
_Avoid_: Patch, Intent, update summary

**Customization patch**:
The textual difference between the available clean upstream baseline and the customized Installation. It is temporary input that the Agent interprets as Customization evidence, not a durable semantic record or a guarantee that upstream exposed an exact revision baseline.
_Avoid_: Customization evidence, Intent, update summary

**Update summary**:
A natural-language account, kept only in the current conversation, of the upstream update result and the Intents the Agent reapplied. It reports performed semantic work rather than an exact before-and-after file comparison.
_Avoid_: Patch, Intent, customization evidence

**Update attempt**:
One coordinated run that advances selected Installations and then reapplies their active Intents. An interruption may leave some Installations complete and others with upstream content installed but not every Intent applied; another Update attempt for the incomplete Installations is the recovery strategy.
_Avoid_: Durable transaction, atomic publication, resumable workflow

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
