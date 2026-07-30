#!/usr/bin/env node

import { isUtf8 } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, lstat, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

const VERSION = 1;
const HANDLE_PREFIX = 'skills-manager-intent-application-';
const METADATA_FILE = 'handle.json';
const BASELINE_DIRECTORY = 'baseline';

class OperationError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function parseArguments(argv) {
  const [operation, ...rest] = argv;
  if (!['capture', 'review', 'close'].includes(operation)) {
    throw new OperationError('invalid_arguments', 'Usage: intent-application capture|review|close [options]', 2);
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
  for (const key of ['name', 'source', 'scope', 'path']) {
    if (!options[key]?.trim()) throw new OperationError('invalid_arguments', `Missing required option --${key}.`, 2);
  }
  if (!['project', 'global'].includes(options.scope)) throw new OperationError('invalid_arguments', '--scope must be project or global.', 2);
  if (operation !== 'capture') {
    for (const key of ['handle', 'marker']) if (!options[key]?.trim()) throw new OperationError('invalid_arguments', `Missing required option --${key}.`, 2);
  }
  if (operation === 'close' && !['complete', 'conflict', 'cancelled'].includes(options.outcome)) {
    throw new OperationError('invalid_arguments', '--outcome must be complete, conflict, or cancelled.', 2);
  }
  const allowed = new Set(['name', 'source', 'scope', 'path', ...(operation === 'capture' ? [] : ['handle', 'marker']), ...(operation === 'close' ? ['outcome'] : [])]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new OperationError('invalid_arguments', `Unsupported option --${key}.`, 2);
  return { operation, options };
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
  return normalizeSource(source);
}

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new OperationError('malformed_listing', 'Public list output contains a malformed Installation.');
  for (const field of ['name', 'path', 'scope']) {
    if (typeof entry[field] !== 'string' || !entry[field].trim()) throw new OperationError('malformed_listing', `Installation field ${field} is missing or malformed.`);
  }
  if (!Array.isArray(entry.agents) || entry.agents.length === 0 || entry.agents.some((agent) => typeof agent !== 'string' || !agent.trim())) {
    throw new OperationError('malformed_listing', 'Installation field agents is missing or malformed.');
  }
  return entry;
}

async function runList(scope) {
  const args = ['skills', 'list', '--json', ...(scope === 'global' ? ['--global'] : [])];
  const child = spawn('npx', args, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exitCode = await new Promise((done, reject) => {
    child.on('error', reject);
    child.on('close', done);
  });
  if (exitCode !== 0) throw new OperationError('listing_failed', `Public ${scope} Installation listing failed${stderr.trim() ? `: ${stderr.trim()}` : '.'}`);
  let entries;
  try {
    entries = JSON.parse(stdout);
  } catch {
    throw new OperationError('malformed_listing', `Public ${scope} Installation listing returned malformed JSON.`);
  }
  if (!Array.isArray(entries)) throw new OperationError('malformed_listing', `Public ${scope} Installation listing did not return an array.`);
  return entries.map(validateEntry);
}

function expectedInstallation(options) {
  return { name: options.name, source: normalizeSource(options.source), scope: options.scope, path: resolve(options.path) };
}

async function selectInstallation(options) {
  const expected = expectedInstallation(options);
  const entries = await runList(expected.scope);
  const named = entries.filter((entry) => entry.name === expected.name);
  if (named.length !== 1) throw new OperationError('installation_not_found', `Expected exactly one ${expected.scope} Installation named ${expected.name}.`);
  const entry = named[0];
  const actualPath = resolve(entry.path);
  const mismatches = [];
  if (entry.scope !== expected.scope) mismatches.push('scope');
  if (publicSource(entry) !== expected.source) mismatches.push('source');
  if (actualPath !== expected.path) mismatches.push('path');
  if (mismatches.length) throw new OperationError('identity_mismatch', `Installation ${mismatches.join(', ')} did not match the expected identity.`);
  let installed;
  try {
    installed = await realpath(actualPath);
    if (!(await lstat(installed)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new OperationError('installation_unavailable', 'The expected installed path is not an accessible directory.');
  }
  return { identity: { ...expected, path: actualPath }, installed };
}

async function capture(options) {
  const installation = await selectInstallation(options);
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
    version: VERSION,
    operation: 'capture',
    status: 'complete',
    installation: installation.identity,
    handle: { path: handlePath, marker },
  };
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

async function tree(root) {
  const entries = new Map();
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join('/');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) entries.set(name, { kind: 'file', content: await readFile(path) });
      else if (entry.isSymbolicLink()) entries.set(name, { kind: 'symlink', content: Buffer.from(`symbolic link -> ${await readlink(path)}\n`) });
    }
  }
  await visit(root);
  return entries;
}

function isText(entry) {
  return entry && entry.kind !== 'file' ? true : entry && !entry.content.includes(0) && isUtf8(entry.content);
}

function textLines(entry) {
  if (!entry || entry.content.length === 0) return [];
  const text = entry.content.toString('utf8');
  const endsWithNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (endsWithNewline) lines.pop();
  return lines.map((line, index) => ({ text: line, terminated: index < lines.length - 1 || endsWithNewline }));
}

function sameLine(left, right) {
  return left.text === right.text && left.terminated === right.terminated;
}

function lineOperations(before, after) {
  const rows = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      rows[beforeIndex][afterIndex] = sameLine(before[beforeIndex], after[afterIndex])
        ? rows[beforeIndex + 1][afterIndex + 1] + 1
        : Math.max(rows[beforeIndex + 1][afterIndex], rows[beforeIndex][afterIndex + 1]);
    }
  }
  const operations = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < before.length || afterIndex < after.length) {
    if (beforeIndex < before.length && afterIndex < after.length && sameLine(before[beforeIndex], after[afterIndex])) {
      operations.push({ type: ' ', line: before[beforeIndex] });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (afterIndex >= after.length || (beforeIndex < before.length && rows[beforeIndex + 1][afterIndex] >= rows[beforeIndex][afterIndex + 1])) {
      operations.push({ type: '-', line: before[beforeIndex] });
      beforeIndex += 1;
    } else {
      operations.push({ type: '+', line: after[afterIndex] });
      afterIndex += 1;
    }
  }
  return operations;
}

