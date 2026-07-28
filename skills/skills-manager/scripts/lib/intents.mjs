import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, rm } from 'node:fs/promises';
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
]);

function isManagedRenderOperation(type) {
  return type === 'update' || INTENT_MUTATION_TYPES.has(type);
}

function intentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function identityHash(identity) {
  return createHash('sha256').update(identity.source).update('\0').update(identity.skill).digest('hex');
}

async function readIntentRecord(repositoryRoot, managed) {
  const intentsDirectory = join(repositoryRoot, '.skills-manager/intents');
  await assertContainedStateDirectory(repositoryRoot, intentsDirectory);
  const relativePath = `.skills-manager/intents/${managed.installName}__${identityHash(managed.identity).slice(0, 8)}.json`;
  const path = join(repositoryRoot, relativePath);
  const info = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!info) {
    return {
      intents: [],
      relativePath,
      stateHash: createHash('sha256').update('null').digest('hex'),
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
      JSON.stringify(record.identity) !== JSON.stringify(managed.identity) ||
      record.installName !== managed.installName ||
      !Array.isArray(record.intents) ||
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
      relativePath,
      stateHash: createHash('sha256').update(content).digest('hex'),
    };
  } catch {
    throw intentError('invalid_intent_state', 'Intent state has an unsupported or malformed schema.');
  }
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
  const currentIntentRecord = await readIntentRecord(manifest.repositoryRoot, managed);
  if (currentIntentRecord.stateHash !== manifest.operation.baselineIntentStateHash) {
    const error = new Error('Intent state changed while this operation was pending.');
    error.status = 'conflict';
    error.data = { reason: 'operation_baseline_changed', choices: ['restart', 'cancel'] };
    throw error;
  }
}

async function requireManagedSkill(repositoryRoot, skill) {
  const state = await readManagedState(repositoryRoot);
  const matches = Object.values(state?.skills || {}).filter((entry) => entry.installName === skill);
  if (matches.length !== 1) {
    throw intentError('managed_skill_not_found', `Expected exactly one managed Skill named ${skill}.`);
  }
  return matches[0];
}

export async function beginIntentAdd({
  repositoryRoot,
  skill,
  text,
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
  const managed = await requireManagedSkill(repositoryRoot, skill);
  const existingIntentRecord = await readIntentRecord(repositoryRoot, managed);
  const intent = {
    id: `intent-${randomUUID()}`,
    text: normalizedText,
    state: 'active',
  };
  return assessCandidate({
    source: managed.identity.source,
    skill,
    currentRuntime,
    scope: managed.scope,
    repositoryRoot,
    operationType: 'intent_add',
    operationDetails: {
      identity: managed.identity,
      intent,
      intents: [...existingIntentRecord.intents, intent],
      effectiveIntents: [
        ...existingIntentRecord.intents.filter(({ state: intentState }) => intentState === 'active'),
        intent,
      ],
      currentRendering: {
        renderedHash: managed.renderedHash,
        physicalTargets: managed.physicalTargets,
      },
      baselineManagedState: managed,
      baselineIntentStateHash: existingIntentRecord.stateHash,
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
  const managed = await requireManagedSkill(repositoryRoot, skill);
  await verifyManagedRendering({ repositoryRoot, managed });
  const intentRecord = await readIntentRecord(repositoryRoot, managed);
  const effectiveIntents = intentRecord.intents.filter(({ state }) => state === 'active');
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
      baselineManagedState: managed,
      baselineIntentStateHash: intentRecord.stateHash,
    },
    environment,
  });
  return assessed.security.decision === 'approved'
    ? prepareUpdateAttempt({ workDir: assessed.workDir })
    : assessed;
}

export async function listIntents({ repositoryRoot, skill }) {
  const managed = await requireManagedSkill(repositoryRoot, skill);
  const record = await readIntentRecord(repositoryRoot, managed);
  return {
    identity: managed.identity,
    installName: managed.installName,
    scope: managed.scope,
    intents: record.intents,
    effectiveIntentIds: record.intents
      .filter(({ state: intentState }) => intentState === 'active')
      .map(({ id }) => id),
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
  text,
  reason,
  confirmDelete,
  currentRuntime,
  environment,
}) {
  const managed = await requireManagedSkill(repositoryRoot, skill);
  await verifyManagedRendering({ repositoryRoot, managed });
  const record = await readIntentRecord(repositoryRoot, managed);
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
  const effectiveIntents = intents.filter(({ state: intentState }) => intentState === 'active');
  const operationType = `intent_${mutation}`;
  const assessed = await assessCandidate({
    source: managed.identity.source,
    skill,
    currentRuntime,
    scope: managed.scope,
    repositoryRoot,
    operationType,
    operationDetails: {
      identity: managed.identity,
      intents,
      effectiveIntents,
      intentStateRelativePath: record.relativePath,
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
  const effectiveIntentsHash = createHash('sha256')
    .update(JSON.stringify(manifest.operation.effectiveIntents))
    .digest('hex');
  if (
    manifest.operation.type === 'update' &&
    baselineValidation.upstreamHash === managed.upstreamHash &&
    effectiveIntentsHash === managed.effectiveIntentsHash &&
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
    effectiveIntentsHash: createHash('sha256').update('[]').digest('hex'),
    ...(INTENT_MUTATION_TYPES.has(manifest.operation.type)
      ? {
          candidateIntentState: {
            relativePath: manifest.operation.intentStateRelativePath,
            record: {
              version: 1,
              identity: manifest.operation.identity,
              installName: manifest.operation.skill,
              intents: manifest.operation.intents,
            },
          },
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
  const intentRecord = {
    version: 1,
    identity,
    installName: manifest.operation.skill,
    intents: manifest.operation.intents,
  };
  const effectiveIntentsHash = createHash('sha256')
    .update(JSON.stringify(manifest.operation.effectiveIntents))
    .digest('hex');
  const relativePath = `.skills-manager/intents/${manifest.operation.skill}__${hash.slice(0, 8)}.json`;
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
      ? { candidateIntentState: { relativePath, record: intentRecord } }
      : {}),
    effectiveIntentsHash,
    semanticReview: {
      semanticOutcome:
        manifest.operation.type === 'intent_add'
          ? {
              intent: manifest.operation.intent.text,
              result: agentResult.status,
              summary: agentResult.summary || null,
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
  if (manifest.operation.type === 'intent_add') {
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
  const obsoleteById = new Map(
    manifest.semanticConflict.intents.map(({ id, summary }) => [id, summary]),
  );
  const intents = manifest.operation.intents.map((intent) =>
    obsoleteById.has(intent.id)
      ? { ...intent, state: 'expired', obsoleteReason: obsoleteById.get(intent.id) }
      : intent,
  );
  const resumed = {
    ...manifest,
    phase: 'awaiting_agent_result',
    operation: {
      ...manifest.operation,
      type: 'intent_obsolete',
      intents,
      effectiveIntents: intents.filter(({ state }) => state === 'active'),
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
