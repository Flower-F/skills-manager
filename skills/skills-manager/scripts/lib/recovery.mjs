import { randomUUID } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { resolveRealPathWithin } from './path-policy.mjs';
import {
  assertContainedStateDirectory,
  readManagedState,
  renderedHashForRoot,
} from './publication.mjs';

function recoveryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function recoveryConflict(data) {
  const error = new Error('Interrupted publication recovery encountered unexplained content.');
  error.status = 'conflict';
  error.data = data;
  return error;
}

async function assertContainedExistingAncestor(root, path) {
  const resolvedRoot = await realpath(root);
  let existing = path;
  while (!(await pathInfo(existing))) {
    const parent = dirname(existing);
    if (parent === existing) {
      throw recoveryError('invalid_publication_target', 'Recovery path has no safe existing ancestor.');
    }
    existing = parent;
  }
  const resolved = await resolveRealPathWithin(resolvedRoot, existing).catch(() => null);
  if (!resolved) {
    throw recoveryError(
      'invalid_publication_target',
      'An interrupted-publication recovery path resolves outside the project.',
    );
  }
}

function normalizedIdentity(identity) {
  return {
    source: identity.source.trim().replace(/\/+$/, '').toLowerCase(),
    skill: identity.skill.replaceAll('\\', '/').replace(/^\.\//, ''),
  };
}

async function atomicWriteJson(path, value) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function validateLock(root, managed) {
  const path = join(root, 'skills-lock.json');
  const info = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw recoveryError('invalid_lock', 'Interrupted publication recovery requires a regular lock file.');
  }
  try {
    const lock = JSON.parse(await readFile(path, 'utf8'));
    const entry = lock?.version === 1 && lock.skills?.[managed.installName];
    const lockedIdentity = entry &&
      normalizedIdentity({
        source: entry.source,
        skill: entry.skillPath || managed.installName,
      });
    if (
      !entry ||
      entry.computedHash !== managed.upstreamHash ||
      JSON.stringify(lockedIdentity) !== JSON.stringify(normalizedIdentity(managed.identity))
    ) {
      throw new Error();
    }
  } catch {
    throw recoveryError(
      'invalid_lock',
      'The lock entry does not match the desired interrupted publication state.',
    );
  }
}

