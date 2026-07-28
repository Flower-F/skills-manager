import { createHash } from 'node:crypto';
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
  rmdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { loadManifest, saveManifest } from './upstream.mjs';
import { inspectEnvironment } from './inspect.mjs';

function managedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function conflictError(data) {
  const error = new Error('A different Skill identity already uses this install name.');
  error.status = 'conflict';
  error.data = data;
  return error;
}

function isContained(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

async function enumerateTree(root) {
  const resolvedRoot = await realpath(root);
  const entries = [];
  async function visit(directory, prefix = '') {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const path = join(directory, child.name);
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const link = await readlink(path);
        if (isAbsolute(link)) {
          throw managedError('validation_failed', `Absolute symbolic link is prohibited: ${relativePath}`);
        }
        const resolved = await realpath(path).catch(() => null);
        if (!resolved || !isContained(resolvedRoot, resolved)) {
          throw managedError('validation_failed', `Symbolic link escapes the candidate: ${relativePath}`);
        }
        entries.push({ path, relativePath, type: 'symlink', link });
      } else if (info.isDirectory()) {
        entries.push({ path, relativePath, type: 'directory' });
        await visit(path, relativePath);
      } else if (info.isFile()) {
        entries.push({ path, relativePath, type: 'file', content: await readFile(path) });
      } else {
        throw managedError('validation_failed', `Unsupported candidate entry: ${relativePath}`);
      }
    }
  }
  await visit(resolvedRoot);
  return entries;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw managedError('validation_failed', 'SKILL.md requires YAML frontmatter.');
  const values = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#') || /^\s/.test(line)) continue;
    const field = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*?)\s*$/);
    if (!field || Object.hasOwn(values, field[1])) {
      throw managedError('validation_failed', 'SKILL.md frontmatter is malformed or ambiguous.');
    }
    const rawValue = field[2];
    if (rawValue.startsWith('"') || rawValue.startsWith("'")) {
      const quote = rawValue[0];
      if (rawValue.length < 2 || rawValue.at(-1) !== quote) {
        throw managedError('validation_failed', 'SKILL.md frontmatter contains an unterminated quote.');
      }
      values[field[1]] = rawValue.slice(1, -1);
    } else {
      if (/^[>|][+-]?$/.test(rawValue)) {
        throw managedError('validation_failed', 'SKILL.md frontmatter block scalars are unsupported.');
      }
      values[field[1]] = rawValue;
    }
  }
  return values;
}

async function validateReferences(root, markdownEntries) {
  const resolvedRoot = await realpath(root);
  for (const entry of markdownEntries) {
    const content = entry.content.toString('utf8');
    for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const rawTarget = match[1].trim().split(/\s+/)[0];
      if (!rawTarget || rawTarget.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) continue;
      let target;
      try {
        target = decodeURIComponent(rawTarget.split('#')[0].split('?')[0]);
      } catch {
        throw managedError('validation_failed', `Invalid encoded reference in ${entry.relativePath}.`);
      }
      if (!target) continue;
      const lexicalTarget = resolve(dirname(entry.path), target);
      if (!isContained(resolvedRoot, lexicalTarget)) {
        throw managedError('validation_failed', `Reference escapes the candidate: ${rawTarget}`);
      }
      const resolvedTarget = await realpath(lexicalTarget).catch(() => null);
      if (!resolvedTarget || !isContained(resolvedRoot, resolvedTarget)) {
        throw managedError('validation_failed', `Referenced resource is missing or unsafe: ${rawTarget}`);
      }
    }
  }
}

function hashEntries(entries, includeSymlinks) {
  const hash = createHash('sha256');
  for (const entry of entries) {
    if (entry.type === 'file') {
      hash.update(entry.relativePath);
      hash.update(entry.content);
    } else if (includeSymlinks && entry.type === 'symlink') {
      hash.update(entry.relativePath);
      hash.update('symlink\0');
      hash.update(entry.link);
    }
  }
  return hash.digest('hex');
}

async function renderedHashForRoot(root) {
  return hashEntries(await enumerateTree(root), true);
}

export async function verifyManagedRendering({ repositoryRoot, managed }) {
  const resolvedRepositoryRoot = await realpath(repositoryRoot);
  const targets = [];
  const seen = new Set();
  for (const storedTarget of managed.physicalTargets) {
    const target = resolve(resolvedRepositoryRoot, storedTarget);
    const info = await lstat(target).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      throw managedError('untracked_change', 'A managed Rendering target is missing or not a real directory.');
    }
    const resolvedTarget = await realpath(target);
    if (!isContained(resolvedRepositoryRoot, resolvedTarget)) {
      throw managedError('invalid_publication_target', 'A managed Rendering target resolves outside the project.');
    }
    if (seen.has(resolvedTarget)) continue;
    seen.add(resolvedTarget);
    if ((await renderedHashForRoot(resolvedTarget)) !== managed.renderedHash) {
      throw managedError('untracked_change', 'A managed Rendering does not match managed state.');
    }
    targets.push(resolvedTarget);
  }
  if (targets.length === 0) {
    throw managedError('untracked_change', 'The managed Skill has no readable Rendering target.');
  }
  return targets;
}

