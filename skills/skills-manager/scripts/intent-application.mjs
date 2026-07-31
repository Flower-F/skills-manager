#!/usr/bin/env node

import { isUtf8 } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, lstat, mkdtemp, open, opendir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const VERSION = 1;
const HANDLE_PREFIX = 'skills-manager-intent-application-';
const METADATA_FILE = 'handle.json';
const BASELINE_DIRECTORY = 'baseline';
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_LINES = 100_000;
const MAX_BATCH_INSTALLATIONS = 256;
const MAX_BATCH_INPUT_BYTES = 1024 * 1024;
const MAX_EVIDENCE_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_CHILD_STREAM_BYTES = 4 * 1024 * 1024;
const LIST_TIMEOUT_MS = 30_000;
const ACQUIRE_TIMEOUT_MS = 120_000;
const INSTALLATION_OPTIONS = ['name', 'source', 'scope', 'path'];
const OPERATION_SCHEMAS = Object.freeze({
  preflight: { required: [], optional: ['name', 'scope', 'installations'] },
  capture: { required: [], optional: [...INSTALLATION_OPTIONS, 'installations'] },
  review: { required: [...INSTALLATION_OPTIONS, 'handle', 'marker'], optional: [] },
  close: { required: [...INSTALLATION_OPTIONS, 'handle', 'marker', 'outcome'], optional: [] },
  'verify-fulfillment': { required: [], optional: [...INSTALLATION_OPTIONS, 'installations'] },
});

class OperationError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function parseArguments(argv) {
  const [operation, ...rest] = argv;
  const schema = OPERATION_SCHEMAS[operation];
  if (!schema) {
    throw new OperationError('invalid_arguments', 'Usage: intent-application preflight|capture|review|close|verify-fulfillment [options]', 2);
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new OperationError('invalid_arguments', `Missing value for ${flag ?? 'option'}.`, 2);
    }
    const key = flag.slice(2);
    if (options[key] !== undefined) throw new OperationError('invalid_arguments', `Duplicate option ${flag}.`, 2);
    options[key] = value;
  }
  for (const key of schema.required) {
    if (!options[key]?.trim()) throw new OperationError('invalid_arguments', `Missing required option --${key}.`, 2);
  }
  if (options.scope !== undefined && !['project', 'global'].includes(options.scope)) throw new OperationError('invalid_arguments', '--scope must be project or global.', 2);
  if (operation === 'close' && !['complete', 'conflict', 'cancelled'].includes(options.outcome)) {
    throw new OperationError('invalid_arguments', '--outcome must be complete, conflict, or cancelled.', 2);
  }
  const allowed = new Set([...schema.required, ...schema.optional]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new OperationError('invalid_arguments', `Unsupported option --${key}.`, 2);
  const batch = options.installations !== undefined;
  if (batch) {
    const shared = operation === 'capture' ? new Set(['scope']) : new Set();
    for (const key of INSTALLATION_OPTIONS) if (options[key] !== undefined && !shared.has(key)) throw new OperationError('invalid_arguments', `--installations cannot be combined with --${key}.`, 2);
  }
  if (!batch && ['preflight', 'capture', 'verify-fulfillment'].includes(operation)) {
    const required = operation === 'preflight' ? ['name'] : INSTALLATION_OPTIONS;
    for (const key of required) if (!options[key]?.trim()) throw new OperationError('invalid_arguments', `Missing required option --${key}.`, 2);
  }
  if (batch && operation === 'capture' && !options.scope) throw new OperationError('invalid_arguments', 'Batch capture requires --scope.', 2);
  return { operation, options };
}

function parseBatchInput(value, requiredFields, shared = {}, optionalFields = []) {
  if (Buffer.byteLength(value) > MAX_BATCH_INPUT_BYTES) throw new OperationError('invalid_arguments', 'Batch Installation input exceeds 1 MiB.', 2);
  let input;
  try {
    input = JSON.parse(value);
  } catch {
    throw new OperationError('invalid_arguments', 'Batch Installation input is malformed JSON.', 2);
  }
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_BATCH_INSTALLATIONS) {
    throw new OperationError('invalid_arguments', `Batch Installation input must contain 1 to ${MAX_BATCH_INSTALLATIONS} entries.`, 2);
  }
  const allowed = new Set([...requiredFields, ...optionalFields]);
  const installations = input.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new OperationError('invalid_arguments', `Batch Installation ${index} is malformed.`, 2);
    for (const key of requiredFields) if (typeof item[key] !== 'string' || !item[key].trim()) throw new OperationError('invalid_arguments', `Batch Installation ${index} is missing ${key}.`, 2);
    for (const key of optionalFields) if (item[key] !== undefined && (typeof item[key] !== 'string' || !item[key].trim())) throw new OperationError('invalid_arguments', `Batch Installation ${index} has malformed ${key}.`, 2);
    for (const key of Object.keys(item)) if (!allowed.has(key)) throw new OperationError('invalid_arguments', `Batch Installation ${index} contains unsupported field ${key}.`, 2);
    return { ...item, ...shared };
  });
  const keys = installations.map((item) => JSON.stringify(item));
  if (new Set(keys).size !== keys.length) throw new OperationError('invalid_arguments', 'Batch Installation input contains a duplicate identity.', 2);
  return installations;
}

function compareInstallations(left, right) {
  const leftKey = `${left.scope ?? ''}\0${left.name}\0${normalizeSource(left.source ?? '')}\0${left.path ?? ''}`;
  const rightKey = `${right.scope ?? ''}\0${right.name}\0${normalizeSource(right.source ?? '')}\0${right.path ?? ''}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function stableInstallations(installations) {
  return [...installations].sort(compareInstallations);
}

function normalizeSource(source) {
  const value = source.trim().replace(/^git\+/, '').replace(/\/$/, '').replace(/\.git$/, '');
  const githubSsh = /^git@github\.com:(.+)$/i.exec(value);
  if (githubSsh) return githubSsh[1].toLowerCase();
  const githubUrl = /^(?:https?|ssh):\/\/(?:git@)?(?:www\.)?github\.com\/(.+)$/i.exec(value);
  if (githubUrl) return githubUrl[1].toLowerCase();
  if (/^[^/:]+\/[^/]+$/.test(value)) return value.toLowerCase();
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '').replace(/\.git$/, '')}`;
  } catch {
    return value;
  }
}

