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
  const path = join(
    intentsDirectory,
    `${managed.installName}__${identityHash(managed.identity).slice(0, 8)}.json`,
  );
  const info = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!info) {
    return {
      intents: [],
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
      stateHash: createHash('sha256').update(content).digest('hex'),
    };
  } catch {
    throw intentError('invalid_intent_state', 'Intent state has an unsupported or malformed schema.');
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

export async function createIntentWorkOrder({ workDir }) {
  const { manifest, resolvedWorkDir } = await loadManifest(workDir);
  if (manifest.phase !== 'assessed' || manifest.operation.type !== 'intent_add') {
    throw intentError('invalid_continuation', 'This Update attempt is not ready for an Intent work order.');
  }
  const baselineValidation = await validateCandidate({
    candidateRoot: manifest.candidateRoot,
    workDir: resolvedWorkDir,
    operation: manifest.operation,
  });
  const baselineSnapshot = await createCandidateSnapshot(manifest.candidateRoot);
  const currentState = await readManagedState(manifest.repositoryRoot);
  const currentMatches = Object.values(currentState?.skills || {}).filter(
    (entry) =>
      entry.installName === manifest.operation.skill &&
      JSON.stringify(entry.identity) === JSON.stringify(manifest.operation.identity),
  );
  if (currentMatches.length !== 1) {
    throw intentError('invalid_managed_state', 'Managed Skill identity changed before the work order.');
  }
  const [currentTarget] = await verifyManagedRendering({
    repositoryRoot: manifest.repositoryRoot,
    managed: currentMatches[0],
  });
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
  return {
    workDir,
    operation: manifest.operation,
    intent: manifest.operation.intent,
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
    candidateIntentState: { relativePath, record: intentRecord },
    effectiveIntentsHash,
    semanticReview: {
      semanticOutcome: {
        intent: manifest.operation.intent.text,
        result: agentResult.status,
        summary: agentResult.summary || null,
      },
      materialDiff: actualMaterialDiff,
      totalDiff: diffCandidateSnapshots(manifest.currentRenderingSnapshot, currentSnapshot),
    },
  });
  return validateAttempt({ workDir: resolvedWorkDir });
}

export async function recordIntentResult({ workDir, result, summary }) {
  const { manifest, resolvedWorkDir } = await loadManifest(workDir);
  if (manifest.phase !== 'awaiting_agent_result' || manifest.operation.type !== 'intent_add') {
    throw intentError('invalid_continuation', 'This Update attempt is not awaiting an Agent Intent result.');
  }
  if (!['applied', 'adapted', 'obsolete', 'failed'].includes(result)) {
    throw intentError('invalid_agent_result', `Unsupported Intent result status: ${result}`);
  }
  if (!['applied', 'adapted'].includes(result)) {
    const error = new Error(`Intent result ${result} requires a separate user decision.`);
    error.status = 'conflict';
    error.data = { reason: `intent_${result}`, choices: ['revise', 'disable', 'abort'] };
    throw error;
  }
  if (summary && summary.trim().length > 1000) {
    throw intentError('invalid_agent_result', 'Intent result summary must be at most 1000 characters.');
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
  if (materialDiff.length === 0) {
    await rm(resolvedWorkDir, { recursive: true, force: true });
    throw intentError('validation_failed', 'The Agent reported success without changing the candidate.');
  }
  const agentResult = { status: result, summary: summary?.trim() || null };
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
