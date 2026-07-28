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
      !record.intents.every(
        (intent) =>
          typeof intent?.id === 'string' &&
          typeof intent.text === 'string' &&
          ['active', 'disabled', 'expired'].includes(intent.state),
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
  const state = await readManagedState(repositoryRoot);
  const matches = Object.values(state?.skills || {}).filter((entry) => entry.installName === skill);
  if (matches.length !== 1) {
    throw intentError('managed_skill_not_found', `Expected exactly one managed Skill named ${skill}.`);
  }
  const managed = matches[0];
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
  const state = await readManagedState(repositoryRoot);
  const matches = Object.values(state?.skills || {}).filter((entry) => entry.installName === skill);
  if (matches.length !== 1) {
    throw intentError('managed_skill_not_found', `Expected exactly one managed Skill named ${skill}.`);
  }
  const managed = matches[0];
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

export async function prepareUpdateAttempt({ workDir }) {
  const { manifest, resolvedWorkDir } = await loadManifest(workDir);
  if (manifest.phase !== 'assessed' || manifest.operation.type !== 'update') {
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
    semanticReview: {
      semanticOutcome: { result: 'not_required', intents: [] },
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
    !['intent_add', 'update'].includes(manifest.operation.type) ||
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
    ...(manifest.operation.type === 'intent_add'
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
    return { status: result, summary: summary?.trim() || null };
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
          (typeof entry.summary === 'string' && entry.summary.trim().length <= 1000)),
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
    !['intent_add', 'update'].includes(manifest.operation.type)
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
      choices: agentResult.status === 'failed' ? ['revise', 'abort'] : ['keep', 'abort'],
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