function publicSource(entry) {
  const source = typeof entry.sourceUrl === 'string' && entry.sourceUrl.trim() ? entry.sourceUrl : entry.source;
  if (typeof source !== 'string' || !source.trim()) throw new OperationError('malformed_listing', 'Installation source metadata is missing or malformed.');
  const normalized = normalizeSource(source);
  if (!normalized) throw new OperationError('malformed_listing', 'Installation source metadata normalizes to an empty identity.');
  return normalized;
}

function publicEntryName(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new OperationError('malformed_listing', 'Public list output contains a malformed Installation.');
  if (typeof entry.name !== 'string' || !entry.name.trim()) throw new OperationError('malformed_listing', 'Installation field name is missing or malformed.');
  return entry.name;
}

function validateEntry(entry, expectedScope) {
  publicEntryName(entry);
  for (const field of ['path', 'scope']) {
    if (typeof entry[field] !== 'string' || !entry[field].trim()) throw new OperationError('malformed_listing', `Installation field ${field} is missing or malformed.`);
  }
  if (!Array.isArray(entry.agents) || entry.agents.length === 0 || entry.agents.some((agent) => typeof agent !== 'string' || !agent.trim())) {
    throw new OperationError('malformed_listing', 'Installation field agents is missing or malformed.');
  }
  if (typeof entry.sourceType !== 'string' || !entry.sourceType.trim()) throw new OperationError('malformed_listing', 'Installation field sourceType is missing or malformed.');
  if (entry.scope !== expectedScope) throw new OperationError('malformed_listing', `Public ${expectedScope} listing returned an Installation with ${entry.scope} scope.`);
  publicSource(entry);
  return entry;
}

function commandTimeout(args) {
  const acquisition = args[0] === 'add';
  const configured = process.env.NODE_ENV === 'test'
    ? Number(process.env[acquisition ? 'SKILLS_MANAGER_ACQUIRE_TIMEOUT_MS' : 'SKILLS_MANAGER_LIST_TIMEOUT_MS'])
    : Number.NaN;
  return Number.isFinite(configured) && configured > 0 ? configured : acquisition ? ACQUIRE_TIMEOUT_MS : LIST_TIMEOUT_MS;
}

function patchLimitBytes() {
  const configured = process.env.NODE_ENV === 'test' ? Number(process.env.SKILLS_MANAGER_PATCH_LIMIT_BYTES) : Number.NaN;
  return Number.isFinite(configured) && configured > 0 ? configured : MAX_PATCH_BYTES;
}

function evidenceLimitBytes() {
  const configured = process.env.NODE_ENV === 'test' ? Number(process.env.SKILLS_MANAGER_EVIDENCE_LIMIT_BYTES) : Number.NaN;
  return Number.isFinite(configured) && configured > 0 ? configured : MAX_EVIDENCE_METADATA_BYTES;
}