function unifiedHunks(before, after) {
  let oldPosition = 1;
  let newPosition = 1;
  const records = lineOperations(before, after).map((operation) => {
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

function filePatch(path, before, after) {
  const beforeLabel = before ? `baseline/${path}` : '/dev/null';
  const afterLabel = after ? `installation/${path}` : '/dev/null';
  if ((before && !isText(before)) || (after && !isText(after))) return `Binary files ${beforeLabel} and ${afterLabel} differ\n`;
  const hunks = unifiedHunks(textLines(before), textLines(after));
  return [
    `diff -- ${beforeLabel} ${afterLabel}`,
    `--- ${beforeLabel}`,
    `+++ ${afterLabel}`,
    hunks.endsWith('\n') ? hunks.slice(0, -1) : hunks,
    '',
  ].join('\n');
}

async function review(options) {
  const handle = await validateHandle(options);
  let installationRoot;
  try {
    installationRoot = await realpath(resolve(handle.metadata.installation.path));
    if (!(await lstat(installationRoot)).isDirectory()) throw new Error('missing');
  } catch {
    throw new OperationError('installation_unavailable', 'The Installation no longer exists.');
  }
  const [before, after] = await Promise.all([tree(join(handle.canonicalPath, BASELINE_DIRECTORY)), tree(installationRoot)]);
  const changedPaths = [...new Set([...before.keys(), ...after.keys()])].sort().filter((path) => {
    const left = before.get(path);
    const right = after.get(path);
    return !left || !right || left.kind !== right.kind || !left.content.equals(right.content);
  });
  return {
    version: VERSION,
    operation: 'review',
    status: changedPaths.length === 0 ? 'no_application_change' : 'review_required',
    installation: handle.metadata.installation,
    changedPaths,
    patch: changedPaths.map((path) => filePatch(path, before.get(path), after.get(path))).join(''),
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
  const result = parsed.operation === 'capture' ? await capture(parsed.options) : parsed.operation === 'review' ? await review(parsed.options) : await close(parsed.options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const result = {
    version: VERSION,
    operation,
    status: 'failed',
    ...(parsed ? { installation: expectedInstallation(parsed.options) } : {}),
    error: { code: error instanceof OperationError ? error.code : 'internal_error', message: error instanceof Error ? error.message : String(error) },
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = error instanceof OperationError ? error.exitCode : 1;
}
