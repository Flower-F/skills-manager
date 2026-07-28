import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

import { SUPPORTED_SKILLS_CLI_VERSION, runtimeRegistry } from './runtime-registry.mjs';

const ANSI_SEQUENCE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

function upstreamError(message, details) {
  const error = new Error(message);
  error.code = 'upstream_failed';
  error.details = details;
  return error;
}

function runProcess(executable, arguments_, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      env: { ...options.environment, DISABLE_TELEMETRY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => reject(upstreamError(error.message)));
    child.on('close', (exitCode) => {
      if (exitCode === 0) resolve({ stdout, stderr });
      else reject(
        upstreamError(`skills@${SUPPORTED_SKILLS_CLI_VERSION} exited with status ${exitCode}.`, {
          exitCode,
          stderr,
        }),
      );
    });
  });
}

function upstreamArguments(commandArguments) {
  return ['-y', `skills@${SUPPORTED_SKILLS_CLI_VERSION}`, ...commandArguments];
}

function parseCandidateIds(output) {
  const lines = output.replaceAll(ANSI_SEQUENCE, '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes('Available Skills'));
  const end = lines.findIndex((line, index) => index > start && line.includes('Use --skill'));
  if (start < 0 || end < 0) {
    throw upstreamError(
      `Unrecognized skills@${SUPPORTED_SKILLS_CLI_VERSION} list output; refusing to guess candidates.`,
    );
  }
  const candidates = [];
  for (const line of lines.slice(start + 1, end)) {
    const match = line.match(/^│ {4}([a-z0-9][a-z0-9-]*)\s*$/);
    if (match) candidates.push({ id: match[1] });
  }
  if (candidates.length === 0) {
    throw upstreamError(
      `skills@${SUPPORTED_SKILLS_CLI_VERSION} returned no parseable candidates; refusing to continue.`,
    );
  }
  return candidates;
}

export async function discoverCandidates({ source, currentRuntime, environment }) {
  if (!runtimeRegistry(environment).some(({ id }) => id === currentRuntime)) {
    const error = new Error(`Unsupported runtime: ${currentRuntime}`);
    error.code = 'unsupported_runtime';
    throw error;
  }
  const workDirectory = await mkdtemp(join(tmpdir(), 'skills-manager-discovery-'));
  try {
    const executable = environment.SKILLS_MANAGER_NPX_PATH || 'npx';
    const { stdout } = await runProcess(
      executable,
      upstreamArguments(['add', source, '--list']),
      { cwd: workDirectory, environment },
    );
    return {
      source,
      candidates: parseCandidateIds(stdout),
      compatibility: { skillsCli: SUPPORTED_SKILLS_CLI_VERSION },
    };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

function normalizeRating(value) {
  return typeof value === 'string' ? value.toLowerCase() : null;
}

function auditError(code, message) {
  const error = new Error(message);
  error.auditCode = code;
  return error;
}

function securityReasons(assessments) {
  const reasons = [];
  const knownRatings = new Set(['safe', 'low', 'medium', 'high', 'critical']);
  const addRatingReason = (provider, label) => {
    const rating = assessments[provider].rating;
    if (rating === null) reasons.push({ provider, code: 'missing', message: `${label} result is missing.` });
    else if (!knownRatings.has(rating))
      reasons.push({
        provider,
        code: 'unknown_rating',
        value: rating,
        message: `${label} rating is unknown: ${rating}.`,
      });
    else if (!['safe', 'low'].includes(rating))
      reasons.push({
        provider,
        code: 'unsafe_rating',
        value: rating,
        message: `${label} rating is ${rating}.`,
      });
  };
  addRatingReason('gen', 'Gen');
  const alerts = assessments.socket.alerts;
  if (alerts === null || alerts < 0)
    reasons.push({
      provider: 'socket',
      code: 'missing_or_invalid',
      message: 'Socket result is missing or invalid.',
    });
  else if (alerts > 0)
    reasons.push({
      provider: 'socket',
      code: 'alerts',
      value: alerts,
      message: `Socket reported ${alerts} alert${alerts === 1 ? '' : 's'}.`,
    });
  addRatingReason('snyk', 'Snyk');
  return reasons;
}

async function assessSecurity({ source, skill, environment }) {
  const endpoint = new URL(environment.SKILLS_MANAGER_AUDIT_URL || 'https://add-skill.vercel.sh/audit');
  endpoint.searchParams.set('source', source);
  endpoint.searchParams.set('skills', skill);
  const timeoutMilliseconds = Number(environment.SKILLS_MANAGER_AUDIT_TIMEOUT_MS || 3000);
  let response;
  try {
    response = await fetch(endpoint, { signal: AbortSignal.timeout(timeoutMilliseconds) });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw auditError('timeout', 'Security assessment timed out.');
    }
    throw auditError('request_failed', `Security assessment request failed: ${error.message}`);
  }
  if (!response.ok) {
    throw auditError('request_failed', `Audit service returned HTTP ${response.status}.`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw auditError('malformed_response', 'Audit service returned malformed JSON.');
  }
  const raw = body?.[skill];
  const assessments = {
    gen: { rating: normalizeRating(raw?.ath?.risk) },
    socket: { alerts: Number.isInteger(raw?.socket?.alerts) ? raw.socket.alerts : null },
    snyk: { rating: normalizeRating(raw?.snyk?.risk) },
  };
  const reasons = securityReasons(assessments);
  const approved = reasons.length === 0;
  return {
    decision: approved ? 'approved' : 'confirmation_required',
    assessments,
    detailsUrl: `https://skills.sh/${source}`,
    ...(approved
      ? {}
      : {
          reasons: reasons.map(({ message: _message, ...reason }) => reason),
          explanation: `Security confirmation required: ${reasons.map(({ message }) => message).join(' ')}`,
        }),
  };
}

export async function saveManifest(workDir, manifest) {
  const manifestPath = join(workDir, 'skills-manager-attempt.json');
  const temporaryPath = join(workDir, `.skills-manager-attempt.${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporaryPath, manifestPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function isContained(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

export async function loadManifest(workDir) {
  const resolvedTemp = await realpath(tmpdir());
  const resolvedWorkDir = await realpath(workDir).catch(() => null);
  if (!resolvedWorkDir || !isContained(resolvedTemp, resolvedWorkDir) || resolvedWorkDir === resolvedTemp) {
    const error = new Error('The work directory must resolve beneath the operating-system temporary root.');
    error.code = 'invalid_work_directory';
    throw error;
  }
  const manifestPath = join(resolvedWorkDir, 'skills-manager-attempt.json');
  const manifestStat = await lstat(manifestPath).catch(() => null);
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) {
    const error = new Error('The work directory manifest must be a regular file.');
    error.code = 'invalid_work_directory';
    throw error;
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    const error = new Error('The work directory manifest is not valid JSON.');
    error.code = 'invalid_work_directory';
    throw error;
  }
  if (
    manifest?.version !== 1 ||
    !/^[a-f0-9]{32}$/.test(manifest?.nonce) ||
    typeof manifest?.candidateRoot !== 'string' ||
    typeof manifest?.operation !== 'object'
  ) {
    const error = new Error('The work directory manifest has an unsupported schema.');
    error.code = 'invalid_work_directory';
    throw error;
  }
  const resolvedCandidate = await realpath(manifest.candidateRoot).catch(() => null);
  if (!resolvedCandidate || !isContained(resolvedWorkDir, resolvedCandidate)) {
    const error = new Error('The candidate root must resolve inside its work directory.');
    error.code = 'invalid_work_directory';
    throw error;
  }
  return { manifest, resolvedWorkDir };
}

export async function assessCandidate({ source, skill, currentRuntime, scope, repositoryRoot, environment }) {
  const runtime = runtimeRegistry(environment).find(({ id }) => id === currentRuntime);
  if (!runtime) {
    const error = new Error(`Unsupported runtime: ${currentRuntime}`);
    error.code = 'unsupported_runtime';
    throw error;
  }
  const workDir = await mkdtemp(join(tmpdir(), 'skills-manager-attempt-'));
  const operation = {
    type: 'install',
    source,
    skill,
    runtime: currentRuntime,
    scope,
  };
  const nonce = randomBytes(16).toString('hex');
  try {
    await saveManifest(workDir, { version: 1, nonce, operation, repositoryRoot, phase: 'acquiring' });

    const executable = environment.SKILLS_MANAGER_NPX_PATH || 'npx';
    await runProcess(
      executable,
      upstreamArguments([
        'add',
        source,
        '--skill',
        skill,
        '--agent',
        currentRuntime,
        '--yes',
      ]),
      { cwd: workDir, environment },
    );
    const candidateRoot = join(workDir, runtime.projectSkillsDirectory, skill);
    const candidateStat = await lstat(candidateRoot).catch(() => null);
    const resolvedWorkDir = await realpath(workDir);
    const resolvedCandidateRoot = await realpath(candidateRoot).catch(() => null);
    if (
      !candidateStat?.isDirectory() ||
      candidateStat.isSymbolicLink() ||
      !resolvedCandidateRoot ||
      !isContained(resolvedWorkDir, resolvedCandidateRoot)
    ) {
      const error = new Error('The acquired candidate must be a real directory inside its Update attempt.');
      error.code = 'invalid_candidate';
      throw error;
    }

    let security;
    try {
      security = await assessSecurity({ source, skill, environment });
    } catch (error) {
      security = {
        decision: 'confirmation_required',
        assessments: {
          gen: { rating: null },
          socket: { alerts: null },
          snyk: { rating: null },
        },
        detailsUrl: `https://skills.sh/${source}`,
        reasons: [{ provider: 'audit', code: error.auditCode || 'request_failed' }],
        explanation: `Security assessment unavailable: ${error.message}`,
      };
    }
    await saveManifest(workDir, {
      version: 1,
      nonce,
      operation,
      repositoryRoot,
      phase: security.decision === 'approved' ? 'assessed' : 'awaiting_risk_confirmation',
      candidateRoot,
      security,
    });
    return {
      workDir,
      operation,
      security,
      ...(security.decision === 'approved' ? { candidate: { root: candidateRoot } } : {}),
    };
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

export async function continueRiskAcceptance({ workDir, acceptRisk, acceptCopyMode }) {
  const { manifest, resolvedWorkDir } = await loadManifest(workDir);
  if (acceptCopyMode && !acceptRisk && manifest.phase === 'awaiting_topology_confirmation') {
    const topology = { ...manifest.topology, requiresCopyConfirmation: false, mode: 'copies' };
    const review = {
      ...manifest.review,
      topology: {
        mode: topology.mode,
        physicalTargets: topology.physicalTargets,
        links: [],
      },
    };
    await saveManifest(resolvedWorkDir, {
      ...manifest,
      phase: 'awaiting_publication',
      topology,
      review,
    });
    return {
      envelopeStatus: 'needs_confirmation',
      workDir,
      operation: manifest.operation,
      candidate: { root: manifest.candidateRoot },
      validation: manifest.validation,
      review,
    };
  }
  if (acceptRisk && !acceptCopyMode && manifest.phase === 'awaiting_risk_confirmation') {
    const security = {
      ...manifest.security,
      decision: 'accepted',
      riskAccepted: true,
    };
    await saveManifest(resolvedWorkDir, {
      ...manifest,
      phase: 'assessed',
      security,
    });
    return {
      workDir,
      operation: manifest.operation,
      security,
      candidate: { root: manifest.candidateRoot },
    };
  }
  {
    const decision =
      manifest.phase === 'awaiting_topology_confirmation'
        ? 'copy-mode confirmation'
        : manifest.phase === 'awaiting_risk_confirmation'
          ? 'security risk acceptance'
          : 'a supported confirmation';
    const error = new Error(`This Update attempt is not awaiting exactly one ${decision}.`);
    error.code = 'invalid_continuation';
    throw error;
  }
}

export async function abortAttempt({ workDir }) {
  const { manifest, resolvedWorkDir } = await loadManifest(workDir);
  await rm(resolvedWorkDir, { recursive: true });
  return { operation: manifest.operation };
}
