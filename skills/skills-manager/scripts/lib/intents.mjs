import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertContainedStateDirectory,
  createCandidateSnapshot,
  diffCandidateSnapshots,
  readManagedState,
  validateAttempt,
  validateCandidate,
  verifyManagedRendering,
} from './publication.mjs';
import { assessCandidate, loadManifest, saveManifest } from './upstream.mjs';

const INTENT_MUTATION_TYPES = new Set([
  'intent_edit',
  'intent_disable',
  'intent_enable',
  'intent_delete',
  'intent_obsolete',
  'intent_suppress',
  'identity_migrate',
]);

function isManagedRenderOperation(type) {
  return type === 'update' || INTENT_MUTATION_TYPES.has(type);
}

function intentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizedIdentity(identity) {
  return {
    source: identity.source.trim().replace(/\/+$/, '').toLowerCase(),
    skill: identity.skill.replaceAll('\\', '/').replace(/^\.\//, ''),
  };
}

function identityHash(identity) {
  const normalized = normalizedIdentity(identity);
  return createHash('sha256').update(normalized.source).update('\0').update(normalized.skill).digest('hex');
}

function emptyIntentHash() {
  return createHash('sha256').update('null').digest('hex');
}

async function readIntentRecord(scopeRoot, managed) {
  const intentsDirectory = join(scopeRoot, '.skills-manager/intents');
  await assertContainedStateDirectory(scopeRoot, intentsDirectory);
  const relativePath = `.skills-manager/intents/${managed.installName}__${identityHash(managed.identity).slice(0, 8)}.json`;
  const path = join(scopeRoot, relativePath);
  const info = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!info) {
    return {
      intents: [],
      suppressedGlobalIntentIds: [],
      relativePath,
      stateHash: emptyIntentHash(),
      scopeRoot,
    };
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw intentError('invalid_intent_state', 'Intent state must be a regular file.');
  }
  try {
    const content = await readFile(path);
    const record = JSON.parse(content.toString('utf8'));
    if (
      record?.version !== 1 ||
      JSON.stringify(normalizedIdentity(record.identity || {})) !==
        JSON.stringify(normalizedIdentity(managed.identity)) ||
      record.installName !== managed.installName ||
      !Array.isArray(record.intents) ||
      (record.suppressedGlobalIntentIds !== undefined &&
        (!Array.isArray(record.suppressedGlobalIntentIds) ||
          !record.suppressedGlobalIntentIds.every((id) => typeof id === 'string') ||
          new Set(record.suppressedGlobalIntentIds).size !== record.suppressedGlobalIntentIds.length)) ||
      new Set(record.intents.map(({ id }) => id)).size !== record.intents.length ||
      !record.intents.every(
        (intent) =>
          typeof intent?.id === 'string' &&
          typeof intent.text === 'string' &&
          intent.text.length > 0 &&
          intent.text.length <= 500 &&
          !/[\r\n]/.test(intent.text) &&
          ['active', 'disabled', 'expired'].includes(intent.state) &&
          (intent.state !== 'expired' ||
            (typeof intent.obsoleteReason === 'string' &&
              intent.obsoleteReason.length > 0 &&
              intent.obsoleteReason.length <= 1000)),
      )
    ) {
      throw new Error();
    }
    return {
      ...record,
      suppressedGlobalIntentIds: record.suppressedGlobalIntentIds || [],
      relativePath,
      stateHash: createHash('sha256').update(content).digest('hex'),
      scopeRoot,
    };
  } catch {
    throw intentError('invalid_intent_state', 'Intent state has an unsupported or malformed schema.');
  }
}

function scopeRootFor(scope, repositoryRoot, environment) {
  if (scope === 'project') return repositoryRoot;
  const root = environment?.HOME;
  if (!root) throw intentError('missing_global_root', 'Global Intent scope requires HOME.');
  return root;
}

function intentConflict(data, message = 'Scoped Intent interpretations require a user decision.') {
  const error = new Error(message);
  error.status = 'conflict';
  error.data = data;
  return error;
}

function effectiveIntentsFor(projectRecord, globalRecord) {
  const suppressed = new Set(projectRecord.suppressedGlobalIntentIds);
  const active = [
    ...globalRecord.intents
      .filter(({ state, id }) => state === 'active' && !suppressed.has(id))
      .map((intent) => ({ ...intent, scopes: ['global'] })),
    ...projectRecord.intents
      .filter(({ state }) => state === 'active')
      .map((intent) => ({ ...intent, scopes: ['project'] })),
  ];
  const byId = new Map();
  for (const intent of active) {
    const existing = byId.get(intent.id);
    if (!existing) {
      byId.set(intent.id, intent);
    } else if (existing.text !== intent.text) {
      throw intentConflict({
        reason: 'scoped_intent_collision',
        intentId: intent.id,
        interpretations: [existing, intent]
          .flatMap((entry) => entry.scopes.map((scope) => ({ scope, text: entry.text })))
          .sort((left, right) => left.scope.localeCompare(right.scope)),
        choices: ['edit_project', 'suppress_global', 'cancel'],
      });
    } else {
      existing.scopes = [...new Set([...existing.scopes, ...intent.scopes])].sort();
    }
  }
  return [...byId.values()];
}