export async function createCandidateSnapshot(root) {
  const entries = await enumerateTree(root);
  return entries
    .filter(({ type }) => type !== 'directory')
    .map((entry) => ({
      path: entry.relativePath,
      type: entry.type,
      ...(entry.type === 'file'
        ? { content: entry.content.toString('base64') }
        : { target: entry.link }),
    }));
}

export function diffCandidateSnapshots(before, after) {
  const previous = new Map(before.map((entry) => [entry.path, entry]));
  const current = new Map(after.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...previous.keys(), ...current.keys()])].sort((left, right) =>
    left.localeCompare(right),
  );
  return paths.flatMap((path) => {
    const prior = previous.get(path);
    const next = current.get(path);
    if (prior && next && JSON.stringify(prior) === JSON.stringify(next)) return [];
    const asText = (entry) =>
      entry?.type === 'file' ? Buffer.from(entry.content, 'base64').toString('utf8') : null;
    return [
      {
        path,
        status: prior ? (next ? 'modified' : 'deleted') : 'added',
        before: asText(prior),
        after: asText(next),
        ...(prior?.type === 'symlink' ? { beforeTarget: prior.target } : {}),
        ...(next?.type === 'symlink' ? { afterTarget: next.target } : {}),
      },
    ];
  });
}

async function readStagingLock(workDir, skill, source, expectedUpstreamHash) {
  const path = join(workDir, 'skills-lock.json');
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw managedError('validation_failed', 'The pinned upstream CLI did not produce a regular skills-lock.json.');
  }
  let lock;
  try {
    lock = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw managedError('validation_failed', 'The staging skills-lock.json is malformed.');
  }
  const entry = lock?.version === 1 && lock.skills && lock.skills[skill];
  if (!entry || !/^[a-f0-9]{64}$/.test(entry.computedHash || '')) {
    throw managedError('validation_failed', 'The staging lock is missing the selected skill identity or hash.');
  }
  if (expectedUpstreamHash && entry.computedHash !== expectedUpstreamHash) {
    throw managedError('validation_failed', 'The pristine candidate does not match its upstream computed hash.');
  }
  if (normalizedSource(entry.source || '') !== normalizedSource(source)) {
    throw managedError('validation_failed', 'The staging lock identity does not match the proposed source.');
  }
  return entry;
}

export async function validateCandidate({
  candidateRoot,
  workDir,
  operation,
  checkDirectoryName = true,
  allowCustomized = false,
}) {
  if (checkDirectoryName && basename(candidateRoot) !== operation.skill) {
    throw managedError('validation_failed', 'Candidate directory does not match the selected skill identifier.');
  }
  const entries = await enumerateTree(candidateRoot);
  const skillEntry = entries.find(({ relativePath, type }) => relativePath === 'SKILL.md' && type === 'file');
  if (!skillEntry) throw managedError('validation_failed', 'Candidate requires a regular SKILL.md.');
  const frontmatter = parseFrontmatter(skillEntry.content.toString('utf8'));
  if (frontmatter.name !== operation.skill) {
    throw managedError('validation_failed', 'SKILL.md name must match the candidate directory.');
  }
  if (!frontmatter.description || frontmatter.description.length > 1024) {
    throw managedError('validation_failed', 'SKILL.md description must be non-empty and at most 1024 characters.');
  }
  await validateReferences(
    candidateRoot,
    entries.filter(({ type, relativePath }) => type === 'file' && relativePath.endsWith('.md')),
  );
  const upstreamHash = hashEntries(entries, false);
  const lockEntry = await readStagingLock(
    workDir,
    operation.skill,
    operation.source,
    allowCustomized ? null : upstreamHash,
  );
  return {
    files: entries.filter(({ type }) => type !== 'directory').map(({ relativePath }) => relativePath),
    upstreamHash: lockEntry.computedHash,
    renderedHash: hashEntries(entries, true),
    lockEntry,
  };
}

function relativeProjectPath(repositoryRoot, path) {
  const value = relative(repositoryRoot, path).split('\\').join('/');
  if (!value || value.startsWith('..') || isAbsolute(value)) {
    throw managedError('invalid_publication_target', 'Topology target escapes the project.');
  }
  return value;
}

