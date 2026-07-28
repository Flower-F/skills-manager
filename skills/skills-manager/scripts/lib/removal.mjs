import { createHash, randomUUID } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  assertContainedStateDirectory,
  readManagedState,
  renderedHashForRoot,
} from './publication.mjs';
import { inspectEnvironment } from './inspect.mjs';
import { runtimeRegistry } from './runtime-registry.mjs';
import { removeUpstreamSkill } from './upstream.mjs';

function removalError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function removalConflict(data) {
  const error = new Error('Managed Skill removal requires an explicit decision.');
  error.status = 'conflict';
  error.data = data;
  return error;
}

function normalizedIdentity(identity) {
  return {
    source: identity.source.trim().replace(/\/+$/, '').toLowerCase(),
    skill: identity.skill.replaceAll('\\', '/').replace(/^\.\//, ''),
  };
}

function sameIdentity(left, right) {
  return JSON.stringify(normalizedIdentity(left)) === JSON.stringify(normalizedIdentity(right));
}

function isContained(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function identityHash(identity) {
  const normalized = normalizedIdentity(identity);
  return createHash('sha256')
    .update(normalized.source)
    .update('\0')
    .update(normalized.skill)
    .digest('hex');
}

function intentRelativePath(managed) {
  if (
    typeof managed.installName !== 'string' ||
    !managed.installName ||
    managed.installName === '.' ||
    managed.installName === '..' ||
    /[/\\\0]/.test(managed.installName)
  ) {
    throw removalError('invalid_managed_state', 'Managed Skill install name is not a safe state filename.');
  }
  return `.skills-manager/intents/${managed.installName}__${identityHash(managed.identity).slice(0, 8)}.json`;
}

async function lstatIfExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

async function readIntent(root, managed) {
  const relativePath = intentRelativePath(managed);
  const path = resolve(root, relativePath);
  const intentsDirectory = join(root, '.skills-manager/intents');
  await assertContainedStateDirectory(root, intentsDirectory);
  if (!isContained(intentsDirectory, path)) {
    throw removalError('invalid_intent_state', 'Intent state path escapes its authorized directory.');
  }
  const info = await lstatIfExists(path);
  if (!info) return { path, relativePath, exists: false, intents: [], suppressedGlobalIntentIds: [] };
  if (!info.isFile() || info.isSymbolicLink()) {
    throw removalError('invalid_intent_state', 'Intent state must be a regular file.');
  }
  try {
    const record = JSON.parse(await readFile(path, 'utf8'));
    if (
      record?.version !== 1 ||
      !sameIdentity(record.identity, managed.identity) ||
      !Array.isArray(record.intents) ||
      !Array.isArray(record.suppressedGlobalIntentIds || [])
    ) {
      throw new Error();
    }
    return {
      path,
      relativePath,
      exists: true,
      intents: record.intents,
      suppressedGlobalIntentIds: record.suppressedGlobalIntentIds || [],
    };
  } catch {
    throw removalError('invalid_intent_state', 'Intent state has an unsupported or malformed schema.');
  }
}

async function readLock(root) {
  const path = join(root, 'skills-lock.json');
  const info = await lstatIfExists(path);
  if (!info) return { path, value: { version: 1, skills: {} }, snapshot: null };
  if (!info.isFile() || info.isSymbolicLink()) {
    throw removalError('invalid_lock', 'skills-lock.json must be a regular file.');
  }
  const snapshot = await readFile(path);
  try {
    const value = JSON.parse(snapshot.toString('utf8'));
    if (value?.version !== 1 || !value.skills || typeof value.skills !== 'object' || Array.isArray(value.skills)) {
      throw new Error();
    }
    return { path, value, snapshot };
  } catch {
    throw removalError('invalid_lock', 'skills-lock.json has an unsupported or malformed schema.');
  }
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function restore(path, snapshot) {
  if (snapshot === null) await rm(path, { force: true });
  else await writeFile(path, snapshot);
}

async function verifyRendering(root, managed, scope) {
  const resolvedRoot = await realpath(root);
  const targets = [];
  for (const storedTarget of managed.physicalTargets) {
    const target = resolve(resolvedRoot, storedTarget);
    if (!isContained(resolvedRoot, target)) {
      throw removalError('invalid_publication_target', 'A managed Rendering target escapes its scope.');
    }
    const info = await lstatIfExists(target);
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      throw removalConflict({
        reason: 'unexplained_copy',
        target: storedTarget,
        explanation: 'The recorded Rendering is absent or is no longer a real managed directory.',
        choices: ['cancel'],
      });
    }
    const resolvedTarget = await realpath(target);
    if (!isContained(resolvedRoot, resolvedTarget)) {
      throw removalError('invalid_publication_target', 'A managed Rendering resolves outside its scope.');
    }
    if ((await renderedHashForRoot(resolvedTarget)) !== managed.renderedHash) {
      throw removalConflict({
        reason: 'untracked_change',
        target: storedTarget,
        explanation:
          scope === 'project'
            ? 'Recover this recorded project Rendering through Archaeology before removal.'
            : 'Global Archaeology is not available; reconcile this global Rendering before retrying.',
        choices: scope === 'project' ? ['recover', 'cancel'] : ['cancel'],
      });
    }
    targets.push(target);
  }
  return targets;
}

async function assertNoUnrecordedCopies({
  repositoryRoot,
  root,
  managed,
  scope,
  currentRuntime,
  environment,
  targets,
}) {
  const known = new Set(await Promise.all(targets.map((target) => realpath(target))));
  let skillDirectories;
  if (scope === 'project') {
    const observation = await inspectEnvironment({
      repositoryRoot,
      currentRuntime,
      scope,
      environment,
    });
    skillDirectories = observation.targets.map(({ path }) => path);
  } else {
    skillDirectories = runtimeRegistry(environment).map(({ globalSkillsDirectory }) =>
      dirname(join(globalSkillsDirectory, managed.installName)),
    );
  }
  for (const skillsDirectory of new Set(skillDirectories)) {
    const candidate = join(skillsDirectory, managed.installName);
    const info = await lstatIfExists(candidate);
    if (!info) continue;
    const resolved = await realpath(candidate).catch((error) => {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      throw error;
    });
    if (!resolved || !known.has(resolved)) {
      throw removalConflict({
        reason: 'unexplained_copy',
        target: isContained(root, candidate) ? relative(root, candidate) : candidate,
        explanation:
          'This exposed copy is not in managed state and must be reconciled outside managed removal.',
        choices: ['cancel'],
      });
    }
  }
}

async function createRemovalRecovery(root, targets, managed) {
  const directory = await mkdtemp(join(tmpdir(), 'skills-manager-removal-recovery-'));
  const backups = [];
  try {
    for (const [index, target] of targets.entries()) {
      const backup = join(directory, String(index));
      await cp(target, backup, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
      backups.push({ target, backup, renderedHash: managed.renderedHash });
    }
    const links = [];
    for (const link of managed.topologyLinks || []) {
      const path = resolve(root, link.path);
      if (!isContained(root, path)) {
        throw removalError('invalid_publication_target', 'A managed topology link escapes its scope.');
      }
      const info = await lstatIfExists(path);
      if (!info?.isSymbolicLink() || (await readlink(path)) !== link.target) {
        throw removalConflict({
          reason: 'unexplained_copy',
          target: link.path,
          explanation: 'A recorded topology link changed and must be reconciled before removal.',
          choices: ['cancel'],
        });
      }
      links.push({ path, target: link.target });
    }
    return { directory, backups, links };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function restoreRendering({ target, backup, renderedHash }) {
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    const nonce = randomUUID();
    const staged = join(parent, `.${basename(target)}.${nonce}.restore`);
    const displaced = join(parent, `.${basename(target)}.${nonce}.displaced`);
    let hadExisting = false;
    try {
      await cp(backup, staged, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
      if ((await renderedHashForRoot(staged)) !== renderedHash) {
        throw removalError('removal_recovery_failed', 'A Rendering recovery copy failed validation.');
      }
      hadExisting = Boolean(await lstatIfExists(target));
      if (hadExisting) await rename(target, displaced);
      await rename(staged, target);
      if (hadExisting) await rm(displaced, { recursive: true, force: true });
    } catch (error) {
      await rm(staged, { recursive: true, force: true });
      if (hadExisting && !(await lstatIfExists(target)) && (await lstatIfExists(displaced))) {
        await rename(displaced, target);
      }
      throw error;
    }
}

async function restoreRenderings(backups) {
  const failures = [];
  for (const backup of backups) {
    try {
      await restoreRendering(backup);
    } catch (error) {
      failures.push({ target: backup.target, code: error?.code, message: error?.message });
    }
  }
  if (failures.length > 0) {
    const error = removalError('removal_recovery_failed', 'One or more Renderings could not be restored.');
    error.recoveryFailures = failures;
    throw error;
  }
}

async function restoreTopologyLinks(links) {
  const failures = [];
  for (const link of links) {
    try {
      const info = await lstatIfExists(link.path);
      if (info?.isSymbolicLink() && (await readlink(link.path)) === link.target) continue;
      if (info) await rm(link.path, { recursive: true, force: true });
      await mkdir(dirname(link.path), { recursive: true });
      await symlink(link.target, link.path, 'dir');
    } catch (error) {
      failures.push({ target: link.path, code: error?.code, message: error?.message });
    }
  }
  if (failures.length > 0) {
    const error = removalError('removal_recovery_failed', 'One or more topology links could not be restored.');
    error.recoveryFailures = failures;
    throw error;
  }
}

async function restoreRemovalFilesystem(recovery) {
  const failures = [];
  for (const [step, operation] of [
    ['renderings', () => restoreRenderings(recovery.backups)],
    ['topology_links', () => restoreTopologyLinks(recovery.links)],
  ]) {
    try {
      await operation();
    } catch (error) {
      failures.push({ step, failures: error.recoveryFailures || [{ message: error.message }] });
    }
  }
  if (failures.length > 0) {
    const error = removalError('removal_recovery_failed', 'Removal filesystem recovery was incomplete.');
    error.recoveryFailures = failures;
    throw error;
  }
}

async function rollbackRemoval({
  recovery,
  statePath,
  stateSnapshot,
  lock,
  intentPath,
  intentSnapshot,
}) {
  const failures = [];
  const attempt = async (step, operation) => {
    try {
      await operation();
      return true;
    } catch (error) {
      failures.push({
        step,
        code: error?.code || 'rollback_failed',
        message: error?.message,
        ...(error?.recoveryFailures ? { details: error.recoveryFailures } : {}),
      });
      return false;
    }
  };
  const filesystemRestored = await attempt('renderings_and_topology', () =>
    restoreRemovalFilesystem(recovery),
  );
  await attempt('managed_state', () => restore(statePath, stateSnapshot));
  await attempt('upstream_lock', () => restore(lock.path, lock.snapshot));
  await attempt('intent_state', () => restore(intentPath, intentSnapshot));
  if (filesystemRestored) {
    await attempt('recovery_cleanup', () =>
      rm(recovery.directory, { recursive: true, force: true }),
    );
  } else {
    failures.push({ step: 'recovery_backup_preserved', path: recovery.directory });
  }
  return failures;
}

function attachRollbackFailures(error, failures) {
  if (failures.length === 0) return;
  error.details = { ...(error.details || {}), rollbackFailures: failures };
}

function entriesForSkill(state, skill) {
  return Object.entries(state?.skills || {}).filter(([, entry]) => entry.installName === skill);
}

export async function removeManagedSkill({
  repositoryRoot,
  skill,
  scope,
  currentRuntime,
  confirmRemoval,
  confirmExposure,
  confirmationToken,
  intentPolicy,
  source,
  upstreamSkill,
  environment,
}) {
  if (!['project', 'global'].includes(scope)) {
    throw removalError('unsupported_scope', `Unsupported removal scope: ${scope}`);
  }
  if (intentPolicy && !['retain', 'delete'].includes(intentPolicy)) {
    throw removalError('invalid_arguments', 'Intent policy must be retain or delete.');
  }
  const projectRoot = await realpath(repositoryRoot);
  const globalRoot = environment.HOME ? await realpath(environment.HOME).catch(() => null) : null;
  if (scope === 'global' && !globalRoot) {
    throw removalError('invalid_removal_scope', 'Global removal requires an available HOME directory.');
  }
  const root = scope === 'project' ? projectRoot : globalRoot;
  const otherRoot = scope === 'project' ? globalRoot : projectRoot;
  const state = (await readManagedState(root)) || { version: 1, skills: {} };
  if ((source && !upstreamSkill) || (!source && upstreamSkill)) {
    throw removalError('invalid_arguments', 'Removal identity requires both --source and --upstream-skill.');
  }
  const installNameMatches = entriesForSkill(state, skill);
  const selectedIdentity =
    source && upstreamSkill ? normalizedIdentity({ source, skill: upstreamSkill }) : null;
  const matches = selectedIdentity
    ? installNameMatches.filter(([, entry]) => sameIdentity(entry.identity, selectedIdentity))
    : installNameMatches;
  if (installNameMatches.length > 1) {
    throw removalConflict({
      reason: 'ambiguous_skill_identity',
      scope,
      identities: installNameMatches.map(([, { identity }]) => normalizedIdentity(identity)),
      choices: ['resolve_identity', 'cancel'],
      resolution: {
        command: 'identity-resolve',
        requiredOptions: ['skill', 'source', 'upstream-skill', 'choice'],
        options: { scope, choice: 'manage_clean' },
      },
    });
  }
  const otherState = otherRoot ? await readManagedState(otherRoot) : null;
  if (matches.length === 0) {
    if (selectedIdentity && installNameMatches.length > 0) {
      throw removalConflict({
        reason: 'skill_identity_not_found',
        scope,
        requestedIdentity: selectedIdentity,
        availableIdentities: installNameMatches.map(([, entry]) =>
          normalizedIdentity(entry.identity),
        ),
        choices: ['select_identity', 'cancel'],
      });
    }
    return {
      envelopeStatus: 'complete',
      removed: false,
      alreadyAbsent: true,
      scope,
      remainingInstallations: entriesForSkill(otherState, skill).map(([, entry]) => ({
        scope: entry.scope,
        identity: normalizedIdentity(entry.identity),
      })),
    };
  }
  const [stateKey, managed] = matches[0];
  if (managed.scope !== scope) {
    throw removalError('invalid_managed_state', 'Managed Skill scope does not match its state root.');
  }
  const otherMatches = entriesForSkill(otherState, skill);
  const sameOther = otherMatches.filter(([, entry]) => sameIdentity(entry.identity, managed.identity));
  const scopedIntent = await readIntent(root, managed);
  const projectIntent = await readIntent(projectRoot, managed);
  const globalIntent = globalRoot
    ? await readIntent(globalRoot, managed)
    : { exists: false, intents: [], suppressedGlobalIntentIds: [] };
  const hasScopedIntentState =
    scopedIntent.exists &&
    (scopedIntent.intents.length > 0 || scopedIntent.suppressedGlobalIntentIds.length > 0);
  const impact = {
    identity: normalizedIdentity(managed.identity),
    scope,
    physicalTargets: managed.physicalTargets,
    activeIntents: scopedIntent.intents.filter(({ state: intentState }) => intentState === 'active'),
    retainedIntents: scopedIntent.intents.filter(({ state: intentState }) => intentState !== 'active'),
    suppressedGlobalIntentIds: projectIntent.suppressedGlobalIntentIds,
    inheritedGlobalIntents: globalIntent.intents.filter(({ state: intentState }) => intentState === 'active'),
    otherScopeInstallations: otherMatches.map(([, entry]) => ({
      scope: entry.scope,
      identity: normalizedIdentity(entry.identity),
    })),
  };
  if (confirmRemoval && !selectedIdentity) {
    throw removalConflict({
      reason: 'identity_confirmation_required',
      impact,
      choices: ['confirm_identity', 'cancel'],
      confirmation: {
        source: normalizedIdentity(managed.identity).source,
        upstreamSkill: normalizedIdentity(managed.identity).skill,
      },
    });
  }
  if (hasScopedIntentState && !intentPolicy) {
    throw removalConflict({
      reason: 'remaining_intent_state',
      impact,
      choices: ['retain_intents', 'delete_intents', 'cancel'],
    });
  }
  if (scope === 'global' && intentPolicy === 'delete' && sameOther.length > 0) {
    throw removalConflict({
      reason: 'destructive_scope_consequence',
      impact,
      explanation:
        'Deleting global Intents would leave a remaining project Rendering inconsistent with its Effective intents.',
      choices: ['retain_intents', 'cancel'],
    });
  }
  const exposesOtherScope = scope === 'project' && otherMatches.length > 0;
  if (exposesOtherScope && !confirmExposure) {
    throw removalConflict({
      reason: 'scope_removal_changes_exposure',
      impact,
      exposedInstallation: {
        scope: 'global',
        identity: normalizedIdentity(otherMatches[0][1].identity),
      },
      choices: ['expose_other_scope', 'cancel'],
    });
  }
  const targets = await verifyRendering(root, managed, scope);
  await assertNoUnrecordedCopies({
    repositoryRoot: projectRoot,
    root,
    managed,
    scope,
    currentRuntime,
    environment,
    targets,
  });
  const lock = await readLock(root);
  const lockEntry = lock.value.skills[skill];
  const lockedIdentity = normalizedIdentity({
    source: lockEntry?.source || '',
    skill: lockEntry?.skillPath || skill,
  });
  const managedIdentity = normalizedIdentity(managed.identity);
  if (
    !lockEntry ||
    lockedIdentity.source !== managedIdentity.source ||
    lockedIdentity.skill !== managedIdentity.skill
  ) {
    throw removalError('invalid_lock', 'The upstream lock entry does not match the managed Skill identity.');
  }
  const expectedConfirmationToken = createHash('sha256')
    .update(
      JSON.stringify({
        skill,
        scope,
        root,
        currentRuntime,
        intentPolicy: intentPolicy || 'not_applicable',
        confirmExposure,
        managed,
        scopedIntent: {
          exists: scopedIntent.exists,
          intents: scopedIntent.intents,
          suppressedGlobalIntentIds: scopedIntent.suppressedGlobalIntentIds,
        },
        projectIntent: {
          exists: projectIntent.exists,
          intents: projectIntent.intents,
          suppressedGlobalIntentIds: projectIntent.suppressedGlobalIntentIds,
        },
        globalIntent: {
          exists: globalIntent.exists,
          intents: globalIntent.intents,
          suppressedGlobalIntentIds: globalIntent.suppressedGlobalIntentIds,
        },
        otherInstallations: otherMatches.map(([key, entry]) => ({ key, entry })),
        lockEntry,
      }),
    )
    .digest('hex');
  if (!confirmRemoval) {
    return {
      envelopeStatus: 'needs_confirmation',
      impact,
      intentPolicy: intentPolicy || 'not_applicable',
      choices: ['remove', 'cancel'],
      confirmation: {
        source: normalizedIdentity(managed.identity).source,
        upstreamSkill: normalizedIdentity(managed.identity).skill,
        token: expectedConfirmationToken,
      },
    };
  }
  if (!confirmationToken || confirmationToken !== expectedConfirmationToken) {
    throw removalConflict({
      reason: 'removal_preview_changed',
      impact,
      choices: ['preview_again', 'cancel'],
    });
  }
  const statePath = join(root, '.skills-manager/state.json');
  const stateSnapshot = await readFile(statePath);
  const intentSnapshot = scopedIntent.exists ? await readFile(scopedIntent.path) : null;
  const recovery = await createRemovalRecovery(root, targets, managed);
  try {
    await removeUpstreamSkill({
      root,
      skill,
      currentRuntime,
      scope,
      environment,
    });
  } catch (error) {
    const failures = await rollbackRemoval({
      recovery,
      statePath,
      stateSnapshot,
      lock,
      intentPath: scopedIntent.path,
      intentSnapshot,
    });
    attachRollbackFailures(error, failures);
    throw error;
  }
  try {
    for (const target of targets) await rm(target, { recursive: true, force: true });
    for (const link of managed.topologyLinks || []) {
      if (basename(link.path) !== managed.installName) continue;
      const linkPath = resolve(root, link.path);
      if (!isContained(root, linkPath)) {
        throw removalError('invalid_publication_target', 'A managed topology link escapes its scope.');
      }
      await rm(linkPath, { force: true });
    }
    if ((await Promise.all(targets.map((target) => lstatIfExists(target)))).some(Boolean)) {
      throw removalError('removal_incomplete', 'A managed Rendering remains after upstream removal.');
    }
    const nextState = {
      version: 1,
      skills: Object.fromEntries(Object.entries(state.skills).filter(([key]) => key !== stateKey)),
    };
    const nextLock = {
      version: 1,
      skills: Object.fromEntries(Object.entries(lock.value.skills).filter(([name]) => name !== skill)),
    };
    await atomicWriteJson(statePath, nextState);
    await atomicWriteJson(lock.path, nextLock);
    if (intentPolicy === 'delete' && scopedIntent.exists) await rm(scopedIntent.path, { force: true });
    await rm(recovery.directory, { recursive: true, force: true }).catch(() => {});
    return {
      removed: true,
      scope,
      identity: normalizedIdentity(managed.identity),
      intents: intentPolicy === 'delete' ? 'deleted' : scopedIntent.exists ? 'retained' : 'none',
      remainingInstallations: otherMatches.map(([, entry]) => ({
        scope: entry.scope,
        identity: normalizedIdentity(entry.identity),
      })),
      compatibility: { delegatedRemoval: true },
    };
  } catch (error) {
    const failures = await rollbackRemoval({
      recovery,
      statePath,
      stateSnapshot,
      lock,
      intentPath: scopedIntent.path,
      intentSnapshot,
    });
    attachRollbackFailures(error, failures);
    throw error;
  }
}