function effectiveIntentsHash(intents) {
  const semanticRules = intents
    .map(({ id, text }) => ({ id, text }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash('sha256').update(JSON.stringify(semanticRules)).digest('hex');
}

async function readScopedIntents({ repositoryRoot, managed, environment, resolveEffective = true }) {
  const project = await readIntentRecord(repositoryRoot, managed);
  const globalRoot = scopeRootFor('global', repositoryRoot, environment);
  const global = await readIntentRecord(globalRoot, managed);
  return {
    project,
    global,
    ...(resolveEffective ? { effectiveIntents: effectiveIntentsFor(project, global) } : {}),
    baselines: [project, global].map(({ scopeRoot, relativePath, stateHash }, index) => ({
      scope: index === 0 ? 'project' : 'global',
      scopeRoot,
      relativePath,
      stateHash,
    })),
  };
}

function intentScopesForOperation(scoped) {
  return Object.fromEntries(
    ['project', 'global'].map((scope) => {
      const record = scoped[scope];
      return [
        scope,
        {
          intents: record.intents,
          suppressedGlobalIntentIds: record.suppressedGlobalIntentIds,
          scopeRoot: record.scopeRoot,
          relativePath: record.relativePath,
        },
      ];
    }),
  );
}

async function currentManagedForOperation(manifest) {
  const state = await readManagedState(manifest.repositoryRoot);
  const matches = Object.values(state?.skills || {}).filter(
    (entry) =>
      entry.installName === manifest.operation.skill &&
      JSON.stringify(entry.identity) === JSON.stringify(manifest.operation.identity),
  );
  if (matches.length !== 1) {
    throw intentError('invalid_managed_state', 'Managed Skill identity changed during the operation.');
  }
  if (JSON.stringify(matches[0]) !== JSON.stringify(manifest.operation.baselineManagedState)) {
    const error = new Error('Managed Skill state changed while this operation was pending.');
    error.status = 'conflict';
    error.data = { reason: 'operation_baseline_changed', choices: ['restart', 'cancel'] };
    throw error;
  }
  const targets = await verifyManagedRendering({
    repositoryRoot: manifest.repositoryRoot,
    managed: matches[0],
  });
  return { managed: matches[0], targets };
}

async function assertCurrentIntentBaseline(manifest, managed) {
  const baselines = manifest.operation.intentBaselines || [
    {
      scopeRoot: manifest.repositoryRoot,
      stateHash: manifest.operation.baselineIntentStateHash,
    },
  ];
  for (const baseline of baselines) {
    const currentIntentRecord = await readIntentRecord(
      baseline.scopeRoot,
      baseline.identity ? { ...managed, identity: baseline.identity } : managed,
    );
    if (currentIntentRecord.stateHash !== baseline.stateHash) {
      const error = new Error('Intent state changed while this operation was pending.');
      error.status = 'conflict';
      error.data = { reason: 'operation_baseline_changed', scope: baseline.scope, choices: ['restart', 'cancel'] };
      throw error;
    }
  }
}

async function requireManagedSkill(repositoryRoot, skill, environment) {
  const state = await readManagedState(repositoryRoot);
  const matches = Object.values(state?.skills || {}).filter((entry) => entry.installName === skill);
  if (matches.length > 1) {
    throw intentConflict({
      reason: 'ambiguous_skill_identity',
      installName: skill,
      identities: matches.map(({ identity }) => normalizedIdentity(identity)),
      choices: ['migrate', 'manage_clean', 'cancel'],
      resolution: {
        command: 'identity-resolve',
        requiredOptions: ['skill', 'source', 'upstream-skill', 'choice'],
      },
    });
  }
  if (matches.length !== 1) {
    const globalRoot = environment?.HOME;
    const globalState = globalRoot ? await readManagedState(globalRoot) : null;
    const globalMatches = Object.values(globalState?.skills || {}).filter(
      (entry) => entry.installName === skill,
    );
    if (globalMatches.length > 0) {
      const [globalManaged] = globalMatches;
      throw intentConflict({
        reason: 'project_rendering_required',
        installName: skill,
        globalIdentities: globalMatches.map(({ identity }) => normalizedIdentity(identity)),
        choices: ['create_project_rendering', 'promote_to_global', 'cancel'],
        resolutions: {
          create_project_rendering: {
            command: 'assess',
            options: {
              source: normalizedIdentity(globalManaged.identity).source,
              skill,
              scope: 'project',
            },
          },
          promote_to_global: {
            command: 'intent-add',
            options: { skill, scope: 'global' },
          },
        },
      });
    }
    throw intentError('managed_skill_not_found', `Expected exactly one managed Skill named ${skill}.`);
  }
  return matches[0];
}

export async function resolveSkillIdentity({
  repositoryRoot,
  skill,
  source,
  upstreamSkill,
  choice,
  currentRuntime,
  environment,
}) {
  if (!['migrate', 'manage_clean'].includes(choice)) {
    throw intentError('invalid_identity_resolution', 'Identity choice must be migrate or manage_clean.');
  }
  const state = await readManagedState(repositoryRoot);
  const matches = Object.entries(state?.skills || {}).filter(
    ([, entry]) => entry.installName === skill,
  );
  if (matches.length < 2) {
    throw intentError('invalid_identity_resolution', 'This Skill does not have an ambiguous managed identity.');
  }
  const requested = normalizedIdentity({ source, skill: upstreamSkill });
  const selected = matches.filter(
    ([, entry]) => JSON.stringify(normalizedIdentity(entry.identity)) === JSON.stringify(requested),
  );
  if (selected.length === 0) {
    throw intentConflict({
      reason: 'identity_resolution_mismatch',
      requested,
      identities: matches.map(([, { identity }]) => normalizedIdentity(identity)),
      choices: ['cancel'],
    });
  }
  const [, selectedManaged] = selected[0];
  await verifyManagedRendering({ repositoryRoot, managed: selectedManaged });
  let selectedLock;
  try {
    const lock = JSON.parse(await readFile(join(repositoryRoot, 'skills-lock.json'), 'utf8'));
    selectedLock = lock?.skills?.[skill];
  } catch {
    selectedLock = null;
  }
  if (
    !selectedLock ||
    normalizedIdentity({
      source: selectedLock.source,
      skill: selectedLock.skillPath || skill,
    }).source !== requested.source ||
    normalizedIdentity({
      source: selectedLock.source,
      skill: selectedLock.skillPath || skill,
    }).skill !== requested.skill
  ) {
    throw intentConflict({
      reason: 'identity_resolution_requires_regeneration',
      identity: requested,
      choices: ['cancel'],
    });
  }
  if (choice === 'migrate') {
    if (!currentRuntime) {
      throw intentError('missing_runtime', 'Intent migration requires --runtime <agent-id>.');
    }
    const selectedScoped = await readScopedIntents({
      repositoryRoot,
      managed: selectedManaged,
      environment,
      resolveEffective: false,
    });
    const nextScopes = intentScopesForOperation(selectedScoped);
    const baselines = [...selectedScoped.baselines];
    const intentStateDeletions = [];
    let migratedIntentCount = 0;
    const changedScopes = new Set();
    for (const [, entry] of matches) {
      if (JSON.stringify(normalizedIdentity(entry.identity)) === JSON.stringify(requested)) continue;
      for (const scope of ['project', 'global']) {
        const scopeRoot = scopeRootFor(scope, repositoryRoot, environment);
        const record = await readIntentRecord(scopeRoot, entry);
        if (scope === 'project') {
          const beforeSuppressionCount = nextScopes.project.suppressedGlobalIntentIds.length;
          nextScopes.project.suppressedGlobalIntentIds = [
            ...new Set([
              ...nextScopes.project.suppressedGlobalIntentIds,
              ...record.suppressedGlobalIntentIds,
            ]),
          ].sort();
          if (nextScopes.project.suppressedGlobalIntentIds.length !== beforeSuppressionCount) {
            changedScopes.add('project');
          }
        }
        baselines.push({
          scope,
          scopeRoot,
          relativePath: record.relativePath,
          stateHash: record.stateHash,
          identity: normalizedIdentity(entry.identity),
        });
        if (record.stateHash !== emptyIntentHash()) {
          intentStateDeletions.push({
            scope,
            scopeRoot,
            relativePath: record.relativePath,
            identity: normalizedIdentity(entry.identity),
          });
        }
        for (const intent of record.intents) {
          const existing = nextScopes[scope].intents.find(({ id }) => id === intent.id);
          if (existing && JSON.stringify(existing) !== JSON.stringify(intent)) {
            throw intentConflict({
              reason: 'identity_migration_intent_collision',
              intentId: intent.id,
              interpretations: [existing, intent],
              choices: ['cancel'],
            });
          }
          if (!existing) {
            nextScopes[scope].intents.push({ ...intent });
            migratedIntentCount += 1;
            changedScopes.add(scope);
          }
        }
      }
    }
    if (
      migratedIntentCount > 0 ||
      changedScopes.size > 0 ||
      intentStateDeletions.length > 0
    ) {
      const effectiveIntents = effectiveIntentsFor(nextScopes.project, nextScopes.global);
      const intentStateChanges = [...changedScopes].sort().map((scope) => ({
        scope,
        ...nextScopes[scope],
      }));
      const primary = intentStateChanges[0] || { scope: 'project', ...nextScopes.project };
      const assessed = await assessCandidate({
        source: requested.source,
        skill,
        currentRuntime,
        scope: 'project',
        repositoryRoot,
        operationType: 'identity_migrate',
        operationDetails: {
          identity: requested,
          publicationScope: 'project',
          identityResolution: {
            choice,
            identity: requested,
            competingIdentities: matches.map(([, { identity }]) => normalizedIdentity(identity)),
          },
          intents: primary.intents,
          suppressedGlobalIntentIds: primary.suppressedGlobalIntentIds,
          effectiveIntents,
          intentScope: primary.scope,
          intentStateScopeRoot: primary.scopeRoot,
          intentStateRelativePath: primary.relativePath,
          intentStateChanges,
          intentStateDeletions,
          intentScopes: nextScopes,
          intentBaselines: baselines,
          baselineManagedState: selectedManaged,
          baselineIntentStateHash: selectedScoped.project.stateHash,
        },
        environment,
      });
      return assessed.security.decision === 'approved'
        ? prepareUpdateAttempt({ workDir: assessed.workDir })
        : assessed;
    }
  }
  const [selectedKey, selectedEntry] = selected[0];
  const nextSkills = Object.fromEntries(
    Object.entries(state.skills).filter(
      ([key, entry]) => entry.installName !== skill || key === selectedKey,
    ),
  );
  nextSkills[selectedKey] = {
    ...selectedEntry,
    identity: requested,
  };
  const rulePath = join(repositoryRoot, '.skills-manager/identity-resolutions.json');
  const statePath = join(repositoryRoot, '.skills-manager/state.json');
  await assertContainedStateDirectory(repositoryRoot, join(repositoryRoot, '.skills-manager'));
  const ruleInfo = await lstat(rulePath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (ruleInfo && (!ruleInfo.isFile() || ruleInfo.isSymbolicLink())) {
    throw intentError('invalid_identity_resolution', 'Identity-resolution state must be a regular file.');
  }
  const previousRule = ruleInfo ? await readFile(rulePath) : null;
  let existingRules = {};
  if (previousRule) {
    try {
      const existing = JSON.parse(previousRule.toString('utf8'));
      if (existing?.version !== 1 || !existing.rules || typeof existing.rules !== 'object') throw new Error();
      existingRules = existing.rules;
    } catch {
      throw intentError(
        'invalid_identity_resolution',
        'Identity-resolution state has an unsupported or malformed schema.',
      );
    }
  }
  const nonce = randomUUID();
  const stateTemporary = `${statePath}.${nonce}.tmp`;
  const ruleTemporary = `${rulePath}.${nonce}.tmp`;
  const rule = {
    version: 1,
    rules: {
      ...existingRules,
      [skill]: {
        identity: requested,
        choice,
        competingIdentities: matches.map(([, { identity }]) => normalizedIdentity(identity)),
      },
    },
  };
  let rulePublished = false;
  try {
    await writeFile(stateTemporary, `${JSON.stringify({ version: 1, skills: nextSkills }, null, 2)}\n`);
    await writeFile(ruleTemporary, `${JSON.stringify(rule, null, 2)}\n`);
    await rename(ruleTemporary, rulePath);
    rulePublished = true;
    await rename(stateTemporary, statePath);
  } catch (error) {
    await rm(stateTemporary, { force: true });
    await rm(ruleTemporary, { force: true });
    if (rulePublished) {
      if (previousRule === null) await rm(rulePath, { force: true });
      else await writeFile(rulePath, previousRule);
    }
    throw error;
  }
  return { identity: requested, choice, rule: `.skills-manager/identity-resolutions.json` };
}

async function resolveManagedSkill({ repositoryRoot, skill, environment, requestedScope }) {
  try {
    return {
      managed: await requireManagedSkill(repositoryRoot, skill, environment),
      renderingRoot: repositoryRoot,
      publicationScope: 'project',
    };
  } catch (error) {
    if (requestedScope !== 'global' || error?.data?.reason !== 'project_rendering_required') {
      throw error;
    }
    const renderingRoot = await realpath(scopeRootFor('global', repositoryRoot, environment));
    const globalState = await readManagedState(renderingRoot);
    const matches = Object.values(globalState?.skills || {}).filter(
      (entry) => entry.installName === skill,
    );
    if (matches.length !== 1) {
      throw intentConflict({
        reason: 'ambiguous_skill_identity',
        installName: skill,
        identities: matches.map(({ identity }) => normalizedIdentity(identity)),
        choices: ['cancel'],
      });
    }
    return { managed: matches[0], renderingRoot, publicationScope: 'global' };
  }
}

export async function beginIntentAdd({
  repositoryRoot,
  skill,
  text,
  scope = 'project',
  currentRuntime,
  environment,
}) {
  const normalizedText = text?.trim();
  if (!normalizedText || normalizedText.length > 500 || /[\r\n]/.test(normalizedText)) {
    throw intentError(
      'invalid_intent',
      'An Intent must be one concise semantic outcome of at most 500 characters.',
    );
  }
  const { managed, renderingRoot, publicationScope } = await resolveManagedSkill({
    repositoryRoot,
    skill,
    environment,
    requestedScope: scope,
  });
  await verifyManagedRendering({ repositoryRoot: renderingRoot, managed });
  let scoped = await readScopedIntents({
    repositoryRoot,
    managed,
    environment,
    resolveEffective: publicationScope === 'project',
  });
  if (publicationScope === 'global') {
    scoped = {
      ...scoped,
      effectiveIntents: scoped.global.intents
        .filter(({ state }) => state === 'active')
        .map((intent) => ({ ...intent, scopes: ['global'] })),
      baselines: scoped.baselines.filter(({ scope: baselineScope }) => baselineScope === 'global'),
    };
  }
  const targetRecord = scoped[scope];
  const intent = {
    id: `intent-${randomUUID()}`,
    text: normalizedText,
    state: 'active',
  };
  const intents = [...targetRecord.intents, intent];
  const nextScoped = { ...scoped, [scope]: { ...targetRecord, intents } };
  const effectiveIntents = publicationScope === 'global'
    ? nextScoped.global.intents
        .filter(({ state }) => state === 'active')
        .map((entry) => ({ ...entry, scopes: ['global'] }))
    : effectiveIntentsFor(nextScoped.project, nextScoped.global);
  return assessCandidate({
    source: managed.identity.source,
    skill,
    currentRuntime,
    scope: publicationScope,
    repositoryRoot: renderingRoot,
    operationType: 'intent_add',
    operationDetails: {
      identity: managed.identity,
      publicationScope,
      intent,
      intents,
      suppressedGlobalIntentIds: targetRecord.suppressedGlobalIntentIds,
      intentScope: scope,
      intentStateScopeRoot: targetRecord.scopeRoot,
      intentStateRelativePath: targetRecord.relativePath,
      intentBaselines: scoped.baselines,
      intentScopes: intentScopesForOperation(nextScoped),
      effectiveIntents,
      currentRendering: {
        renderedHash: managed.renderedHash,
        physicalTargets: managed.physicalTargets,
      },
      baselineManagedState: managed,
      baselineIntentStateHash: targetRecord.stateHash,
    },
    environment,
  });
}

export async function beginUpdate({
  repositoryRoot,
  skill,
  currentRuntime,
  environment,
}) {
  const managed = await requireManagedSkill(repositoryRoot, skill, environment);
  await verifyManagedRendering({ repositoryRoot, managed });
  const scoped = await readScopedIntents({
    repositoryRoot,
    managed,
    environment,
  });
  const intentRecord = scoped.project;
  const effectiveIntents = scoped.effectiveIntents;
  const assessed = await assessCandidate({
    source: managed.identity.source,
    skill,
    currentRuntime,
    scope: managed.scope,
    repositoryRoot,
    operationType: 'update',
    operationDetails: {
      identity: managed.identity,
      intents: intentRecord.intents,
      effectiveIntents,
      intentStateRelativePath: intentRecord.relativePath,
      intentStateScopeRoot: intentRecord.scopeRoot,
      suppressedGlobalIntentIds: intentRecord.suppressedGlobalIntentIds,
      intentBaselines: scoped.baselines,
      intentScopes: intentScopesForOperation(scoped),
      baselineManagedState: managed,
      baselineIntentStateHash: intentRecord.stateHash,
    },
    environment,
  });
  return assessed.security.decision === 'approved'
    ? prepareUpdateAttempt({ workDir: assessed.workDir })
    : assessed;
}

export async function listIntents({ repositoryRoot, skill, environment }) {
  const { managed, publicationScope } = await resolveManagedSkill({
    repositoryRoot,
    skill,
    environment,
    requestedScope: 'global',
  });
  const scoped = await readScopedIntents({
    repositoryRoot,
    managed,
    environment,
    resolveEffective: publicationScope === 'project',
  });
  if (publicationScope === 'global') {
    scoped.effectiveIntents = scoped.global.intents
      .filter(({ state }) => state === 'active')
      .map((intent) => ({ ...intent, scopes: ['global'] }));
  }
  return {
    identity: managed.identity,
    installName: managed.installName,
    scope: publicationScope,
    scopes: {
      project: {
        intents: scoped.project.intents,
        suppressedGlobalIntentIds: scoped.project.suppressedGlobalIntentIds,
      },
      global: { intents: scoped.global.intents },
    },
    intents: scoped.project.intents,
    effectiveIntents: scoped.effectiveIntents,
    effectiveIntentIds: scoped.effectiveIntents.map(({ id }) => id),
    hashes: {
      upstream: managed.upstreamHash,
      rendered: managed.renderedHash,
      desired: managed.desiredRenderedHash,
      effectiveIntents: managed.effectiveIntentsHash,
    },
  };
}

export async function beginIntentMutation({
  repositoryRoot,
  skill,
  intentId,
  mutation,
  scope = 'project',
  text,
  reason,
  confirmDelete,
  currentRuntime,
  environment,
}) {
  const { managed, renderingRoot, publicationScope } = await resolveManagedSkill({
    repositoryRoot,
    skill,
    environment,
    requestedScope: scope,
  });
  await verifyManagedRendering({ repositoryRoot: renderingRoot, managed });
  let scoped = await readScopedIntents({
    repositoryRoot,
    managed,
    environment,
    resolveEffective: false,
  });
  if (publicationScope === 'global') {
    scoped = {
      ...scoped,
      baselines: scoped.baselines.filter(({ scope: baselineScope }) => baselineScope === 'global'),
    };
  }
  const record = scoped[scope];
  const index = record.intents.findIndex(({ id }) => id === intentId);
  if (index < 0) throw intentError('intent_not_found', `Intent ${intentId} is not attached to ${skill}.`);
  if (mutation === 'delete' && confirmDelete !== true) {
    const error = new Error('Permanent Intent deletion requires explicit confirmation.');
    error.status = 'conflict';
    error.data = {
      reason: 'permanent_intent_deletion',
      intent: record.intents[index],
      choices: ['confirm_delete', 'cancel'],
    };
    throw error;
  }
  const intents = record.intents.map((intent) => ({ ...intent }));
  const before = { ...intents[index] };
  if (mutation === 'edit') {
    const normalizedText = text?.trim();
    if (!normalizedText || normalizedText.length > 500 || /[\r\n]/.test(normalizedText)) {
      throw intentError('invalid_intent', 'Edited Intent text must be one outcome of at most 500 characters.');
    }
    intents[index].text = normalizedText;
  } else if (mutation === 'disable') {
    if (intents[index].state !== 'active') {
      throw intentError('invalid_intent_transition', 'Only an active Intent can be disabled.');
    }
    intents[index].state = 'disabled';
  } else if (mutation === 'enable') {
    if (intents[index].state !== 'disabled') {
      throw intentError('invalid_intent_transition', 'Only a disabled Intent can be re-enabled.');
    }
    intents[index].state = 'active';
  } else if (mutation === 'obsolete') {
    const normalizedReason = reason?.trim();
    if (!normalizedReason || normalizedReason.length > 1000) {
      throw intentError('invalid_intent_transition', 'Obsolete Intent requires a reason of at most 1000 characters.');
    }
    intents[index].state = 'expired';
    intents[index].obsoleteReason = normalizedReason;
  } else if (mutation === 'delete') {
    intents.splice(index, 1);
  } else {
    throw intentError('invalid_intent_transition', `Unsupported Intent mutation: ${mutation}`);
  }
  const nextScoped = { ...scoped, [scope]: { ...record, intents } };
  const effectiveIntents = publicationScope === 'global'
    ? nextScoped.global.intents
        .filter(({ state }) => state === 'active')
        .map((entry) => ({ ...entry, scopes: ['global'] }))
    : effectiveIntentsFor(nextScoped.project, nextScoped.global);
  const operationType = `intent_${mutation}`;
  const assessed = await assessCandidate({
    source: managed.identity.source,
    skill,
    currentRuntime,
    scope: publicationScope,
    repositoryRoot: renderingRoot,
    operationType,
    operationDetails: {
      identity: managed.identity,
      publicationScope,
      intents,
      effectiveIntents,
      intentStateRelativePath: record.relativePath,
      intentStateScopeRoot: record.scopeRoot,
      intentScope: scope,
      suppressedGlobalIntentIds: record.suppressedGlobalIntentIds,
      intentBaselines: scoped.baselines,
      intentScopes: intentScopesForOperation(nextScoped),
      baselineManagedState: managed,
      baselineIntentStateHash: record.stateHash,
      mutation: {
        type: mutation,
        intentId,
        before,
        after: mutation === 'delete' ? null : intents.find(({ id }) => id === intentId),
      },
    },
    environment,
  });
  return assessed.security.decision === 'approved'
    ? prepareUpdateAttempt({ workDir: assessed.workDir })
    : assessed;
}

export async function beginIntentSuppression({
  repositoryRoot,
  skill,
  intentId,
  currentRuntime,
  environment,
}) {
  const managed = await requireManagedSkill(repositoryRoot, skill, environment);
  await verifyManagedRendering({ repositoryRoot, managed });
  const scoped = await readScopedIntents({
    repositoryRoot,
    managed,
    environment,
    resolveEffective: false,
  });
  const inherited = scoped.global.intents.find(
    ({ id, state }) => id === intentId && state === 'active',
  );
  if (!inherited) {
    throw intentError('intent_not_found', `Active global Intent ${intentId} is not inherited by ${skill}.`);
  }
  if (scoped.project.suppressedGlobalIntentIds.includes(intentId)) {
    throw intentError('invalid_intent_transition', `Global Intent ${intentId} is already suppressed.`);
  }
  const suppressedGlobalIntentIds = [...scoped.project.suppressedGlobalIntentIds, intentId].sort();
  const project = { ...scoped.project, suppressedGlobalIntentIds };
  const effectiveIntents = effectiveIntentsFor(project, scoped.global);
  const assessed = await assessCandidate({
    source: managed.identity.source,
    skill,
    currentRuntime,
    scope: 'project',
    repositoryRoot,
    operationType: 'intent_suppress',
    operationDetails: {
      identity: managed.identity,
      intents: project.intents,
      suppressedGlobalIntentIds,
      effectiveIntents,
      intentScope: 'project',
      intentStateScopeRoot: project.scopeRoot,
      intentStateRelativePath: project.relativePath,
      intentBaselines: scoped.baselines,
      intentScopes: intentScopesForOperation({ ...scoped, project }),
      baselineManagedState: managed,
      baselineIntentStateHash: project.stateHash,
      mutation: { type: 'suppress', intentId, inherited },
    },
    environment,
  });
  return assessed.security.decision === 'approved'
    ? prepareUpdateAttempt({ workDir: assessed.workDir })
    : assessed;
}

export async function prepareUpdateAttempt({ workDir }) {
  const { manifest, resolvedWorkDir } = await loadManifest(workDir);
  if (manifest.phase !== 'assessed' || !isManagedRenderOperation(manifest.operation.type)) {
    throw intentError('invalid_continuation', 'This attempt is not ready to prepare an Update.');
  }
  const { managed, targets } = await currentManagedForOperation(manifest);
  await assertCurrentIntentBaseline(manifest, managed);
  const baselineValidation = await validateCandidate({
    candidateRoot: manifest.candidateRoot,
    workDir: resolvedWorkDir,
    operation: manifest.operation,
  });
  const currentRenderingSnapshot = await createCandidateSnapshot(targets[0]);
  const baselineSnapshot = await createCandidateSnapshot(manifest.candidateRoot);
  const nextEffectiveIntentsHash = effectiveIntentsHash(manifest.operation.effectiveIntents);
  if (
    manifest.operation.type === 'update' &&
    baselineValidation.upstreamHash === managed.upstreamHash &&
    nextEffectiveIntentsHash === managed.effectiveIntentsHash &&
    managed.renderedHash === managed.desiredRenderedHash
  ) {
    await rm(resolvedWorkDir, { recursive: true, force: true });
    return {
      envelopeStatus: 'complete',
      workDir: resolvedWorkDir,
      operation: manifest.operation,
      noChange: true,
    };
  }
  if (manifest.operation.effectiveIntents.length > 0) {
    return {
      envelopeStatus: 'ready',
      workDir: resolvedWorkDir,
      operation: manifest.operation,
      security: manifest.security,
      candidate: { root: manifest.candidateRoot },
      nextAction: 'work_order',
    };
  }
  await saveManifest(resolvedWorkDir, {
    ...manifest,
    phase: 'assessed',
    baselineSnapshot,
    currentRenderingSnapshot,
    baselineValidation: {
      upstreamHash: baselineValidation.upstreamHash,
      renderedHash: baselineValidation.renderedHash,
      lockEntryHash: createHash('sha256')
        .update(JSON.stringify(baselineValidation.lockEntry))
        .digest('hex'),
    },
    effectiveIntentsHash: effectiveIntentsHash([]),
    ...(INTENT_MUTATION_TYPES.has(manifest.operation.type)
      ? {
          candidateIntentStates: candidateIntentStatesForOperation(manifest.operation),
        }
      : {}),
    semanticReview: {
      semanticOutcome: {
        result: 'not_required',
        intents: [],
        ...(manifest.operation.mutation ? { mutation: manifest.operation.mutation } : {}),
      },
      materialDiff: [],
      totalDiff: diffCandidateSnapshots(currentRenderingSnapshot, baselineSnapshot),
    },
  });
  const result = await validateAttempt({ workDir: resolvedWorkDir });
  return { envelopeStatus: 'needs_confirmation', ...result };
}

function workOrderData(manifest, resolvedWorkDir) {
  return {
    workDir: resolvedWorkDir,
    operation: manifest.operation,
    ...(manifest.operation.intent ? { intent: manifest.operation.intent } : {}),
    effectiveIntents: manifest.operation.effectiveIntents,
    candidate: { root: manifest.candidateRoot },
    editingBoundary: {
      root: manifest.candidateRoot,
      allowExistingFiles: true,
      newFilesRequireConfirmation: true,
    },
    prohibitedActions: [
      'write_outside_candidate_root',
      'execute_candidate_scripts',
      'edit_published_rendering',
      'edit_manager_state',
    ],
    requiredResultStatuses: ['applied', 'adapted', 'obsolete', 'failed'],
  };
}

function candidateIntentStatesForOperation(operation) {
  const changes = operation.intentStateChanges || [
    {
      scope: operation.intentScope || 'project',
      scopeRoot: operation.intentStateScopeRoot,
      relativePath: operation.intentStateRelativePath,
      intents: operation.intents,
      suppressedGlobalIntentIds: operation.suppressedGlobalIntentIds || [],
    },
  ];
  return changes.map((change) => ({
    scope: change.scope,
    scopeRoot: change.scopeRoot,
    relativePath: change.relativePath,
    record: {
      version: 1,
      identity: operation.identity,
      installName: operation.skill,
      intents: change.intents,
      ...(change.scope === 'project'
        ? { suppressedGlobalIntentIds: change.suppressedGlobalIntentIds || [] }
        : {}),
    },
  }));
}

export async function createIntentWorkOrder({ workDir }) {
  const { manifest, resolvedWorkDir } = await loadManifest(workDir);
  if (
    manifest.phase !== 'assessed' ||
    !['intent_add', 'update', ...INTENT_MUTATION_TYPES].includes(manifest.operation.type) ||
    manifest.operation.effectiveIntents.length === 0
  ) {
    throw intentError('invalid_continuation', 'This Update attempt is not ready for an Intent work order.');
  }
  const baselineValidation = await validateCandidate({
    candidateRoot: manifest.candidateRoot,
    workDir: resolvedWorkDir,
    operation: manifest.operation,
  });
  const baselineSnapshot = await createCandidateSnapshot(manifest.candidateRoot);
  const { managed, targets } = await currentManagedForOperation(manifest);
  await assertCurrentIntentBaseline(manifest, managed);
  const [currentTarget] = targets;
  const currentRenderingSnapshot = await createCandidateSnapshot(currentTarget);
  await saveManifest(resolvedWorkDir, {
    ...manifest,
    phase: 'awaiting_agent_result',
    baselineSnapshot,
    currentRenderingSnapshot,
    baselineValidation: {
      upstreamHash: baselineValidation.upstreamHash,
      renderedHash: baselineValidation.renderedHash,
      lockEntryHash: createHash('sha256')
        .update(JSON.stringify(baselineValidation.lockEntry))
        .digest('hex'),
    },
  });
  return workOrderData(
    { ...manifest, phase: 'awaiting_agent_result' },
    resolvedWorkDir,
  );
}

async function finalizeIntentCandidate({ manifest, resolvedWorkDir, agentResult, materialDiff }) {
  const identity = manifest.operation.identity;
  const hash = identityHash(identity);
  const nextEffectiveIntentsHash = effectiveIntentsHash(manifest.operation.effectiveIntents);
  const relativePath = manifest.operation.intentStateRelativePath ||
    `.skills-manager/intents/${manifest.operation.skill}__${hash.slice(0, 8)}.json`;
  let currentSnapshot;
  try {
    currentSnapshot = await createCandidateSnapshot(manifest.candidateRoot);
  } catch (error) {
    if (error.code === 'validation_failed') {
      await rm(resolvedWorkDir, { recursive: true, force: true });
    }
    throw error;
  }
  const actualMaterialDiff = diffCandidateSnapshots(manifest.baselineSnapshot, currentSnapshot);
  if (JSON.stringify(actualMaterialDiff) !== JSON.stringify(materialDiff)) {
    await rm(resolvedWorkDir, { recursive: true, force: true });
    throw intentError(
      'validation_failed',
      'The candidate changed after the Agent result or changed-file confirmation.',
    );
  }
  await saveManifest(resolvedWorkDir, {
    ...manifest,
    phase: 'assessed',
    agentResult,
    ...(manifest.operation.type !== 'update'
      ? {
          candidateIntentStates: candidateIntentStatesForOperation({
            ...manifest.operation,
            intentStateRelativePath: relativePath,
          }),
        }
      : {}),
    effectiveIntentsHash: nextEffectiveIntentsHash,
    semanticReview: {
      semanticOutcome:
        manifest.operation.type === 'intent_add'
          ? {
              intent: manifest.operation.intent.text,
              result: agentResult.status,
              summary: agentResult.summary || null,
              ...(agentResult.intents ? { intents: agentResult.intents } : {}),
            }
          : {
              intents: agentResult.intents,
              result: agentResult.status,
              summary: agentResult.summary || null,
              ...(manifest.operation.mutation ? { mutation: manifest.operation.mutation } : {}),
            },
      materialDiff: actualMaterialDiff,
      totalDiff: diffCandidateSnapshots(manifest.currentRenderingSnapshot, currentSnapshot),
    },
  });
  return validateAttempt({ workDir: resolvedWorkDir });
}

function normalizeAgentResult(manifest, { result, results, summary }) {
  if (manifest.operation.type === 'intent_add' && result !== undefined) {
    if (manifest.operation.effectiveIntents.length !== 1) {
      throw intentError(
        'invalid_agent_result',
        'Scoped Intent additions require one result per Effective Intent.',
      );
    }
    if (!['applied', 'adapted', 'obsolete', 'failed'].includes(result)) {
      throw intentError('invalid_agent_result', `Unsupported Intent result status: ${result}`);
    }
    if (summary && summary.trim().length > 1000) {
      throw intentError('invalid_agent_result', 'Intent result summary must be at most 1000 characters.');
    }
    if (result === 'obsolete' && !summary?.trim()) {
      throw intentError('invalid_agent_result', 'An obsolete Intent result requires an explanatory summary.');
    }
    const normalizedSummary = summary?.trim() || null;
    return {
      status: result,
      summary: normalizedSummary,
      ...(['obsolete', 'failed'].includes(result)
        ? {
            intents: [
              {
                id: manifest.operation.intent.id,
                text: manifest.operation.intent.text,
                status: result,
                summary: normalizedSummary,
              },
            ],
          }
        : {}),
    };
  }
  if (summary && summary.trim().length > 1000) {
    throw intentError('invalid_agent_result', 'Intent result summary must be at most 1000 characters.');
  }
  let entries;
  try {
    entries = JSON.parse(results);
  } catch {
    throw intentError('invalid_agent_result', 'Update results must be a JSON array with one entry per Intent.');
  }
  const expected = new Map(manifest.operation.effectiveIntents.map((intent) => [intent.id, intent]));
  if (
    !Array.isArray(entries) ||
    entries.length !== expected.size ||
    new Set(entries.map(({ id }) => id)).size !== entries.length ||
    !entries.every(
      (entry) =>
        expected.has(entry?.id) &&
        ['applied', 'adapted', 'obsolete', 'failed'].includes(entry.status) &&
        (entry.summary === undefined ||
          (typeof entry.summary === 'string' && entry.summary.trim().length <= 1000)) &&
        (entry.status !== 'obsolete' ||
          (typeof entry.summary === 'string' && entry.summary.trim().length > 0)),
    )
  ) {
    throw intentError(
      'invalid_agent_result',
      'Update results must cover every Effective Intent exactly once with a supported status.',
    );
  }
  const intents = entries.map((entry) => ({
    id: entry.id,
    text: expected.get(entry.id).text,
    ...(expected.get(entry.id).scopes ? { scopes: expected.get(entry.id).scopes } : {}),
    status: entry.status,
    summary: entry.summary?.trim() || null,
  }));
  return {
    status: intents.some(({ status }) => status === 'failed')
      ? 'failed'
      : intents.some(({ status }) => status === 'obsolete')
        ? 'obsolete'
        : intents.some(({ status }) => status === 'adapted')
          ? 'adapted'
          : 'applied',
    summary: summary?.trim() || null,
    intents,
  };
}

export async function recordIntentResult({ workDir, result, results, summary }) {
  const { manifest, resolvedWorkDir } = await loadManifest(workDir);
  if (
    manifest.phase !== 'awaiting_agent_result' ||
    !['intent_add', 'update', ...INTENT_MUTATION_TYPES].includes(manifest.operation.type)
  ) {
    throw intentError('invalid_continuation', 'This Update attempt is not awaiting an Agent Intent result.');
  }
  const agentResult = normalizeAgentResult(manifest, { result, results, summary });
  if (!['applied', 'adapted'].includes(agentResult.status)) {
    const conflictingIntents = agentResult.intents?.filter(
      ({ status }) => status === agentResult.status,
    );
    if (['failed', 'obsolete'].includes(agentResult.status)) {
      await saveManifest(resolvedWorkDir, {
        ...manifest,
        phase:
          agentResult.status === 'failed'
            ? 'awaiting_semantic_resolution'
            : 'awaiting_obsolete_resolution',
        semanticConflict: {
          result: agentResult.status,
          summary: agentResult.summary,
          intents: conflictingIntents || [],
        },
      });
    }
    const error = new Error(`Intent result ${agentResult.status} requires a separate user decision.`);
    error.status = 'conflict';
    error.data = {
      reason: `intent_${agentResult.status}`,
      ...(conflictingIntents ? { intents: conflictingIntents } : {}),
      choices:
        agentResult.status === 'failed'
          ? ['revise', 'abort']
          : ['keep', 'mark_obsolete', 'abort'],
    };
    throw error;
  }
  let currentSnapshot;
  try {
    currentSnapshot = await createCandidateSnapshot(manifest.candidateRoot);
  } catch (error) {
    if (error.code === 'validation_failed') {
      await rm(resolvedWorkDir, { recursive: true, force: true });
    }
    throw error;
  }
  const materialDiff = diffCandidateSnapshots(manifest.baselineSnapshot, currentSnapshot);
  if (materialDiff.length === 0 && manifest.operation.type === 'intent_add') {
    await rm(resolvedWorkDir, { recursive: true, force: true });
    throw intentError('validation_failed', 'The Agent reported success without changing the candidate.');
  }
  const addedFiles = materialDiff
    .filter(({ status }) => status === 'added')
    .map(({ path }) => path);
  if (addedFiles.length > 0) {
    await saveManifest(resolvedWorkDir, {
      ...manifest,
      phase: 'awaiting_change_scope_confirmation',
      agentResult,
      materialDiff,
    });
    return {
      envelopeStatus: 'needs_confirmation',
      reason: 'changed_file_scope',
      workDir,
      operation: manifest.operation,
      addedFiles,
      materialDiff,
    };
  }
  return finalizeIntentCandidate({ manifest, resolvedWorkDir, agentResult, materialDiff });
}

export async function continueKeepingObsoleteIntents({ workDir }) {
  const { manifest, resolvedWorkDir } = await loadManifest(workDir);
  if (
    manifest.phase !== 'awaiting_obsolete_resolution' ||
    manifest.semanticConflict?.result !== 'obsolete'
  ) {
    throw intentError('invalid_continuation', 'This attempt is not awaiting an obsolete-Intent choice.');
  }
  const resumed = {
    ...manifest,
    phase: 'awaiting_agent_result',
    obsoleteResolution: 'keep',
  };
  await saveManifest(resolvedWorkDir, resumed);
  return {
    envelopeStatus: 'work_order',
    resolution: 'keep',
    intents: manifest.semanticConflict.intents,
    ...workOrderData(resumed, resolvedWorkDir),
  };
}

export async function continueMarkingObsoleteIntents({ workDir }) {
  const { manifest, resolvedWorkDir } = await loadManifest(workDir);
  if (
    manifest.phase !== 'awaiting_obsolete_resolution' ||
    manifest.semanticConflict?.result !== 'obsolete'
  ) {
    throw intentError('invalid_continuation', 'This attempt is not awaiting an obsolete-Intent choice.');
  }
  const originalScopes = manifest.operation.intentScopes;
  if (!originalScopes?.project || !originalScopes?.global) {
    throw intentError('invalid_continuation', 'This attempt does not contain scoped Intent baselines.');
  }
  const nextScopes = structuredClone(originalScopes);
  const changedScopes = new Set();
  for (const obsolete of manifest.semanticConflict.intents) {
    const owningScopes = obsolete.scopes || [manifest.operation.intentScope || 'project'];
    for (const scope of owningScopes) {
      const index = nextScopes[scope].intents.findIndex(({ id }) => id === obsolete.id);
      if (index < 0) continue;
      nextScopes[scope].intents[index] = {
        ...nextScopes[scope].intents[index],
        state: 'expired',
        obsoleteReason: obsolete.summary,
      };
      changedScopes.add(scope);
    }
  }
  if (changedScopes.size === 0) {
    throw intentError('invalid_continuation', 'No owning scoped Intent record matched the obsolete result.');
  }
  const effectiveIntents = effectiveIntentsFor(nextScopes.project, nextScopes.global);
  const intentStateChanges = [...changedScopes].sort().map((scope) => ({
    scope,
    ...nextScopes[scope],
  }));
  const primary = intentStateChanges[0];
  const resumed = {
    ...manifest,
    phase: 'awaiting_agent_result',
    operation: {
      ...manifest.operation,
      type: 'intent_obsolete',
      intents: primary.intents,
      suppressedGlobalIntentIds: primary.suppressedGlobalIntentIds,
      intentScope: primary.scope,
      intentStateScopeRoot: primary.scopeRoot,
      intentStateRelativePath: primary.relativePath,
      intentScopes: nextScopes,
      intentStateChanges,
      effectiveIntents,
      mutation: {
        type: 'obsolete',
        intents: manifest.semanticConflict.intents,
      },
    },
    obsoleteResolution: 'mark_obsolete',
  };
  await saveManifest(resolvedWorkDir, resumed);
  return {
    envelopeStatus: 'work_order',
    resolution: 'mark_obsolete',
    intents: manifest.semanticConflict.intents,
    ...workOrderData(resumed, resolvedWorkDir),
  };
}

export async function continueSemanticRevision({ workDir }) {
  const { manifest, resolvedWorkDir } = await loadManifest(workDir);
  if (manifest.phase !== 'awaiting_semantic_resolution' || manifest.semanticConflict?.result !== 'failed') {
    throw intentError('invalid_continuation', 'This attempt is not awaiting a semantic revision choice.');
  }
  const resumed = {
    ...manifest,
    phase: 'awaiting_agent_result',
    semanticResolution: 'revise',
  };
  await saveManifest(resolvedWorkDir, resumed);
  return {
    envelopeStatus: 'work_order',
    resolution: 'revise',
    ...workOrderData(resumed, resolvedWorkDir),
  };
}

export async function continueChangedFileScope({ workDir }) {
  const { manifest, resolvedWorkDir } = await loadManifest(workDir);
  if (manifest.phase !== 'awaiting_change_scope_confirmation') {
    throw intentError('invalid_continuation', 'This Update attempt is not awaiting changed-file scope confirmation.');
  }
  const result = await finalizeIntentCandidate({
    manifest,
    resolvedWorkDir,
    agentResult: manifest.agentResult,
    materialDiff: manifest.materialDiff,
  });
  return { envelopeStatus: 'needs_confirmation', ...result };
}