function observedTopologyTargets(observation) {
  return observation.targets.map((target) => ({
    path: relativeProjectPath(observation.repositoryRoot, target.path),
    kind: target.kind,
    role: target.role,
    ...(target.linkTarget === undefined ? {} : { linkTarget: target.linkTarget }),
    ...(target.dangling ? { dangling: true } : {}),
    ...(target.resolvedPath === undefined
      ? {}
      : {
          resolvedPath: isContained(observation.repositoryRoot, target.resolvedPath)
            ? relativeProjectPath(observation.repositoryRoot, target.resolvedPath)
            : target.resolvedPath,
        }),
  }));
}

export async function planProjectTopology(manifest) {
  const observation = await inspectEnvironment({
    repositoryRoot: manifest.repositoryRoot,
    currentRuntime: manifest.operation.runtime,
    scope: 'project',
    environment: process.env,
  });
  const skill = manifest.operation.skill;
  const observedTargets = observedTopologyTargets(observation);
  const existingLinks = observation.targets
    .filter(({ kind, dangling }) => kind === 'symbolic_link' && !dangling)
    .map((target) => ({
      path: relativeProjectPath(observation.repositoryRoot, target.path),
      target: isAbsolute(target.linkTarget)
        ? relative(dirname(target.path), target.resolvedPath).split('\\').join('/')
        : target.linkTarget,
      resolvedPath: relativeProjectPath(observation.repositoryRoot, target.resolvedPath),
    }));
  const runtimeDirectories = [...new Set(observation.runtimes.map(({ skillsDirectory }) => skillsDirectory))];
  const asSkillTargets = (directories) =>
    [...new Set(directories)].map((directory) => relativeProjectPath(observation.repositoryRoot, join(directory, skill)));

  if (['copies', 'mixed'].includes(observation.topology)) {
    const directories = [];
    const seenDirectories = new Set();
    const directoryReplacements = [];
    for (const target of observation.targets) {
      const directory =
        target.kind === 'symbolic_link' && !target.dangling ? target.resolvedPath : target.path;
      if (!seenDirectories.has(directory)) {
        seenDirectories.add(directory);
        directories.push(directory);
      }
      if (target.kind === 'symbolic_link' && target.dangling) {
        directoryReplacements.push({
          path: relativeProjectPath(observation.repositoryRoot, target.path),
          linkTarget: target.linkTarget,
        });
      }
    }
    return {
      requiresCopyConfirmation: true,
      mode: 'copies',
      physicalTargets: asSkillTargets(directories),
      links: [],
      directoryReplacements,
      existingLinks,
      observedTargets,
      observed: observation.topology,
    };
  }

  if (observation.topology === 'empty' && runtimeDirectories.length === 1) {
    return {
      requiresCopyConfirmation: false,
      mode: 'single',
      physicalTargets: asSkillTargets(runtimeDirectories),
      links: [],
      directoryReplacements: [],
      existingLinks,
      observedTargets,
      observed: observation.topology,
    };
  }

  let canonicalDirectory;
  if (observation.topology === 'canonical_links' || observation.topology === 'single') {
    canonicalDirectory = observation.targets.find(({ role }) => role === 'canonical')?.resolvedPath;
  }
  canonicalDirectory ||= join(observation.repositoryRoot, '.agents/skills');
  const links = observation.targets
    .filter(({ kind, path }) => kind === 'missing' && path !== canonicalDirectory)
    .map(({ path }) => ({
      path: relativeProjectPath(observation.repositoryRoot, path),
      target: relative(dirname(path), canonicalDirectory).split('\\').join('/'),
    }));
  return {
    requiresCopyConfirmation: false,
    mode: runtimeDirectories.length > 1 || links.length > 0 ? 'canonical_links' : 'single',
    physicalTargets: asSkillTargets([canonicalDirectory]),
    links,
    directoryReplacements: [],
    existingLinks,
    observedTargets,
    observed: observation.topology,
  };
}