async function runSkillsCommand(args, cwd = process.cwd()) {
  const child = spawn('npx', ['skills', ...args], { cwd, env: process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: [], stderr: [] };
  const sizes = { stdout: 0, stderr: 0 };
  let failure;
  const terminate = () => {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      const fallback = () => {
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
      };
      killer.on('error', fallback);
      killer.on('close', (code) => {
        if (code !== 0) fallback();
      });
      killer.unref();
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  };
  const collect = (stream) => (chunk) => {
    if (failure) return;
    sizes[stream] += chunk.length;
    if (sizes[stream] > MAX_CHILD_STREAM_BYTES) {
      failure = new OperationError('child_output_overflow', `Internal npx skills ${args[0]} ${stream} exceeded 4 MiB.`);
      terminate();
      return;
    }
    output[stream].push(chunk);
  };
  child.stdout.on('data', collect('stdout'));
  child.stderr.on('data', collect('stderr'));
  const timer = setTimeout(() => {
    if (failure) return;
    failure = new OperationError('child_timeout', `Internal npx skills ${args[0]} timed out after ${commandTimeout(args)} ms.`);
    terminate();
  }, commandTimeout(args));
  timer.unref();
  let exitCode;
  try {
    exitCode = await new Promise((done, reject) => {
      child.on('error', reject);
      child.on('close', done);
    });
  } finally {
    clearTimeout(timer);
  }
  if (failure) throw failure;
  return { exitCode, stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8') };
}

async function runList(scope, cwd = process.cwd(), selectedNames) {
  const result = await runSkillsCommand(['list', '--json', ...(scope === 'global' ? ['--global'] : [])], cwd);
  if (result.exitCode !== 0) throw new OperationError('listing_failed', `Public ${scope} Installation listing failed${result.stderr.trim() ? `: ${result.stderr.trim()}` : '.'}`);
  let entries;
  try {
    entries = JSON.parse(result.stdout);
  } catch {
    throw new OperationError('malformed_listing', `Public ${scope} Installation listing returned malformed JSON.`);
  }
  if (!Array.isArray(entries)) throw new OperationError('malformed_listing', `Public ${scope} Installation listing did not return an array.`);
  const selected = selectedNames === undefined ? entries : entries.filter((entry) => selectedNames.has(publicEntryName(entry)));
  return selected.map((entry) => validateEntry(entry, scope));
}

function intentDirectory(scope) {
  if (scope === 'project') return join(process.cwd(), '.skills-manager', 'intents');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'skills-manager', 'intents');
}

function identitySlug(value) {
  return [...Buffer.from(value, 'utf8')].map((byte) => {
    const character = String.fromCharCode(byte);
    return /[a-zA-Z0-9._]/.test(character) ? character : `-${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

function parseIntentDocument(content, path, installation) {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  if (!match) throw new OperationError('invalid_intent', `Intent document ${path} has malformed frontmatter.`);
  const metadata = {};
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 1) throw new OperationError('invalid_intent', `Intent document ${path} has malformed frontmatter.`);
    const key = line.slice(0, separator).trim();
    if (metadata[key] !== undefined) throw new OperationError('invalid_intent', `Intent document ${path} repeats identity field ${key}.`);
    metadata[key] = line.slice(separator + 1).trim();
  }
  for (const field of ['source', 'skill', 'scope']) if (!metadata[field]) throw new OperationError('invalid_intent', `Intent document ${path} is missing identity field ${field}.`);
  for (const field of Object.keys(metadata)) if (!['source', 'skill', 'scope'].includes(field)) throw new OperationError('invalid_intent', `Intent document ${path} contains unsupported identity field ${field}.`);
  if (normalizeSource(metadata.source) !== installation.source || metadata.skill !== installation.name || metadata.scope !== installation.scope) {
    throw new OperationError('intent_identity_mismatch', `Intent document ${path} does not match the selected Installation identity.`);
  }
  const lines = content.slice(match[0].length).trim().split('\n');
  if (lines.shift() !== '# Active Intents') throw new OperationError('invalid_intent', `Intent document ${path} has no supported active Intent list.`);
  const outcomes = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const bullet = /^-\s+(\S.*)$/.exec(line);
    if (bullet) outcomes.push(bullet[1]);
    else if (outcomes.length > 0 && /^\s{2,}\S/.test(line)) outcomes[outcomes.length - 1] += `\n${line.trim()}`;
    else throw new OperationError('invalid_intent', `Intent document ${path} contains unsupported content outside the active Intent list.`);
  }
  if (outcomes.length === 0) throw new OperationError('invalid_intent', `Intent document ${path} contains no active Intent.`);
  return outcomes;
}

async function readIntent(installation) {
  const filename = `${identitySlug(installation.source)}--${identitySlug(installation.name)}.md`;
  const path = join(intentDirectory(installation.scope), filename);
  let content;
  try {
    const buffer = await readFile(path);
    if (!isUtf8(buffer)) throw new OperationError('invalid_intent', `Intent document ${path} is not readable UTF-8.`);
    content = buffer.toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'absent', outcomes: [] };
    throw error;
  }
  return { status: 'active', outcomes: parseIntentDocument(content, path, installation) };
}

async function preflightSelection(options, project, global) {
  const matches = [...project, ...global].filter((entry) => entry.name === options.name);
  if (project.filter((entry) => entry.name === options.name).length > 1 || global.filter((entry) => entry.name === options.name).length > 1) {
    throw new OperationError('duplicate_installation', `Public listing returned duplicate ${options.name} Installations in one scope.`);
  }
  const selected = options.scope ? matches.filter((entry) => entry.scope === options.scope) : matches;
  if (!options.scope && new Set(matches.map((entry) => entry.scope)).size > 1) {
    throw new OperationError('scope_ambiguous', `${options.name} is installed in both project and global scope.`);
  }
  if (selected.length !== 1) throw new OperationError('installation_not_found', `Expected exactly one selected Installation named ${options.name}.`);
  const entry = selected[0];
  const installation = { name: entry.name, source: publicSource(entry), scope: entry.scope, path: resolve(entry.path), agents: [...entry.agents] };
  await resolveDirectory(installation.path, 'installation_unavailable', 'The selected installed path is not an accessible directory.');
  const intent = await readIntent(installation);
  return { installation, intent };
}

function machineError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { code: error instanceof OperationError ? error.code : 'internal_error', message: message.length > 4096 ? `${message.slice(0, 4096)}…` : message };
}

async function preflight(options) {
  const requests = options.installations === undefined
    ? null
    : stableInstallations(parseBatchInput(options.installations, ['name'], {}, ['scope']));
  const selectedNames = new Set((requests ?? [options]).map(({ name }) => name));
  let project;
  let global;
  try {
    project = await runList('project', process.cwd(), selectedNames);
    global = await runList('global', process.cwd(), selectedNames);
  } catch (error) {
    if (!requests) throw error;
    return { version: VERSION, operation: 'preflight', status: 'failed', results: requests.map((request) => ({ request, status: 'failed', error: machineError(error) })) };
  }
  if (!requests) return { version: VERSION, operation: 'preflight', status: 'complete', ...await preflightSelection(options, project, global) };
  const results = [];
  let outputRemaining = evidenceLimitBytes();
  for (const request of requests) {
    if (request.scope !== undefined && !['project', 'global'].includes(request.scope)) {
      results.push({ request, status: 'failed', error: machineError(new OperationError('invalid_arguments', 'Batch Installation scope must be project or global.', 2)) });
      continue;
    }
    try {
      const selection = await preflightSelection(request, project, global);
      const bytes = Buffer.byteLength(JSON.stringify(selection)) + Buffer.byteLength(JSON.stringify(request)) + 128;
      if (bytes > outputRemaining) throw new OperationError('batch_output_overflow', 'Batch preflight output exceeds the bounded output budget. Split the selection before mutation.');
      outputRemaining -= bytes;
      results.push({ request, ...selection, status: 'complete' });
    } catch (error) {
      results.push({ request, status: 'failed', error: machineError(error) });
    }
  }
  const counts = new Map();
  for (const result of results) if (result.status === 'complete') counts.set(installationKey(result.installation), (counts.get(installationKey(result.installation)) ?? 0) + 1);
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === 'complete' && counts.get(installationKey(result.installation)) > 1) {
      results[index] = { request: result.request, status: 'failed', error: machineError(new OperationError('duplicate_installation', 'Batch selection resolves the same Installation more than once.')) };
    }
  }
  return { version: VERSION, operation: 'preflight', status: results.every(({ status }) => status === 'complete') ? 'complete' : 'failed', results };
}

function expectedInstallation(options) {
  const source = normalizeSource(options.source);
  if (!source) throw new OperationError('invalid_arguments', 'Expected source normalizes to an empty identity.', 2);
  return { name: options.name, source, scope: options.scope, path: resolve(options.path) };
}

function installationKey(installation) {
  return `${installation.name}\0${installation.source}\0${installation.scope}\0${installation.path}`;
}

async function prepareBatchIdentities(requests) {
  const prepared = await Promise.all(requests.map(async (request) => {
    try {
      const installation = expectedInstallation(request);
      let canonicalPath = installation.path;
      try {
        canonicalPath = await realpath(installation.path);
      } catch {
        // Selection reports the concrete inaccessible-path failure independently.
      }
      return { request, installation, canonicalKey: installationKey({ ...installation, path: canonicalPath }) };
    } catch (error) {
      return { request, error };
    }
  }));
  const counts = new Map();
  for (const item of prepared) if (item.installation) counts.set(item.canonicalKey, (counts.get(item.canonicalKey) ?? 0) + 1);
  for (const item of prepared) {
    if (item.installation && counts.get(item.canonicalKey) > 1) {
      item.error = new OperationError('duplicate_installation', 'Batch input resolves the same Installation more than once.', 2);
      delete item.installation;
    }
  }
  return prepared;
}

async function resolveDirectory(path, code, message) {
  try {
    const root = await realpath(path);
    if (!(await lstat(root)).isDirectory()) throw new Error('not a directory');
    return root;
  } catch {
    throw new OperationError(code, message);
  }
}

async function selectInstallationFromEntries(options, entries) {
  const expected = expectedInstallation(options);
  const named = entries.filter((entry) => entry.name === expected.name);
  if (named.length !== 1) throw new OperationError('installation_not_found', `Expected exactly one ${expected.scope} Installation named ${expected.name}.`);
  const entry = named[0];
  const actualPath = resolve(entry.path);
  const mismatches = [];
  if (entry.scope !== expected.scope) mismatches.push('scope');
  if (publicSource(entry) !== expected.source) mismatches.push('source');
  if (actualPath !== expected.path) mismatches.push('path');
  if (mismatches.length) throw new OperationError('identity_mismatch', `Installation ${mismatches.join(', ')} did not match the expected identity.`);
  const installed = await resolveDirectory(actualPath, 'installation_unavailable', 'The expected installed path is not an accessible directory.');
  return { identity: { ...expected, path: actualPath }, installed };
}

async function selectInstallation(options) {
  const expected = expectedInstallation(options);
  return selectInstallationFromEntries(expected, await runList(expected.scope));
}

async function captureSelected(installation) {
  await validateSkillIdentity(installation.installed, installation.identity.name);
  const handlePath = await mkdtemp(join(tmpdir(), HANDLE_PREFIX));
  const marker = randomBytes(32).toString('hex');
  const metadata = {
    version: VERSION,
    marker,
    installation: installation.identity,
    workingDirectory: resolve(process.cwd()),
    createdAt: new Date().toISOString(),
  };
  try {
    await cp(installation.installed, join(handlePath, BASELINE_DIRECTORY), { recursive: true, dereference: false, preserveTimestamps: true, verbatimSymlinks: true });
    await writeFile(join(handlePath, METADATA_FILE), `${JSON.stringify(metadata)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    await rm(handlePath, { recursive: true, force: true });
    throw error;
  }
  return {
    status: 'complete',
    installation: installation.identity,
    handle: { path: handlePath, marker },
  };
}

async function capture(options) {
  if (options.installations === undefined) {
    return { version: VERSION, operation: 'capture', ...await captureSelected(await selectInstallation(options)) };
  }
  const requests = stableInstallations(parseBatchInput(options.installations, ['name', 'source', 'path'], { scope: options.scope }));
  const prepared = await prepareBatchIdentities(requests);
  let entries;
  try {
    entries = await runList(options.scope);
  } catch (error) {
    return { version: VERSION, operation: 'capture', status: 'failed', scope: options.scope, results: prepared.map((item) => ({ ...(item.installation ? { installation: item.installation } : { request: item.request }), status: 'failed', error: machineError(item.error ?? error) })) };
  }
  const results = [];
  for (const item of prepared) {
    try {
      if (item.error) throw item.error;
      results.push(await captureSelected(await selectInstallationFromEntries(item.installation, entries)));
    } catch (error) {
      results.push({ ...(item.installation ? { installation: item.installation } : { request: item.request }), status: 'failed', error: machineError(error) });
    }
  }
  const successes = results.filter(({ status }) => status === 'complete').length;
  return { version: VERSION, operation: 'capture', status: successes === results.length ? 'complete' : successes === 0 ? 'failed' : 'partial', scope: options.scope, results };
}

function sameIdentity(left, right) {
  return left.name === right.name && left.source === right.source && left.scope === right.scope && left.path === right.path;
}

async function validateHandle(options) {
  const suppliedPath = resolve(options.handle);
  const temporaryRoot = await realpath(tmpdir());
  let stat;
  try {
    stat = await lstat(suppliedPath);
  } catch {
    throw new OperationError('invalid_handle', 'Baseline handle does not exist.');
  }
  if (!stat.isDirectory() || basename(suppliedPath).startsWith(HANDLE_PREFIX) === false) throw new OperationError('invalid_handle', 'Baseline handle is not a valid temporary directory.');
  const canonicalPath = await realpath(suppliedPath);
  if (!canonicalPath.startsWith(`${temporaryRoot}${sep}`)) throw new OperationError('invalid_handle', 'Baseline handle is outside operating-system temporary storage.');
  let metadata;
  try {
    metadata = JSON.parse(await readFile(join(canonicalPath, METADATA_FILE), 'utf8'));
  } catch {
    throw new OperationError('invalid_handle', 'Baseline handle metadata is missing or malformed.');
  }
  const validTimestamp = typeof metadata.createdAt === 'string' && Number.isFinite(Date.parse(metadata.createdAt));
  const validShape = metadata.version === VERSION && typeof metadata.marker === 'string' && /^[a-f0-9]{64}$/.test(metadata.marker)
    && metadata.installation && typeof metadata.workingDirectory === 'string' && validTimestamp;
  if (!validShape) throw new OperationError('invalid_handle', 'Baseline handle metadata is invalid.');
  if (metadata.marker !== options.marker) throw new OperationError('invalid_handle', 'Baseline handle marker does not match.');
  const expected = expectedInstallation(options);
  if (!sameIdentity(metadata.installation, expected) || metadata.workingDirectory !== resolve(process.cwd())) {
    throw new OperationError('handle_identity_mismatch', 'Baseline handle belongs to another Installation or working directory.');
  }
  try {
    if (!(await lstat(join(canonicalPath, BASELINE_DIRECTORY))).isDirectory()) throw new Error('missing');
  } catch {
    throw new OperationError('invalid_handle', 'Baseline handle has no readable baseline.');
  }
  return { path: suppliedPath, canonicalPath, metadata };
}

async function validateSkillIdentity(root, expectedName) {
  let content;
  try {
    const buffer = await readFile(join(root, 'SKILL.md'));
    if (!isUtf8(buffer)) throw new Error('not UTF-8');
    content = buffer.toString('utf8');
  } catch {
    throw new OperationError('invalid_skill', 'The Installation must contain a readable UTF-8 SKILL.md.');
  }
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  const names = frontmatter?.[1].split('\n').flatMap((line) => {
    const match = /^name:\s*(\S.*?)\s*$/.exec(line);
    return match ? [match[1]] : [];
  }) ?? [];
  if (names.length !== 1 || names[0] !== expectedName) throw new OperationError('identity_mismatch', 'SKILL.md no longer matches the expected Skill identity.');
}

function contained(root, path) {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function fileMetadata(path) {
  const stat = await lstat(path);
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const handle = await open(path, 'r');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  let hasBinaryControl = false;
  let validUtf8 = true;
  try {
    while (position < stat.size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - position), position);
      if (bytesRead === 0) break;
      const bytes = chunk.subarray(0, bytesRead);
      hash.update(bytes);
      hasBinaryControl ||= bytes.some((byte) => byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d);
      if (validUtf8) {
        try {
          const decoded = decoder.decode(bytes, { stream: true });
          hasBinaryControl ||= /[\u007f-\u009f]/u.test(decoded);
        } catch {
          validUtf8 = false;
        }
      }
      position += bytesRead;
    }
    if (validUtf8) {
      try {
        decoder.decode();
      } catch {
        validUtf8 = false;
      }
    }
  } finally {
    await handle.close();
  }
  return {
    kind: 'file',
    format: hasBinaryControl ? 'binary' : validUtf8 ? (stat.size > MAX_TEXT_FILE_BYTES ? 'oversized_text' : 'text') : 'invalid_utf8',
    size: stat.size,
    mode: stat.mode,
    sha256: hash.digest('hex'),
    absolutePath: path,
  };
}

function fixedMetadata(kind, absolutePath, mode, detail = '') {
  const content = `${kind}:${mode}:${detail}`;
  return { kind, format: kind, size: Buffer.byteLength(content), mode, sha256: createHash('sha256').update(content).digest('hex'), absolutePath };
}

async function entryMetadata(path, entry) {
  const stat = await lstat(path);
  if (entry.isDirectory()) return fixedMetadata('directory', path, stat.mode);
  if (entry.isFile()) return fileMetadata(path);
  if (entry.isSymbolicLink()) {
    const target = await readlink(path);
    const content = Buffer.from(`symbolic link -> ${target}\n`);
    return { kind: 'symlink', format: 'text', size: content.length, mode: stat.mode, sha256: createHash('sha256').update(content).digest('hex'), absolutePath: path, target };
  }
  return fixedMetadata('special', path, stat.mode, String(stat.size));
}

function sameMetadata(before, after) {
  return before.kind === after.kind && before.size === after.size && before.mode === after.mode && before.sha256 === after.sha256;
}

async function writeAll(handle, buffer, position) {
  let written = 0;
  while (written < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, written, buffer.length - written, position + written);
    if (bytesWritten === 0) throw new OperationError('tree_queue_failed', 'Temporary tree traversal queue could not make progress.');
    written += bytesWritten;
  }
}

async function readAll(handle, buffer, position) {
  let read = 0;
  while (read < buffer.length) {
    const { bytesRead } = await handle.read(buffer, read, buffer.length - read, position + read);
    if (bytesRead === 0) throw new OperationError('tree_queue_failed', 'Temporary tree traversal queue ended unexpectedly.');
    read += bytesRead;
  }
}

async function* walkTree(root) {
  const work = await mkdtemp(join(tmpdir(), 'skills-manager-tree-'));
  let queue;
  try {
    queue = await open(join(work, 'queue'), 'wx+', 0o600);
    let readPosition = 0;
    let writePosition = 0;
    const enqueue = async (record) => {
      const content = Buffer.from(JSON.stringify(record));
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(content.length);
      await writeAll(queue, header, writePosition);
      await writeAll(queue, content, writePosition + header.length);
      writePosition += header.length + content.length;
    };
    const dequeue = async () => {
      if (readPosition >= writePosition) return null;
      const header = Buffer.allocUnsafe(4);
      await readAll(queue, header, readPosition);
      const content = Buffer.allocUnsafe(header.readUInt32BE());
      await readAll(queue, content, readPosition + header.length);
      readPosition += header.length + content.length;
      return JSON.parse(content.toString('utf8'));
    };
    await enqueue({ absolutePath: root, prefix: '' });
    let pending;
    while ((pending = await dequeue()) !== null) {
      const directory = await opendir(pending.absolutePath);
      for await (const entry of directory) {
        const absolutePath = join(pending.absolutePath, entry.name);
        const name = pending.prefix ? `${pending.prefix}/${entry.name}` : entry.name;
        yield { path: name, absolutePath, entry };
        if (entry.isDirectory()) await enqueue({ absolutePath, prefix: name });
      }
    }
  } finally {
    await queue?.close();
    await rm(work, { recursive: true, force: true });
  }
}

async function statOrAbsent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

async function* changedEntriesBetween(beforeRoot, afterRoot) {
  for await (const item of walkTree(beforeRoot)) {
    const afterPath = join(afterRoot, ...item.path.split('/'));
    const afterStat = await statOrAbsent(afterPath);
    const before = await entryMetadata(item.absolutePath, item.entry);
    if (!afterStat) {
      yield { path: item.path, before };
      continue;
    }
    const after = await entryMetadata(afterPath, afterStat);
    if (!sameMetadata(before, after)) yield { path: item.path, before, after };
  }
  for await (const item of walkTree(afterRoot)) {
    const beforePath = join(beforeRoot, ...item.path.split('/'));
    if (await statOrAbsent(beforePath)) continue;
    yield { path: item.path, after: await entryMetadata(item.absolutePath, item.entry) };
  }
}

async function entryContent(entry) {
  if (!entry) return undefined;
  if (entry.kind === 'symlink') return Buffer.from(`symbolic link -> ${entry.target}\n`);
  return readFile(entry.absolutePath);
}

function textLines(content) {
  if (!content || content.length === 0) return [];
  const text = content.toString('utf8');
  const endsWithNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (endsWithNewline) lines.pop();
  return lines.map((line, index) => ({ text: line, terminated: index < lines.length - 1 || endsWithNewline }));
}

function exceedsLineBudget(content) {
  if (!content?.length) return false;
  let lines = content.at(-1) === 0x0a ? 0 : 1;
  for (const byte of content) {
    if (byte === 0x0a && ++lines > MAX_DIFF_LINES) return true;
  }
  return lines > MAX_DIFF_LINES;
}

function sameLine(left, right) {
  return left.text === right.text && left.terminated === right.terminated;
}

function lineOperations(before, after) {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && sameLine(before[prefix], after[prefix])) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && sameLine(before[before.length - 1 - suffix], after[after.length - 1 - suffix])) suffix += 1;
  const operations = before.slice(0, prefix).map((line) => ({ type: ' ', line }));
  const left = before.slice(prefix, before.length - suffix);
  const right = after.slice(prefix, after.length - suffix);
  const trace = [];
  let frontier = new Map([[1, 0]]);
  let completed = false;
  const maximumEditDistance = Math.min(left.length + right.length, 1024);
  for (let distance = 0; distance <= maximumEditDistance; distance += 1) {
    const next = new Map();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
      const rightward = (frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY) + 1;
      let x = diagonal === -distance || (diagonal !== distance && rightward < down) ? down : rightward;
      if (!Number.isFinite(x)) x = 0;
      let y = x - diagonal;
      while (x < left.length && y < right.length && sameLine(left[x], right[y])) {
        x += 1;
        y += 1;
      }
      next.set(diagonal, x);
      if (x >= left.length && y >= right.length) completed = true;
    }
    trace.push(next);
    frontier = next;
    if (completed) break;
  }
  if (completed) {
    const reversed = [];
    let x = left.length;
    let y = right.length;
    for (let distance = trace.length - 1; distance > 0; distance -= 1) {
      const previous = trace[distance - 1];
      const diagonal = x - y;
      const down = previous.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
      const rightward = previous.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
      const previousDiagonal = diagonal === -distance || (diagonal !== distance && rightward < down) ? diagonal + 1 : diagonal - 1;
      const previousX = previous.get(previousDiagonal) ?? 0;
      const previousY = previousX - previousDiagonal;
      while (x > previousX && y > previousY) {
        reversed.push({ type: ' ', line: left[x - 1] });
        x -= 1;
        y -= 1;
      }
      if (x === previousX) {
        reversed.push({ type: '+', line: right[y - 1] });
        y -= 1;
      } else {
        reversed.push({ type: '-', line: left[x - 1] });
        x -= 1;
      }
    }
    while (x > 0 && y > 0) {
      reversed.push({ type: ' ', line: left[x - 1] });
      x -= 1;
      y -= 1;
    }
    while (x > 0) reversed.push({ type: '-', line: left[--x] });
    while (y > 0) reversed.push({ type: '+', line: right[--y] });
    for (const operation of reversed.reverse()) operations.push(operation);
  } else {
    return null;
  }
  for (const line of before.slice(before.length - suffix)) operations.push({ type: ' ', line });
  return operations;
}

