#!/usr/bin/env node

import { lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep the CLI protocol stable independently from the Skill package name.
const ENVELOPE_VERSION = 1;
const MINIMUM_NODE_MAJOR = 22;
const INTENT_MUTATION_OPTIONS = {
  'intent-delete': new Set(['--confirm-delete', '--intent-id', '--runtime', '--skill']),
  'intent-disable': new Set(['--intent-id', '--runtime', '--skill']),
  'intent-edit': new Set(['--intent', '--intent-id', '--runtime', '--skill']),
  'intent-enable': new Set(['--intent-id', '--runtime', '--skill']),
  'intent-obsolete': new Set(['--intent-id', '--reason', '--runtime', '--skill']),
};
const INTENT_MUTATION_COMMANDS = Object.keys(INTENT_MUTATION_OPTIONS);
const INTENT_MUTATION_OPERATION_TYPES = INTENT_MUTATION_COMMANDS.map((command) =>
  command.replace('-', '_'),
);
const COMMAND_OPTIONS = {
  abort: new Set(['--work-dir']),
  assess: new Set(['--runtime', '--scope', '--source', '--skill']),
  continue: new Set([
    '--accept-change-scope',
    '--accept-copy-mode',
    '--accept-risk',
    '--accept-semantic-revision',
    '--keep-obsolete-intents',
    '--mark-obsolete-intents',
    '--work-dir',
  ]),
  discover: new Set(['--runtime', '--source']),
  inspect: new Set(['--runtime', '--scope']),
  'intent-add': new Set(['--intent', '--runtime', '--skill']),
  'intent-list': new Set(['--skill']),
  'intent-result': new Set(['--result', '--results', '--summary', '--work-dir']),
  publish: new Set(['--accept-publication', '--work-dir']),
  update: new Set(['--runtime', '--skill']),
  validate: new Set(['--work-dir']),
  'work-order': new Set(['--work-dir']),
  ...INTENT_MUTATION_OPTIONS,
};

function writeEnvelope(envelope, exitCode = 0) {
  process.stdout.write(`${JSON.stringify({ version: ENVELOPE_VERSION, ...envelope })}\n`);
  process.exitCode = exitCode;
}

function fail(command, code, message) {
  writeEnvelope({ status: 'failed', command, error: { code, message } }, 1);
}

function parseArguments(arguments_) {
  const [command, ...tokens] = arguments_;
  const options = { scope: 'project' };
  const flags = new Set([
    '--accept-change-scope',
    '--accept-copy-mode',
    '--accept-publication',
    '--accept-risk',
    '--accept-semantic-revision',
    '--confirm-delete',
    '--keep-obsolete-intents',
    '--mark-obsolete-intents',
  ]);
  const allowedOptions = COMMAND_OPTIONS[command];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!allowedOptions?.has(token)) {
      const error = new Error(`Argument ${token} does not apply to ${command || 'an unknown command'}.`);
      error.code = 'invalid_arguments';
      throw error;
    }
    if (flags.has(token)) {
      options[token.slice(2)] = true;
      continue;
    }
    const value = tokens[index + 1];
    if (!value || value.startsWith('--')) {
      const error = new Error(`Missing value for ${token}`);
      error.code = 'invalid_arguments';
      throw error;
    }
    options[token.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

async function findRepositoryRoot(start) {
  let candidate = resolve(start);
  while (true) {
    if (await exists(resolve(candidate, '.git'))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return resolve(start);
    candidate = parent;
  }
}

async function main() {
  const nodeMajor = Number.parseInt(process.version.slice(1).split('.')[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < MINIMUM_NODE_MAJOR) {
    fail(
      process.argv[2] || null,
      'unsupported_node_version',
      `skills-manager requires Node 22 or newer; received ${process.version}.`,
    );
    return;
  }

  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
    if (
      ![
        'inspect',
        'discover',
        'assess',
        'intent-add',
        'intent-list',
        ...INTENT_MUTATION_COMMANDS,
        'work-order',
        'intent-result',
        'continue',
        'abort',
        'validate',
        'publish',
        'update',
      ].includes(parsed.command)
    ) {
      const error = new Error(parsed.command ? `Unknown command: ${parsed.command}` : 'A command is required.');
      error.code = 'invalid_command';
      throw error;
    }
    if (
      ![
        'continue',
        'abort',
        'validate',
        'publish',
        'work-order',
        'intent-result',
        'intent-list',
      ].includes(
        parsed.command,
      ) &&
      !parsed.options.runtime
    ) {
      const error = new Error(`${parsed.command} requires --runtime <agent-id>.`);
      error.code = 'missing_runtime';
      throw error;
    }
    if (!['project', 'global'].includes(parsed.options.scope)) {
      const error = new Error(`Unsupported scope: ${parsed.options.scope}`);
      error.code = 'unsupported_scope';
      throw error;
    }

    if (parsed.command === 'work-order') {
      if (!parsed.options['work-dir']) {
        const error = new Error('work-order requires --work-dir <path>.');
        error.code = 'invalid_arguments';
        throw error;
      }
      const { createIntentWorkOrder } = await import('./lib/intents.mjs');
      const data = await createIntentWorkOrder({ workDir: parsed.options['work-dir'] });
      writeEnvelope({ status: 'work_order', command: 'work-order', data });
    } else if (parsed.command === 'intent-result') {
      if (
        !parsed.options['work-dir'] ||
        (!parsed.options.result && !parsed.options.results) ||
        (parsed.options.result && parsed.options.results)
      ) {
        const error = new Error(
          'intent-result requires --work-dir <path> and exactly one of --result <status> or --results <json>.',
        );
        error.code = 'invalid_arguments';
        throw error;
      }
      const { recordIntentResult } = await import('./lib/intents.mjs');
      const data = await recordIntentResult({
        workDir: parsed.options['work-dir'],
        result: parsed.options.result,
        results: parsed.options.results,
        summary: parsed.options.summary,
      });
      const { envelopeStatus = 'needs_confirmation', ...result } = data;
      writeEnvelope({ status: envelopeStatus, command: 'intent-result', data: result });
    } else if (parsed.command === 'validate') {
      if (!parsed.options['work-dir']) {
        const error = new Error('validate requires --work-dir <path>.');
        error.code = 'invalid_arguments';
        throw error;
      }
      const { validateAttempt } = await import('./lib/publication.mjs');
      const result = await validateAttempt({ workDir: parsed.options['work-dir'] });
      const { envelopeStatus = 'needs_confirmation', ...data } = result;
      writeEnvelope({ status: envelopeStatus, command: 'validate', data });
    } else if (parsed.command === 'publish') {
      if (!parsed.options['work-dir'] || parsed.options['accept-publication'] !== true) {
        const error = new Error('publish requires --work-dir <path> and --accept-publication.');
        error.code = 'invalid_arguments';
        throw error;
      }
      const { publishAttempt } = await import('./lib/publication.mjs');
      const data = await publishAttempt({ workDir: parsed.options['work-dir'] });
      writeEnvelope({ status: 'complete', command: 'publish', data });
    } else if (parsed.command === 'abort') {
      if (!parsed.options['work-dir']) {
        const error = new Error('abort requires --work-dir <path>.');
        error.code = 'invalid_arguments';
        throw error;
      }
      const { abortAttempt } = await import('./lib/upstream.mjs');
      const data = await abortAttempt({ workDir: parsed.options['work-dir'] });
      writeEnvelope({ status: 'complete', command: 'abort', data });
    } else if (parsed.command === 'continue') {
      if (!parsed.options['work-dir']) {
        const error = new Error('continue requires --work-dir <path>.');
        error.code = 'invalid_arguments';
        throw error;
      }
      let data;
      const confirmationCount = [
        parsed.options['accept-change-scope'],
        parsed.options['accept-copy-mode'],
        parsed.options['accept-risk'],
        parsed.options['accept-semantic-revision'],
        parsed.options['keep-obsolete-intents'],
        parsed.options['mark-obsolete-intents'],
      ].filter(Boolean).length;
      if (confirmationCount !== 1) {
        const error = new Error(
          parsed.options['accept-copy-mode'] && parsed.options['accept-risk']
            ? 'copy-mode confirmation cannot be combined with security risk acceptance.'
            : 'continue requires exactly one confirmation flag.',
        );
        error.code = 'invalid_continuation';
        throw error;
      }
      if (parsed.options['accept-change-scope'] === true) {
        const { continueChangedFileScope } = await import('./lib/intents.mjs');
        data = await continueChangedFileScope({ workDir: parsed.options['work-dir'] });
      } else if (parsed.options['accept-semantic-revision'] === true) {
        const { continueSemanticRevision } = await import('./lib/intents.mjs');
        data = await continueSemanticRevision({ workDir: parsed.options['work-dir'] });
      } else if (parsed.options['keep-obsolete-intents'] === true) {
        const { continueKeepingObsoleteIntents } = await import('./lib/intents.mjs');
        data = await continueKeepingObsoleteIntents({ workDir: parsed.options['work-dir'] });
      } else if (parsed.options['mark-obsolete-intents'] === true) {
        const { continueMarkingObsoleteIntents } = await import('./lib/intents.mjs');
        data = await continueMarkingObsoleteIntents({ workDir: parsed.options['work-dir'] });
      } else {
        const { continueRiskAcceptance } = await import('./lib/upstream.mjs');
        data = await continueRiskAcceptance({
          workDir: parsed.options['work-dir'],
          acceptRisk: parsed.options['accept-risk'] === true,
          acceptCopyMode: parsed.options['accept-copy-mode'] === true,
        });
        if (
          data.operation?.type === 'update' ||
          INTENT_MUTATION_OPERATION_TYPES.includes(data.operation?.type)
        ) {
          const { prepareUpdateAttempt } = await import('./lib/intents.mjs');
          data = await prepareUpdateAttempt({ workDir: parsed.options['work-dir'] });
        }
      }
      const { envelopeStatus = 'ready', ...result } = data;
      writeEnvelope({ status: envelopeStatus, command: 'continue', data: result });
    } else if (parsed.command === 'intent-list') {
      if (!parsed.options.skill) {
        const error = new Error('intent-list requires --skill <skill-id>.');
        error.code = 'invalid_arguments';
        throw error;
      }
      const { listIntents } = await import('./lib/intents.mjs');
      const data = await listIntents({
        repositoryRoot: await findRepositoryRoot(process.cwd()),
        skill: parsed.options.skill,
      });
      writeEnvelope({ status: 'ready', command: 'intent-list', data });
    } else if (
      INTENT_MUTATION_COMMANDS.includes(parsed.command)
    ) {
      if (
        !parsed.options.skill ||
        !parsed.options['intent-id'] ||
        (parsed.command === 'intent-edit' && !parsed.options.intent) ||
        (parsed.command === 'intent-obsolete' && !parsed.options.reason)
      ) {
        const error = new Error(`${parsed.command} is missing its required Skill or Intent arguments.`);
        error.code = 'invalid_arguments';
        throw error;
      }
      const { beginIntentMutation } = await import('./lib/intents.mjs');
      const data = await beginIntentMutation({
        repositoryRoot: await findRepositoryRoot(process.cwd()),
        skill: parsed.options.skill,
        intentId: parsed.options['intent-id'],
        mutation: parsed.command.slice('intent-'.length),
        text: parsed.options.intent,
        reason: parsed.options.reason,
        confirmDelete: parsed.options['confirm-delete'] === true,
        currentRuntime: parsed.options.runtime,
        environment: process.env,
      });
      const {
        envelopeStatus = data.security?.decision === 'approved' ? 'ready' : 'needs_confirmation',
        ...result
      } = data;
      writeEnvelope({ status: envelopeStatus, command: parsed.command, data: result });
    } else if (parsed.command === 'update') {
      if (!parsed.options.skill) {
        const error = new Error('update requires --skill <skill-id>.');
        error.code = 'invalid_arguments';
        throw error;
      }
      const { beginUpdate } = await import('./lib/intents.mjs');
      const data = await beginUpdate({
        repositoryRoot: await findRepositoryRoot(process.cwd()),
        skill: parsed.options.skill,
        currentRuntime: parsed.options.runtime,
        environment: process.env,
      });
      const {
        envelopeStatus = data.security?.decision === 'approved' ? 'ready' : 'needs_confirmation',
        ...result
      } = data;
      writeEnvelope({ status: envelopeStatus, command: 'update', data: result });
    } else if (parsed.command === 'intent-add') {
      if (!parsed.options.skill || !parsed.options.intent) {
        const error = new Error('intent-add requires --skill <skill-id> and --intent <outcome>.');
        error.code = 'invalid_arguments';
        throw error;
      }
      const { beginIntentAdd } = await import('./lib/intents.mjs');
      const data = await beginIntentAdd({
        repositoryRoot: await findRepositoryRoot(process.cwd()),
        skill: parsed.options.skill,
        text: parsed.options.intent,
        currentRuntime: parsed.options.runtime,
        environment: process.env,
      });
      writeEnvelope({
        status: data.security.decision === 'approved' ? 'ready' : 'needs_confirmation',
        command: 'intent-add',
        data,
      });
    } else if (parsed.command === 'discover') {
      if (!parsed.options.source) {
        const error = new Error('discover requires --source <repository>.');
        error.code = 'missing_source';
        throw error;
      }
      const { discoverCandidates } = await import('./lib/upstream.mjs');
      const data = await discoverCandidates({
        source: parsed.options.source,
        currentRuntime: parsed.options.runtime,
        environment: process.env,
      });
      writeEnvelope({ status: 'ready', command: 'discover', data });
    } else if (parsed.command === 'assess') {
      if (!parsed.options.source || !parsed.options.skill) {
        const error = new Error('assess requires --source <repository> and --skill <skill-id>.');
        error.code = 'invalid_arguments';
        throw error;
      }
      const { assessCandidate } = await import('./lib/upstream.mjs');
      const data = await assessCandidate({
        source: parsed.options.source,
        skill: parsed.options.skill,
        currentRuntime: parsed.options.runtime,
        scope: parsed.options.scope,
        repositoryRoot: await findRepositoryRoot(process.cwd()),
        environment: process.env,
      });
      writeEnvelope({
        status: data.security.decision === 'approved' ? 'ready' : 'needs_confirmation',
        command: 'assess',
        data,
      });
    } else {
      const repositoryRoot = await findRepositoryRoot(process.cwd());
      const { inspectEnvironment } = await import('./lib/inspect.mjs');
      const data = await inspectEnvironment({
        repositoryRoot,
        currentRuntime: parsed.options.runtime,
        scope: parsed.options.scope,
        environment: process.env,
      });
      writeEnvelope({ status: 'ready', command: 'inspect', data });
    }
  } catch (error) {
    if (error?.status === 'conflict') {
      writeEnvelope({ status: 'conflict', command: parsed?.command || null, data: error.data });
    } else {
      fail(parsed?.command || process.argv[2] || null, error?.code || 'inspection_failed', error.message);
    }
  }
}

await main();