export async function validateAttempt({ workDir }) {
  const { manifest, resolvedWorkDir } = await loadManifest(workDir);
  try {
    if (manifest.phase !== 'assessed') {
      throw managedError('validation_failed', 'This Update attempt is not ready for validation.');
    }
    const validation = await validateCandidate({
      candidateRoot: manifest.candidateRoot,
      workDir: resolvedWorkDir,
      operation: manifest.operation,
      allowCustomized: manifest.operation.type !== 'install',
    });
    if (
      manifest.operation.type !== 'install' &&
      (validation.upstreamHash !== manifest.baselineValidation?.upstreamHash ||
        createHash('sha256').update(JSON.stringify(validation.lockEntry)).digest('hex') !==
          manifest.baselineValidation?.lockEntryHash)
    ) {
      throw managedError('validation_failed', 'The pristine upstream lock changed after the work order.');
    }
    const topology = await planProjectTopology(manifest);
    const acceptedCandidateHash = validation.renderedHash;
    const review = {
      currentRendering: null,
      files: validation.files,
      renderedHash: validation.renderedHash,
      topology: {
        mode: topology.mode,
        physicalTargets: topology.physicalTargets,
        links: topology.links,
      },
      ...(manifest.semanticReview || {}),
    };
    await saveManifest(resolvedWorkDir, {
      ...manifest,
      phase: topology.requiresCopyConfirmation
        ? 'awaiting_topology_confirmation'
        : 'awaiting_publication',
      validation: {
        valid: true,
        acceptedCandidateHash,
        upstreamHash: validation.upstreamHash,
        acceptedLockEntryHash: createHash('sha256')
          .update(JSON.stringify(validation.lockEntry))
          .digest('hex'),
      },
      topology,
      review,
    });
    if (topology.requiresCopyConfirmation) {
      return {
        envelopeStatus: 'conflict',
        reason: 'copy_topology_requires_confirmation',
        workDir,
        operation: manifest.operation,
        observedTopology: topology.observed,
        targets: topology.physicalTargets,
        topology: { observed: topology.observed, targets: topology.observedTargets },
        choices: ['accept_copy_mode', 'cancel'],
      };
    }
    return {
      workDir,
      operation: manifest.operation,
      candidate: { root: manifest.candidateRoot },
      validation: { valid: true, acceptedCandidateHash },
      review,
    };
  } catch (error) {
    await rm(resolvedWorkDir, { recursive: true, force: true });
    if (!error.code) error.code = 'validation_failed';
    throw error;
  }
}

async function readJsonState(path, kind) {
  const info = await lstat(path).catch(() => null);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw managedError(`invalid_${kind}`, `${kind} must be a regular file.`);
  }
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    const repositoryRoot = kind === 'managed_state' ? dirname(dirname(path)) : dirname(path);
    const storedPathIsContained = (storedPath) =>
      typeof storedPath === 'string' &&
      storedPath &&
      !isAbsolute(storedPath) &&
      isContained(repositoryRoot, resolve(repositoryRoot, storedPath));
    if (
      value?.version !== 1 ||
      value.skills === null ||
      typeof value.skills !== 'object' ||
      Array.isArray(value.skills)
    ) {
      throw new Error();
    }
    for (const entry of Object.values(value.skills)) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error();
      if (kind === 'lock') {
        if (
          typeof entry.source !== 'string' ||
          !entry.source ||
          typeof entry.sourceType !== 'string' ||
          !/^[a-f0-9]{64}$/.test(entry.computedHash || '') ||
          (entry.skillPath !== undefined && typeof entry.skillPath !== 'string')
        ) {
          throw new Error();
        }
      } else if (
        entry.identity === null ||
        typeof entry.identity !== 'object' ||
        typeof entry.identity.source !== 'string' ||
        typeof entry.identity.skill !== 'string' ||
        typeof entry.installName !== 'string' ||
        !['project', 'global'].includes(entry.scope) ||
        !/^[a-f0-9]{64}$/.test(entry.upstreamHash || '') ||
        !/^[a-f0-9]{64}$/.test(entry.renderedHash || '') ||
        !/^[a-f0-9]{64}$/.test(entry.desiredRenderedHash || '') ||
        !/^[a-f0-9]{64}$/.test(entry.effectiveIntentsHash || '') ||
        !Array.isArray(entry.physicalTargets) ||
        !entry.physicalTargets.every(storedPathIsContained) ||
        (entry.topologyLinks !== undefined &&
          (!Array.isArray(entry.topologyLinks) ||
            !entry.topologyLinks.every(
              (link) =>
                link !== null &&
                typeof link === 'object' &&
                typeof link.path === 'string' &&
                storedPathIsContained(link.path) &&
                typeof link.target === 'string' &&
                link.target &&
                !isAbsolute(link.target) &&
                isContained(
                  repositoryRoot,
                  resolve(dirname(resolve(repositoryRoot, link.path)), link.target),
                ) &&
                (link.resolvedPath === undefined ||
                  storedPathIsContained(link.resolvedPath)),
            )))
      ) {
        throw new Error();
      }
    }
    return value;
  } catch {
    throw managedError(`invalid_${kind}`, `${kind} has an unsupported or malformed schema.`);
  }
}