function unifiedHunks(before, after) {
  let oldPosition = 1;
  let newPosition = 1;
  const operations = lineOperations(before, after);
  if (!operations) return null;
  const records = operations.map((operation) => {
    const record = { ...operation, oldPosition, newPosition };
    if (operation.type !== '+') oldPosition += 1;
    if (operation.type !== '-') newPosition += 1;
    return record;
  });
  const changes = records.flatMap((record, index) => record.type === ' ' ? [] : [index]);
  const ranges = [];
  for (const index of changes) {
    const next = { start: Math.max(0, index - 3), end: Math.min(records.length, index + 4) };
    const previous = ranges.at(-1);
    if (previous && next.start <= previous.end) previous.end = Math.max(previous.end, next.end);
    else ranges.push(next);
  }
  return ranges.map(({ start, end }) => {
    const hunk = records.slice(start, end);
    const oldCount = hunk.filter(({ type }) => type !== '+').length;
    const newCount = hunk.filter(({ type }) => type !== '-').length;
    const oldRecord = hunk.find(({ type }) => type !== '+');
    const newRecord = hunk.find(({ type }) => type !== '-');
    const oldStart = oldRecord?.oldPosition ?? Math.max(0, hunk[0].oldPosition - 1);
    const newStart = newRecord?.newPosition ?? Math.max(0, hunk[0].newPosition - 1);
    const lines = [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`];
    for (const record of hunk) {
      lines.push(`${record.type}${record.line.text}`);
      if (!record.line.terminated) lines.push('\\ No newline at end of file');
    }
    return `${lines.join('\n')}\n`;
  }).join('');
}

function diffLabel(label) {
  return /[\s"\\\u0000-\u001f\u007f-\u009f]/u.test(label) ? JSON.stringify(label) : label;
}

function filePatch(path, beforeEntry, afterEntry, beforeContent, afterContent, labels = { before: 'baseline', after: 'installation' }) {
  const beforeLabel = beforeEntry ? diffLabel(`${labels.before}/${path}`) : '/dev/null';
  const afterLabel = afterEntry ? diffLabel(`${labels.after}/${path}`) : '/dev/null';
  if (beforeEntry?.sha256 !== afterEntry?.sha256 && (exceedsLineBudget(beforeContent) || exceedsLineBudget(afterContent))) return null;
  const hunks = beforeEntry?.sha256 === afterEntry?.sha256 ? '' : unifiedHunks(textLines(beforeContent), textLines(afterContent));
  if (hunks === null) return null;
  const modeChanges = beforeEntry && afterEntry && beforeEntry.mode !== afterEntry.mode
    ? [`old mode ${beforeEntry.mode.toString(8)}`, `new mode ${afterEntry.mode.toString(8)}`]
    : [];
  return [
    `diff -- ${beforeLabel} ${afterLabel}`,
    ...modeChanges,
    `--- ${beforeLabel}`,
    `+++ ${afterLabel}`,
    hunks.endsWith('\n') ? hunks.slice(0, -1) : hunks,
    '',
  ].join('\n');
}

function publicMetadata(entry) {
  return entry ? { size: entry.size, mode: entry.mode, sha256: entry.sha256 } : null;
}

function summaryKind(before, after) {
  const formats = [before?.format, after?.format];
  if (formats.includes('oversized_text')) return 'oversized_text';
  if (formats.includes('binary')) return 'binary';
  if (formats.includes('invalid_utf8')) return 'invalid_utf8';
  if (formats.includes('directory')) return 'directory';
  if (formats.includes('special')) return 'special';
  return 'patch_limit';
}

async function validateChangedSymlink(root, entry) {
  const candidate = resolve(dirname(entry.absolutePath), entry.target);
  if (!contained(root, candidate)) throw new OperationError('escaping_symlink', `Changed symbolic link ${relative(root, entry.absolutePath)} escapes the Installation.`);
  let probe = candidate;
  while (contained(root, probe)) {
    try {
      if (!contained(root, await realpath(probe))) throw new OperationError('escaping_symlink', `Changed symbolic link ${relative(root, entry.absolutePath)} escapes the Installation.`);
      return;
    } catch (error) {
      if (error instanceof OperationError) throw error;
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  throw new OperationError('escaping_symlink', `Changed symbolic link ${relative(root, entry.absolutePath)} escapes the Installation.`);
}

async function evidenceBetween(beforeRoot, afterRoot, labels = { before: 'baseline', after: 'installation' }, patchBudget = { remaining: patchLimitBytes() }, metadataBudget = { remaining: evidenceLimitBytes() }) {
  const changedPaths = [];
  const changes = [];
  let metadataBytes = 0;
  let patchBytesRemaining = patchBudget.remaining;
  for await (const change of changedEntriesBetween(beforeRoot, afterRoot)) {
    metadataBytes += Buffer.byteLength(JSON.stringify(change.path)) * 3
      + Buffer.byteLength(JSON.stringify({ before: publicMetadata(change.before), after: publicMetadata(change.after) })) + 256;
    if (metadataBytes > metadataBudget.remaining) throw new OperationError('evidence_output_overflow', 'Changed-path evidence exceeds the bounded output budget. Targeted inspection is required before this workflow can complete.');
    changes.push(change);
  }
  changes.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const summaries = [];
  const targetedReviewPaths = [];
  const patches = [];
  const patchedPaths = new Set();
  for (const { path, before: left, after: right } of changes) {
    changedPaths.push(path);
    if (right?.kind === 'symlink') await validateChangedSymlink(afterRoot, right);
    const patchable = (!left || left.format === 'text') && (!right || right.format === 'text');
    if (patchable) {
      const patch = filePatch(path, left, right, await entryContent(left), await entryContent(right), labels);
      const bytes = patch === null ? Number.POSITIVE_INFINITY : Buffer.byteLength(patch);
      if (patch !== null && bytes <= patchBytesRemaining) {
        patches.push(patch);
        patchedPaths.add(path);
        patchBytesRemaining -= bytes;
        continue;
      }
    }
    const kind = summaryKind(left, right);
    summaries.push({ path, kind, before: publicMetadata(left), after: publicMetadata(right) });
    if (kind === 'oversized_text' || kind === 'patch_limit') targetedReviewPaths.push(path);
  }
  const accounted = new Set([...summaries.map(({ path }) => path), ...patchedPaths]);
  if (accounted.size !== changedPaths.length) throw new OperationError('path_accounting_failed', 'Intent application review did not account for every changed path.');
  patchBudget.remaining = patchBytesRemaining;
  metadataBudget.remaining -= metadataBytes;
  return { changedPaths, patch: patches.join(''), summaries, targetedReviewPaths };
}

async function verifyFulfillmentGroup(requests, patchBudget, metadataBudget) {
  const source = requests[0].installation.source;
  const names = [...new Set(requests.map(({ installation }) => installation.name))].sort();
  const work = await mkdtemp(join(tmpdir(), 'skills-manager-fulfillment-'));
  try {
    const acquired = await runSkillsCommand(['add', source, ...names.flatMap((name) => ['--skill', name]), '--agent', 'universal', '--copy', '--yes'], work);
    if (acquired.exitCode !== 0) throw new OperationError('clean_acquisition_failed', `Clean upstream acquisition failed${acquired.stderr.trim() ? `: ${acquired.stderr.trim()}` : '.'}`);
    const listed = await runList('project', work);
    const workRoot = await realpath(work);
    const results = [];
    for (const request of requests) {
      const { installation, installedRoot } = request;
      try {
        const candidates = listed.filter((entry) => entry.name === installation.name);
        if (candidates.length !== 1) throw new OperationError('clean_acquisition_failed', `Clean acquisition did not expose exactly one selected Skill named ${installation.name}.`);
        if (publicSource(candidates[0]) !== installation.source) throw new OperationError('clean_source_mismatch', 'Clean acquisition returned a different source identity.');
        const cleanRoot = await resolveDirectory(resolve(candidates[0].path), 'clean_acquisition_failed', 'Clean acquisition path is not an accessible directory.');
        if (!contained(workRoot, cleanRoot)) throw new OperationError('clean_acquisition_failed', 'Clean acquisition path escaped temporary storage.');
        const evidence = await evidenceBetween(cleanRoot, installedRoot, { before: 'clean-upstream', after: 'installation' }, patchBudget, metadataBudget);
        results.push({ status: evidence.targetedReviewPaths.length ? 'targeted_review_required' : 'verification_ready', installation, ...evidence });
      } catch (error) {
        results.push({ status: 'warning', installation, intent: 'retained', error: machineError(error) });
      }
    }
    return results;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function verifyFulfillment(options) {
  if (options.installations === undefined) {
    const installation = expectedInstallation(options);
    const installedRoot = await resolveDirectory(installation.path, 'installation_unavailable', 'The expected installed path is not an accessible directory.');
    const [result] = await verifyFulfillmentGroup([{ installation, installedRoot }], { remaining: patchLimitBytes() }, { remaining: evidenceLimitBytes() });
    if (result.status === 'warning') throw new OperationError(result.error.code, result.error.message);
    return { version: VERSION, operation: 'verify-fulfillment', ...result };
  }
  const requests = stableInstallations(parseBatchInput(options.installations, INSTALLATION_OPTIONS));
  const prepared = await prepareBatchIdentities(requests);
  const ready = [];
  const results = [];
  for (const item of prepared) {
    try {
      if (item.error) throw item.error;
      ready.push({ installation: item.installation, installedRoot: await resolveDirectory(item.installation.path, 'installation_unavailable', 'The expected installed path is not an accessible directory.') });
    } catch (error) {
      results.push({ status: 'warning', ...(item.installation ? { installation: item.installation } : { request: item.request }), intent: 'retained', error: machineError(error) });
    }
  }
  const groups = Map.groupBy(ready, ({ installation }) => installation.source);
  const patchBudget = { remaining: patchLimitBytes() };
  const metadataBudget = { remaining: evidenceLimitBytes() };
  for (const requests of groups.values()) {
    try {
      results.push(...await verifyFulfillmentGroup(requests, patchBudget, metadataBudget));
    } catch (error) {
      results.push(...requests.map(({ installation }) => ({ status: 'warning', installation, intent: 'retained', error: machineError(error) })));
    }
  }
  results.sort((left, right) => compareInstallations(left.installation ?? left.request, right.installation ?? right.request));
  const warnings = results.filter(({ status }) => status === 'warning').length;
  const complete = results.filter(({ status }) => status === 'verification_ready').length;
  return { version: VERSION, operation: 'verify-fulfillment', status: warnings === results.length ? 'failed' : complete === results.length ? 'complete' : 'partial', results };
}

async function review(options) {
  const handle = await validateHandle(options);
  const installationRoot = await resolveDirectory(resolve(handle.metadata.installation.path), 'installation_unavailable', 'The Installation no longer exists.');
  await validateSkillIdentity(installationRoot, handle.metadata.installation.name);
  const evidence = await evidenceBetween(join(handle.canonicalPath, BASELINE_DIRECTORY), installationRoot);
  return {
    version: VERSION,
    operation: 'review',
    status: evidence.changedPaths.length === 0 ? 'no_application_change' : evidence.targetedReviewPaths.length ? 'targeted_review_required' : 'review_required',
    installation: handle.metadata.installation,
    ...evidence,
  };
}

async function close(options) {
  const handle = await validateHandle(options);
  await rm(handle.path, { recursive: true });
  return { version: VERSION, operation: 'close', status: 'complete', installation: handle.metadata.installation, outcome: options.outcome };
}

let operation = process.argv[2] ?? 'unknown';
let parsed;
try {
  parsed = parseArguments(process.argv.slice(2));
  operation = parsed.operation;
  const handlers = { preflight, capture, review, close, 'verify-fulfillment': verifyFulfillment };
  const result = await handlers[parsed.operation](parsed.options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
} catch (error) {
  const result = {
    version: VERSION,
    operation,
    status: 'failed',
    ...(parsed?.options.source && parsed?.options.path ? { installation: expectedInstallation(parsed.options) } : {}),
    error: { code: error instanceof OperationError ? error.code : 'internal_error', message: error instanceof Error ? error.message : String(error) },
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = error instanceof OperationError ? error.exitCode : 1;
}
