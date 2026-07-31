# Agent Skill Management

Skills Manager helps users install and update Agent Skills without losing the changes they want to keep.

## Language

**Patch**:
A user-approved change that Skills Manager keeps across updates. It describes the result to preserve rather than file edits to replay.
_Avoid_: Intent, textual diff, patch command

**Active Patch**:
A Patch that Skills Manager must continue to preserve. It remains active until the user removes it, even when the current Skill already satisfies it without further changes.
_Avoid_: Applied diff, fulfilled Patch

**Active Patch set**:
All Active Patches belonging to one Installation. The Installation must satisfy them together; if that cannot be done safely, the user decides how to proceed.
_Avoid_: Patch stack, application queue, override chain

**Patch document**:
The human-readable collection of Active Patches belonging to one Installation. It contains no retired Patches, execution history, application status, file diffs, or implementation paths.
_Avoid_: Intent document, update log, Patch history

**Update**:
An operation that advances an Installation to current upstream content while preserving its Active Patch set. Installations complete independently when more than one is updated.
_Avoid_: Refresh, Patch replay

**Conflict**:
A situation in which Skills Manager cannot safely preserve the user's approved choices. The Agent explains the concrete problem and waits for the user rather than silently changing, ignoring, or removing a Patch.
_Avoid_: Technical failure, warning

**Skill identity**:
The stable pair of upstream source and upstream Skill identifier that identifies a Skill. An installed directory name or display alias is not identity.
_Avoid_: Folder name, display name

**Installation**:
One Skill identity installed in one Installation scope and exposed to one or more target Agents. Its Patch document remains until the Installation's last target is removed.
_Avoid_: Runtime directory

**Installation scope**:
The visibility boundary of an Installation: global or project. Each scope has an independent Patch document; neither inherits from or changes the other.
_Avoid_: Patch scope, runtime directory

**Skill selection**:
The user-approved set of Skills chosen from an upstream source with the Agent's recommendations.
_Avoid_: Installation plan, target selection

**Skill discovery**:
A search for Skills that meet the user's stated need. Discovery produces candidates for the Agent to explain and recommend; the user chooses what to install.
_Avoid_: Repository selection, installation

**Local Skill**:
A Skill installed from a user-maintained local source. Its changes are maintained at that source rather than through Patches.
_Avoid_: Patch-managed Installation