export async function readManagedState(repositoryRoot) {
  return readJsonState(join(repositoryRoot, '.skills-manager/state.json'), 'managed_state');
}

export async function assertContainedStateDirectory(repositoryRoot, stateDirectory) {
  const info = await lstat(stateDirectory).catch(() => null);
  if (info?.isSymbolicLink() || (info && !info.isDirectory())) {
    throw managedError('invalid_publication_target', 'Managed-state directory must be a real project directory.');
  }
  let existing = info ? stateDirectory : dirname(stateDirectory);
  while (!(await lstat(existing).catch(() => null))) existing = dirname(existing);
  const resolved = await realpath(existing);
  if (!isContained(repositoryRoot, resolved)) {
    throw managedError('invalid_publication_target', 'Managed-state directory resolves outside the project.');
  }
}

async function assertContainedExistingAncestor(repositoryRoot, path) {
  let existing = path;
  while (!(await lstat(existing).catch(() => null))) existing = dirname(existing);
  const resolved = await realpath(existing).catch(() => null);
  if (!resolved || !isContained(repositoryRoot, resolved)) {
    throw managedError('invalid_publication_target', 'A publication parent resolves outside the project.');
  }
}

async function ensureContainedDirectory(repositoryRoot, directory) {
  let existing = directory;
  const missingDirectories = [];
  while (!(await lstat(existing).catch(() => null))) {
    missingDirectories.push(existing);
    existing = dirname(existing);
  }
  const resolvedExisting = await realpath(existing);
  if (!isContained(repositoryRoot, resolvedExisting)) {
    throw managedError('invalid_publication_target', 'Publication target resolves outside the project.');
  }
  try {
    await mkdir(directory, { recursive: true });
    const resolvedDirectory = await realpath(directory);
    if (!isContained(repositoryRoot, resolvedDirectory)) {
      throw managedError('invalid_publication_target', 'Publication target resolves outside the project.');
    }
    return missingDirectories;
  } catch (error) {
    for (const path of missingDirectories) await rmdir(path).catch(() => {});
    throw error;
  }
}

async function atomicWriteJson(path, value, nonce) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${nonce}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function snapshot(path) {
  const info = await lstat(path).catch(() => null);
  return info?.isFile() && !info.isSymbolicLink() ? readFile(path) : null;
}

async function restore(path, content) {
  if (content === null) await rm(path, { force: true });
  else await writeFile(path, content);
}

function normalizedSource(source) {
  return source.trim().replace(/\/+$/, '').toLowerCase();
}

