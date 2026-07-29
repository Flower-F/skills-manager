// Observe filesystem state without mutating it.
import { lstat, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  RUNTIME_REGISTRY_VERSION,
  SUPPORTED_SKILLS_CLI_VERSION,
  runtimeRegistry,
} from './runtime-registry.mjs';

async function pathState(path) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      const linkTarget = await readlink(path);
      const unresolvedPath = resolve(dirname(path), linkTarget);
      try {
        return {
          kind: 'symbolic_link',
          linkTarget,
          resolvedPath: await realpath(path),
          dangling: false,
        };
      } catch {
        return {
          kind: 'symbolic_link',
          linkTarget,
          resolvedPath: unresolvedPath,
          dangling: true,
        };
      }
    }
    if (stat.isDirectory()) {
      return { kind: 'directory', resolvedPath: await realpath(path) };
    }
    return { kind: 'other', resolvedPath: await realpath(path) };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { kind: 'missing' };
    throw error;
  }
}

async function canonicalPathThroughExistingAncestor(path) {
  let existing = path;
  const suffix = [];
  while (!(await lstat(existing).catch(() => null))) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return join(await realpath(existing), ...suffix);
}

function topologyFor(targets) {
  const observed = targets.filter(({ kind }) => kind !== 'missing');
  if (observed.length === 0) return 'empty';
  const links = observed.filter(({ kind }) => kind === 'symbolic_link');
  const directories = observed.filter(({ kind }) => kind === 'directory');
  const physicalPaths = new Set(
    observed
      .filter(({ kind, dangling }) => kind === 'directory' || !dangling)
      .map(({ resolvedPath }) => resolvedPath),
  );
  if (links.length === 0) return directories.length <= 1 ? 'single' : 'copies';
  if (physicalPaths.size === 1 && !links.some(({ dangling }) => dangling)) return 'canonical_links';
  return 'mixed';
}

function roleFor(target, targets) {
  if (target.kind === 'missing') return 'planned';
  if (target.kind === 'symbolic_link') return 'link';
  if (target.kind !== 'directory') return 'unexpected';
  if (target.canonicalDirectory) return 'canonical';
  const isLinkDestination = targets.some(
    (candidate) =>
      candidate.kind === 'symbolic_link' &&
      !candidate.dangling &&
      candidate.resolvedPath === target.resolvedPath,
  );
  const directoryCount = targets.filter(({ kind }) => kind === 'directory').length;
  return isLinkDestination || directoryCount === 1 ? 'canonical' : 'copy';
}

function displayPath(path, scopeRoot) {
  if (!scopeRoot) return undefined;
  const value = relative(scopeRoot, path) || '.';
  return value.startsWith('..') || isAbsolute(value) ? undefined : value;
}

function skillsDirectoryFor(runtime, scope, repositoryRoot) {
  return scope === 'project'
    ? join(repositoryRoot, runtime.projectSkillsDirectory)
    : runtime.globalSkillsDirectory;
}

export async function inspectEnvironment({ repositoryRoot, currentRuntime, scope, environment }) {
  const registry = runtimeRegistry(environment);
  const current = registry.find(({ id }) => id === currentRuntime);
  if (!current) {
    const error = new Error(`Unsupported runtime: ${currentRuntime}`);
    error.code = 'unsupported_runtime';
    throw error;
  }

  const candidates = [];
  if (scope === 'global') {
    candidates.push({ runtime: current, evidence: ['current_runtime'] });
  } else {
    const projectDirectoryCounts = new Map();
    for (const runtime of registry) {
      projectDirectoryCounts.set(
        runtime.projectSkillsDirectory,
        (projectDirectoryCounts.get(runtime.projectSkillsDirectory) || 0) + 1,
      );
    }
    for (const runtime of registry) {
      const agentDirectoryState = await pathState(
        join(repositoryRoot, runtime.projectEvidenceDirectory),
      );
      const hasAgentDirectory = agentDirectoryState.kind !== 'missing';
      const isAmbiguousSharedDirectory =
        runtime.id !== currentRuntime &&
        !hasAgentDirectory &&
        projectDirectoryCounts.get(runtime.projectSkillsDirectory) > 1;
      if (isAmbiguousSharedDirectory) continue;
      const path = join(repositoryRoot, runtime.projectSkillsDirectory);
      const state = await pathState(path);
      if (runtime.id === currentRuntime || hasAgentDirectory || state.kind !== 'missing') {
        candidates.push({
          runtime,
          evidence: [
            ...(runtime.id === currentRuntime ? ['current_runtime'] : []),
            ...(hasAgentDirectory ? ['agent_directory'] : []),
            ...(state.kind !== 'missing' ? ['skills_directory'] : []),
          ],
        });
      }
    }
  }

  const grouped = new Map();
  const scopedDirectories = new Map();
  for (const { runtime } of candidates) {
    const directory = skillsDirectoryFor(runtime, scope, repositoryRoot);
    scopedDirectories.set(
      runtime.id,
      scope === 'global' ? await canonicalPathThroughExistingAncestor(directory) : directory,
    );
  }
  for (const candidate of candidates) {
    const path = scopedDirectories.get(candidate.runtime.id);
    const existing = grouped.get(path) || { path, runtimes: [] };
    existing.runtimes.push(candidate.runtime.id);
    grouped.set(path, existing);
  }
  if (scope === 'project') {
    const canonicalPath = join(repositoryRoot, '.agents/skills');
    const canonicalState = await pathState(canonicalPath);
    if (canonicalState.kind !== 'missing' && !grouped.has(canonicalPath)) {
      grouped.set(canonicalPath, {
        path: canonicalPath,
        runtimes: [],
        canonicalDirectory: true,
      });
    }
    const canonicalTarget = grouped.get(canonicalPath);
    if (canonicalTarget) canonicalTarget.canonicalDirectory = true;
  }

  const targets = [];
  for (const target of [...grouped.values()].sort((left, right) => left.path.localeCompare(right.path))) {
    targets.push({ ...target, ...(await pathState(target.path)) });
  }
  for (const target of targets) {
    target.runtimes.sort();
    target.role = roleFor(target, targets);
  }

  const runtimes = candidates
    .map(({ runtime, evidence }) => {
      const skillsDirectory = scopedDirectories.get(runtime.id);
      const target = targets.findIndex(({ path }) => path === skillsDirectory);
      const result = {
        id: runtime.id,
        skillsDirectory,
        ...(scope === 'project'
          ? { relativeSkillsDirectory: runtime.projectSkillsDirectory }
          : {}),
        evidence,
        target,
      };
      return result;
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const serializedTargets = targets.map((target) => ({
    path: target.path,
    ...(scope === 'project'
      ? { relativePath: displayPath(target.path, repositoryRoot) }
      : {}),
    kind: target.kind,
    role: target.role,
    runtimes: target.runtimes,
    ...(target.linkTarget === undefined ? {} : { linkTarget: target.linkTarget }),
    ...(target.resolvedPath === undefined ? {} : { resolvedPath: target.resolvedPath }),
    ...(target.dangling ? { dangling: true } : {}),
  }));

  return {
    repositoryRoot,
    scope,
    currentRuntime,
    compatibility: {
      node: { minimumMajor: 22, current: process.versions.node },
      skillsCli: { version: SUPPORTED_SKILLS_CLI_VERSION, telemetryDisabled: true },
      runtimeRegistry: RUNTIME_REGISTRY_VERSION,
    },
    topology: topologyFor(targets),
    runtimes,
    targets: serializedTargets,
  };
}