async function prepareCompleteTarget({ root, source, target, expectedHash, expectedCurrentHash }) {
  const parent = dirname(target);
  await assertContainedExistingAncestor(root, source);
  await assertContainedExistingAncestor(root, parent);
  await mkdir(parent, { recursive: true });
  await assertContainedExistingAncestor(root, parent);
  const nonce = randomUUID();
  const sibling = join(parent, `.${basename(target)}.${nonce}.healing`);
  const backup = join(parent, `.${basename(target)}.${nonce}.previous`);
  try {
    await cp(source, sibling, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
    if ((await renderedHashForRoot(sibling)) !== expectedHash) {
      throw recoveryError('recovery_validation_failed', 'A complete healing copy failed validation.');
    }
    return {
      target,
      sibling,
      backup,
      expectedCurrentHash,
      displaced: false,
      activated: false,
    };
  } catch (error) {
    await rm(sibling, { recursive: true, force: true });
    throw error;
  }
}

async function restorePreparedTargets(prepared) {
  const failures = [];
  for (const item of [...prepared].reverse()) {
    for (const [step, operation] of [
      ['remove_activated', () => item.activated && rm(item.target, { recursive: true, force: true })],
      ['restore_previous', () => item.displaced && rename(item.backup, item.target)],
      ['remove_sibling', () => rm(item.sibling, { recursive: true, force: true })],
    ]) {
      try {
        await operation();
      } catch (error) {
        failures.push({ target: item.target, step, code: error?.code, message: error?.message });
      }
    }
  }
  return failures;
}

async function publishPreparedTargets(root, prepared, finalize) {
  try {
    for (const item of prepared) {
      await assertContainedExistingAncestor(root, dirname(item.target));
      await assertContainedExistingAncestor(root, item.sibling);
      const current = await pathInfo(item.target);
      const baselineChanged = item.expectedCurrentHash === null
        ? current !== null
        : !current || (await renderedHashForRoot(item.target)) !== item.expectedCurrentHash;
      if (baselineChanged) {
        throw recoveryConflict({
          reason: 'untracked_change',
          target: item.target,
          choices: ['recover_with_archaeology', 'cancel'],
        });
      }
      if (current) {
        await rename(item.target, item.backup);
        item.displaced = true;
      }
      await rename(item.sibling, item.target);
      item.activated = true;
    }
    await finalize();
  } catch (error) {
    const rollbackFailures = await restorePreparedTargets(prepared);
    if (rollbackFailures.length > 0) {
      error.details = { ...(error.details || {}), rollbackFailures };
    }
    throw error;
  }
  const cleanupFailures = [];
  for (const item of prepared) {
    try {
      await rm(item.backup, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push({ path: item.backup, message: error.message });
    }
  }
  if (cleanupFailures.length > 0) {
    const error = recoveryError(
      'publication_cleanup_failed',
      'Recovered Rendering is authoritative, but previous Rendering backups remain.',
    );
    error.details = { cleanupFailures };
    throw error;
  }
}

async function currentStateBaseline(root, managed) {
  const currentState = await readManagedState(root);
  const matches = Object.entries(currentState?.skills || {}).filter(
    ([, entry]) =>
      entry.installName === managed.installName &&
      JSON.stringify(entry.identity) === JSON.stringify(managed.identity),
  );
  if (matches.length !== 1 || JSON.stringify(matches[0][1]) !== JSON.stringify(managed)) {
    throw recoveryConflict({
      reason: 'operation_baseline_changed',
      choices: ['restart', 'cancel'],
    });
  }
  return { state: currentState, key: matches[0][0] };
}

async function pathInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

async function observeManagedTargets(root, managed, pending) {
  const allowed = new Set([managed.renderedHash, managed.desiredRenderedHash]);
  const observations = [];
  const artifacts = [];
  for (const [index, storedTarget] of managed.physicalTargets.entries()) {
    const target = resolve(root, storedTarget);
    const prefix = `.${managed.installName}.skills-manager-`;
    const escapedName = managed.installName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const artifactName = new RegExp(
      `^\\.${escapedName}\\.skills-manager-(?:backup-)?[a-f0-9]{32}-${index}$`,
    );
    const candidates = [];
    await assertContainedExistingAncestor(root, dirname(target));
    for (const entry of await readdir(dirname(target), { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
      throw error;
    })) {
      if (!entry.name.startsWith(prefix) || !artifactName.test(entry.name)) continue;
      if (!entry.isDirectory()) {
        throw recoveryConflict({
          reason: 'untracked_change',
          target: join(dirname(target), entry.name),
          choices: ['cancel'],
        });
      }
      const path = join(dirname(target), entry.name);
      await assertContainedExistingAncestor(root, path);
      candidates.push({ path, hash: await renderedHashForRoot(path) });
    }
    artifacts.push(...candidates.map(({ path }) => path));
    const unexplainedArtifacts = candidates.filter(({ hash }) => !allowed.has(hash));
    if (unexplainedArtifacts.length > 0) {
      throw recoveryConflict({
        reason: 'untracked_change',
        targets: unexplainedArtifacts,
        choices: ['cancel'],
      });
    }
    const info = await pathInfo(target);
    if (info?.isDirectory() && !info.isSymbolicLink()) {
      observations.push({ target, hash: await renderedHashForRoot(target) });
      continue;
    }
    if (info) {
      throw recoveryConflict({ reason: 'untracked_change', target, choices: ['cancel'] });
    }
    const unexplained = candidates.filter(({ hash }) => !allowed.has(hash));
    if (unexplained.length > 0) {
      throw recoveryConflict({
        reason: 'untracked_change',
        targets: unexplained,
        choices: ['cancel'],
      });
    }
    const selected =
      candidates.find(({ hash }) => hash === managed.desiredRenderedHash) ||
      candidates.find(({ hash }) => hash === managed.renderedHash);
    if (!selected) {
      observations.push({ target, hash: null, missing: true });
      continue;
    }
    observations.push({ target, hash: selected.hash, restoreFrom: selected.path });
  }
  return { observations, artifacts };
}

async function inspectTopologyLinks(root, managed) {
  const missing = [];
  for (const link of managed.topologyLinks || []) {
    const path = resolve(root, link.path);
    await assertContainedExistingAncestor(root, path);
    const info = await pathInfo(path);
    if (!info) {
      missing.push({ path, target: link.target });
      continue;
    }
    if (!info.isSymbolicLink() || (await readlink(path)) !== link.target) {
      throw recoveryConflict({
        reason: 'untracked_change',
        target: path,
        choices: ['cancel'],
      });
    }
  }
  return missing;
}

async function restoreInterruptedArtifacts(root, observations) {
  for (const observation of observations) {
    if (!observation.restoreFrom) continue;
    await assertContainedExistingAncestor(root, observation.restoreFrom);
    await assertContainedExistingAncestor(root, dirname(observation.target));
    await rename(observation.restoreFrom, observation.target);
  }
}

async function repairTopologyLinks(root, links) {
  const created = [];
  try {
    for (const link of links) {
      await assertContainedExistingAncestor(root, dirname(link.path));
      await mkdir(dirname(link.path), { recursive: true });
      await assertContainedExistingAncestor(root, dirname(link.path));
      await symlink(link.target, link.path, 'dir');
      created.push(link.path);
    }
    return created;
  } catch (error) {
    for (const path of created.reverse()) await rm(path, { force: true }).catch(() => {});
    throw error;
  }
}

async function cleanupArtifacts(root, artifacts) {
  const failures = [];
  for (const path of new Set(artifacts)) {
    try {
      await assertContainedExistingAncestor(root, path);
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      failures.push({ path, message: error.message });
    }
  }
  if (failures.length > 0) {
    const error = recoveryError(
      'publication_cleanup_failed',
      'Recovered Rendering is authoritative, but stale publication artifacts remain.',
    );
    error.details = { cleanupFailures: failures };
    throw error;
  }
}

export async function recoverInterruptedPublication({ root, managed }) {
  const pending =
    Boolean(managed.publicationPending) || managed.desiredRenderedHash !== managed.renderedHash;
  await currentStateBaseline(root, managed);
  const { observations: observed, artifacts } = await observeManagedTargets(root, managed, pending);
  const missingLinks = await inspectTopologyLinks(root, managed);
  if (!pending) {
    if (missingLinks.length > 0) {
      throw recoveryConflict({
        reason: 'untracked_change',
        missingLinks,
        choices: ['cancel'],
      });
    }
    await cleanupArtifacts(root, artifacts);
    return { recovery: 'not_required' };
  }
  const allowed = new Set([managed.renderedHash, managed.desiredRenderedHash]);
  const unexplained = observed.filter(({ hash, missing }) => !missing && !allowed.has(hash));
  if (unexplained.length > 0) {
    throw recoveryConflict({
      reason: 'untracked_change',
      targets: unexplained.map(({ target, hash }) => ({ target, hash })),
      choices: ['recover_with_archaeology', 'cancel'],
    });
  }
  const desired = observed.filter(({ hash }) => hash === managed.desiredRenderedHash);
  const installPending =
    managed.publicationPending && managed.desiredRenderedHash === managed.renderedHash;
  let lockCoherent = true;
  if (desired.length > 0) {
    try {
      await validateLock(root, managed);
    } catch (error) {
      if (!installPending) throw error;
      lockCoherent = false;
    }
  }
  await restoreInterruptedArtifacts(root, observed);
  if (desired.length === 0 || !lockCoherent) {
    await cleanupArtifacts(root, artifacts);
    return {
      recovery: 'regeneration_required',
      desiredRenderedHash: managed.desiredRenderedHash,
      currentRenderedHash: managed.renderedHash,
      missingTargets: observed.filter(({ missing }) => missing).map(({ target }) => target),
      missingLinks,
    };
  }
  await currentStateBaseline(root, managed);
  const source = desired[0].target;
  const prepared = [];
  try {
    for (const observation of observed) {
      if (observation.hash === managed.desiredRenderedHash) continue;
      prepared.push(
        await prepareCompleteTarget({
          root,
          source,
          target: observation.target,
          expectedHash: managed.desiredRenderedHash,
          expectedCurrentHash: observation.hash,
        }),
      );
    }
  } catch (error) {
    const rollbackFailures = await restorePreparedTargets(prepared);
    if (rollbackFailures.length > 0) {
      error.details = { ...(error.details || {}), rollbackFailures };
    }
    throw error;
  }
  const statePath = join(root, '.skills-manager/state.json');
  await assertContainedStateDirectory(root, dirname(statePath));
  await currentStateBaseline(root, managed);
  let createdLinks = [];
  await publishPreparedTargets(root, prepared, async () => {
    try {
      createdLinks = await repairTopologyLinks(root, missingLinks);
      const { state, key } = await currentStateBaseline(root, managed);
      const finalized = { ...managed, renderedHash: managed.desiredRenderedHash };
      delete finalized.publicationPending;
      await atomicWriteJson(statePath, {
        version: 1,
        skills: { ...state.skills, [key]: finalized },
      });
    } catch (error) {
      for (const path of createdLinks.reverse()) await rm(path, { force: true }).catch(() => {});
      throw error;
    }
  });
  await cleanupArtifacts(root, artifacts);
  return {
    recovery: 'healed',
    healedTargets: observed.filter(({ hash }) => hash !== managed.desiredRenderedHash).length,
    renderedHash: managed.desiredRenderedHash,
  };
}