export async function publishAttempt({ workDir }) {
  const { manifest, resolvedWorkDir } = await loadManifest(workDir);
  if (manifest.phase !== 'awaiting_publication' || manifest.operation.scope !== 'project') {
    throw managedError('invalid_continuation', 'This Update attempt is not ready for project publication.');
  }
  const repositoryRoot = await realpath(manifest.repositoryRoot).catch(() => null);
  if (!repositoryRoot) throw managedError('invalid_publication_target', 'The project root is unavailable.');
  const currentObservation = await inspectEnvironment({
    repositoryRoot,
    currentRuntime: manifest.operation.runtime,
    scope: 'project',
    environment: process.env,
  });
  if (
    JSON.stringify(observedTopologyTargets(currentObservation)) !==
    JSON.stringify(manifest.topology?.observedTargets)
  ) {
    throw managedError('topology_changed', 'Repository Agent topology changed after review.');
  }
  const relativeTargets = manifest.topology?.physicalTargets;
  const plannedLinks = manifest.topology?.links;
  const plannedDirectoryReplacements = manifest.topology?.directoryReplacements;
  if (
    !Array.isArray(relativeTargets) ||
    relativeTargets.length === 0 ||
    new Set(relativeTargets).size !== relativeTargets.length ||
    !relativeTargets.every((path) => typeof path === 'string') ||
    !Array.isArray(plannedLinks) ||
    !Array.isArray(plannedDirectoryReplacements)
  ) {
    throw managedError('invalid_publication_target', 'The publication topology is missing or invalid.');
  }
  const targets = relativeTargets.map((path) => resolve(repositoryRoot, path));
  if (targets.some((target) => !isContained(repositoryRoot, target))) {
    throw managedError('invalid_publication_target', 'A publication target escapes the project.');
  }
  const links = plannedLinks.map((link) => ({
    ...link,
    absolutePath: resolve(repositoryRoot, link.path),
  }));
  if (
    links.some(
      ({ path, target, absolutePath }) =>
        typeof path !== 'string' ||
        typeof target !== 'string' ||
        isAbsolute(target) ||
        !isContained(repositoryRoot, absolutePath) ||
        !isContained(repositoryRoot, resolve(dirname(absolutePath), target)),
    )
  ) {
    throw managedError('invalid_publication_target', 'A planned topology link is invalid.');
  }
  const directoryReplacements = plannedDirectoryReplacements.map((replacement) => ({
    ...replacement,
    absolutePath: resolve(repositoryRoot, replacement.path),
  }));
  if (
    directoryReplacements.some(
      ({ path, linkTarget, absolutePath }) =>
        typeof path !== 'string' ||
        typeof linkTarget !== 'string' ||
        !isContained(repositoryRoot, absolutePath),
    )
  ) {
    throw managedError('invalid_publication_target', 'A planned directory replacement is invalid.');
  }
  const replacementPaths = new Set(directoryReplacements.map(({ absolutePath }) => absolutePath));
  for (const path of [
    ...targets.map((target) => {
      const targetDirectory = dirname(target);
      return replacementPaths.has(targetDirectory) ? dirname(targetDirectory) : targetDirectory;
    }),
    ...links.map(({ absolutePath }) => dirname(absolutePath)),
    ...directoryReplacements.map(({ absolutePath }) => dirname(absolutePath)),
  ]) {
    await assertContainedExistingAncestor(repositoryRoot, path);
  }
  for (const path of links.map(({ absolutePath }) => absolutePath)) {
    if (await lstat(path).catch(() => null)) {
      throw managedError('invalid_publication_target', 'A planned publication path already exists.');
    }
  }

  let validation;
  try {
    validation = await validateCandidate({
      candidateRoot: manifest.candidateRoot,
      workDir: resolvedWorkDir,
      operation: manifest.operation,
      allowCustomized: manifest.operation.type !== 'install',
    });
    if (validation.renderedHash !== manifest.validation?.acceptedCandidateHash) {
      throw managedError('validation_failed', 'The candidate changed after review.');
    }
    const lockEntryHash = createHash('sha256').update(JSON.stringify(validation.lockEntry)).digest('hex');
    if (lockEntryHash !== manifest.validation?.acceptedLockEntryHash) {
      throw managedError('validation_failed', 'The staging lock identity changed after review.');
    }
  } catch (error) {
    if (error.code === 'validation_failed') {
      await rm(resolvedWorkDir, { recursive: true, force: true });
    }
    throw error;
  }
  const statePath = join(repositoryRoot, '.skills-manager/state.json');
  const lockPath = join(repositoryRoot, 'skills-lock.json');
  await assertContainedStateDirectory(repositoryRoot, dirname(statePath));
  const stateDirectoryExisted = Boolean(await lstat(dirname(statePath)).catch(() => null));
  const existingState = (await readJsonState(statePath, 'managed_state')) || { version: 1, skills: {} };
  const existingLock = (await readJsonState(lockPath, 'lock')) || { version: 1, skills: {} };
  const source = normalizedSource(manifest.operation.source);
  const upstreamSkill = validation.lockEntry.skillPath || manifest.operation.skill;
  const identity = { source, skill: upstreamSkill };
  const matchingIdentities = Object.values(existingState.skills)
    .filter((entry) => entry.installName === manifest.operation.skill)
    .map((entry) => entry.identity);
  const existingIdentity = matchingIdentities[0];
  const existingManagedSkill = Object.values(existingState.skills).find(
    (entry) => entry.installName === manifest.operation.skill,
  );
  const existingLockEntry = existingLock.skills[manifest.operation.skill];
  const differentIdentity =
    matchingIdentities.length > 1 ||
    matchingIdentities.some(
      (candidate) => normalizedSource(candidate.source) !== source || candidate.skill !== upstreamSkill,
    ) ||
    (existingLockEntry &&
      (normalizedSource(existingLockEntry.source) !== source ||
        (existingLockEntry.skillPath || manifest.operation.skill) !== upstreamSkill));
  if (differentIdentity) {
    throw conflictError({
      reason: 'skill_identity_collision',
      installName: manifest.operation.skill,
      existing: existingIdentity || {
        source: normalizedSource(existingLockEntry.source),
        skill: existingLockEntry.skillPath || manifest.operation.skill,
      },
      proposed: identity,
      choices: ['cancel'],
    });
  }
  if (
    manifest.operation.type !== 'install' &&
    JSON.stringify(existingManagedSkill) !== JSON.stringify(manifest.operation.baselineManagedState)
  ) {
    const error = new Error('Managed Skill state changed while this Intent operation was pending.');
    error.status = 'conflict';
    error.data = {
      reason: 'operation_baseline_changed',
      choices: ['restart', 'cancel'],
    };
    throw error;
  }
  if (manifest.operation.type === 'install') {
    for (const target of targets) {
      if (await lstat(target).catch(() => null)) {
        throw managedError('invalid_publication_target', 'A planned publication path already exists.');
      }
    }
  } else {
    if (!existingManagedSkill) {
      throw managedError('managed_skill_not_found', 'The managed Skill disappeared before publication.');
    }
    for (const target of targets) {
      const info = await lstat(target).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) {
        throw managedError('untracked_change', 'A managed Rendering target is missing or no longer a real directory.');
      }
      if ((await renderedHashForRoot(target)) !== existingManagedSkill.renderedHash) {
        throw managedError('untracked_change', 'A managed Rendering changed after the Intent review began.');
      }
    }
  }
  const identityHash = createHash('sha256')
    .update(source)
    .update('\0')
    .update(upstreamSkill)
    .digest('hex');
  const managedSkill = {
    identity,
    installName: manifest.operation.skill,
    scope: 'project',
    upstreamHash: validation.lockEntry.computedHash,
    renderedHash: validation.renderedHash,
    desiredRenderedHash: validation.renderedHash,
    effectiveIntentsHash:
      manifest.effectiveIntentsHash || createHash('sha256').update('[]').digest('hex'),
    physicalTargets: relativeTargets,
    topologyLinks: [...(manifest.topology.existingLinks || []), ...plannedLinks],
  };
  const nextState = {
    version: 1,
    skills: { ...existingState.skills, [identityHash]: managedSkill },
  };
  const preparedState =
    manifest.operation.type === 'install'
      ? nextState
      : {
          version: 1,
          skills: {
            ...nextState.skills,
            [identityHash]: {
              ...managedSkill,
              renderedHash: existingManagedSkill.renderedHash,
            },
          },
        };
  const nextLock = {
    version: 1,
    skills: { ...existingLock.skills, [manifest.operation.skill]: validation.lockEntry },
  };
  let intentPublication = null;
  if (manifest.operation.type !== 'install') {
    const relativePath =
      manifest.candidateIntentState?.relativePath || manifest.operation.intentStateRelativePath;
    const record = manifest.candidateIntentState?.record;
    const intentsDirectory = join(repositoryRoot, '.skills-manager/intents');
    const absolutePath = resolve(repositoryRoot, relativePath || '');
    const expectedRelativePath = `.skills-manager/intents/${manifest.operation.skill}__${identityHash.slice(0, 8)}.json`;
    if (
      relativePath !== expectedRelativePath ||
      !isContained(intentsDirectory, absolutePath) ||
      (record && JSON.stringify(record.identity) !== JSON.stringify(identity))
    ) {
      throw managedError('invalid_intent_state', 'The candidate Intent state is invalid or mismatched.');
    }
    if (record) intentPublication = { absolutePath, intentsDirectory, record };
    await assertContainedStateDirectory(repositoryRoot, intentsDirectory);
    const currentIntentSnapshot = await snapshot(absolutePath);
    const currentIntentHash = createHash('sha256')
      .update(currentIntentSnapshot === null ? 'null' : currentIntentSnapshot)
      .digest('hex');
    if (currentIntentHash !== manifest.operation.baselineIntentStateHash) {
      const error = new Error('Intent state changed while this operation was pending.');
      error.status = 'conflict';
      error.data = {
        reason: 'operation_baseline_changed',
        choices: ['restart', 'cancel'],
      };
      throw error;
    }
  }

  const replacementsByDirectory = new Map(
    directoryReplacements.map((replacement) => [replacement.absolutePath, replacement]),
  );
  const siblings = targets.map((target, index) => {
    const targetDirectory = dirname(target);
    const siblingDirectory = replacementsByDirectory.has(targetDirectory)
      ? dirname(targetDirectory)
      : targetDirectory;
    return join(
      siblingDirectory,
      `.${manifest.operation.skill}.skills-manager-${manifest.nonce}-${index}`,
    );
  });
  const createdDirectories = new Set();
  const replacedDirectories = [];
  const publishedTargets = [];
  const targetBackups = [];
  const createdLinks = [];
  let stateSnapshot;
  let lockSnapshot;
  let intentSnapshot;
  let intentDirectoryExisted;
  try {
    for (const path of [...siblings.map(dirname), ...links.map(({ absolutePath }) => dirname(absolutePath))]) {
      for (const created of await ensureContainedDirectory(repositoryRoot, path)) {
        createdDirectories.add(created);
      }
    }
    for (const sibling of siblings) {
      await cp(manifest.candidateRoot, sibling, {
        recursive: true,
        errorOnExist: true,
        verbatimSymlinks: true,
      });
      const siblingValidation = await validateCandidate({
        candidateRoot: sibling,
        workDir: resolvedWorkDir,
        operation: manifest.operation,
        checkDirectoryName: false,
        allowCustomized: manifest.operation.type !== 'install',
      });
      if (siblingValidation.renderedHash !== manifest.validation.acceptedCandidateHash) {
        throw managedError('validation_failed', 'A publication sibling changed during preparation.');
      }
    }
    stateSnapshot = await snapshot(statePath);
    lockSnapshot = await snapshot(lockPath);
    if (intentPublication) {
      intentDirectoryExisted = Boolean(await lstat(intentPublication.intentsDirectory).catch(() => null));
      intentSnapshot = await snapshot(intentPublication.absolutePath);
      await atomicWriteJson(intentPublication.absolutePath, intentPublication.record, manifest.nonce);
    }
    await atomicWriteJson(statePath, preparedState, manifest.nonce);
    await atomicWriteJson(lockPath, nextLock, manifest.nonce);
    for (let index = 0; index < targets.length; index += 1) {
      const replacement = replacementsByDirectory.get(dirname(targets[index]));
      if (replacement) {
        const info = await lstat(replacement.absolutePath).catch(() => null);
        if (
          !info?.isSymbolicLink() ||
          (await readlink(replacement.absolutePath)) !== replacement.linkTarget
        ) {
          throw managedError(
            'invalid_publication_target',
            'A confirmed broken-link target changed before publication.',
          );
        }
        await rm(replacement.absolutePath);
        await mkdir(replacement.absolutePath);
        replacedDirectories.push(replacement);
      }
      if (manifest.operation.type !== 'install') {
        const backup = join(
          dirname(targets[index]),
          `.${manifest.operation.skill}.skills-manager-backup-${manifest.nonce}-${index}`,
        );
        await rename(targets[index], backup);
        targetBackups.push({ target: targets[index], backup });
      }
      await rename(siblings[index], targets[index]);
      publishedTargets.push(targets[index]);
    }
    for (const link of links) {
      await symlink(link.target, link.absolutePath, 'dir');
      createdLinks.push(link.absolutePath);
      const resolvedLink = await realpath(link.absolutePath);
      if (!isContained(repositoryRoot, resolvedLink)) {
        throw managedError('invalid_publication_target', 'Published topology link escapes the project.');
      }
    }
    if (preparedState !== nextState) {
      await atomicWriteJson(statePath, nextState, manifest.nonce);
    }
  } catch (error) {
    for (const link of createdLinks.reverse()) await rm(link, { force: true });
    for (const target of publishedTargets.reverse()) await rm(target, { recursive: true, force: true });
    for (const { target, backup } of targetBackups.reverse()) {
      await rename(backup, target).catch(() => {});
    }
    for (const sibling of siblings) await rm(sibling, { recursive: true, force: true });
    for (const replacement of replacedDirectories.reverse()) {
      await rmdir(replacement.absolutePath).catch(() => {});
      await symlink(replacement.linkTarget, replacement.absolutePath, 'dir').catch(() => {});
    }
    if (stateSnapshot !== undefined) await restore(statePath, stateSnapshot);
    if (lockSnapshot !== undefined) await restore(lockPath, lockSnapshot);
    if (intentPublication && intentSnapshot !== undefined) {
      await restore(intentPublication.absolutePath, intentSnapshot);
      if (!intentDirectoryExisted) await rmdir(intentPublication.intentsDirectory).catch(() => {});
    }
    if (!stateDirectoryExisted) await rmdir(dirname(statePath)).catch(() => {});
    for (const path of [...createdDirectories].sort((left, right) => right.length - left.length)) {
      await rmdir(path).catch(() => {});
    }
    if (error.code === 'validation_failed') {
      await rm(resolvedWorkDir, { recursive: true, force: true });
    }
    throw error;
  }
  const backupCleanupFailures = [];
  for (const { backup } of targetBackups) {
    try {
      await rm(backup, { recursive: true, force: true });
    } catch (error) {
      backupCleanupFailures.push({ backup, message: error.message });
    }
  }
  if (backupCleanupFailures.length > 0) {
    throw managedError(
      'publication_cleanup_failed',
      `The new Rendering is authoritative, but ${backupCleanupFailures.length} previous-Rendering backup(s) could not be removed.`,
    );
  }
  await rm(resolvedWorkDir, { recursive: true, force: true }).catch(() => {});
  return {
    operation: manifest.operation,
    identity: managedSkill.identity,
    targets,
    links: plannedLinks,
    state: { upstreamHash: managedSkill.upstreamHash, renderedHash: managedSkill.renderedHash },
  };
}
