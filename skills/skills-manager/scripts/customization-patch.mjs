#!/usr/bin/env node

import { lstat, mkdtemp, readFile, readdir, readlink, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

class UserError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseArguments(argv) {
  const [name, ...rest] = argv;
  if (!name || name.startsWith('-')) throw new UserError('Usage: customization-patch <skill-name> [--scope project|global]', 2);
  let scope;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] !== '--scope' || !['project', 'global'].includes(rest[index + 1])) {
      throw new UserError('Usage: customization-patch <skill-name> [--scope project|global]', 2);
    }
    scope = rest[index + 1];
    index += 1;
  }
  return { name, scope };
}

async function command(args, options = {}) {
  const child = spawn('npx', ['skills', ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  return { exitCode, stdout, stderr };
}

function validateEntry(value, expectedScope) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UserError('Public list output contains a malformed Installation entry.');
  for (const field of ['name', 'path', 'scope']) {
    if (typeof value[field] !== 'string' || value[field].length === 0) throw new UserError(`Public list output has a missing, null, or malformed required field: ${field}.`);
  }
  if (!Array.isArray(value.agents) || value.agents.some((agent) => typeof agent !== 'string')) throw new UserError('Public list output has a missing, null, or malformed required field: agents.');
  if (value.scope !== expectedScope) throw new UserError(`Public list output returned scope ${JSON.stringify(value.scope)} while listing ${expectedScope} Installations.`);
  return value;
}

async function list(scope, cwd = process.cwd()) {
  const result = await command(['list', '--json', ...(scope === 'global' ? ['--global'] : [])], { cwd });
  if (result.exitCode !== 0) throw new UserError(`Public upstream list failed for ${scope} scope${result.stderr ? `: ${result.stderr.trim()}` : '.'}`);
  let values;
  try {
    values = JSON.parse(result.stdout);
  } catch {
    throw new UserError(`Public upstream list returned malformed JSON for ${scope} scope.`);
  }
  if (!Array.isArray(values)) throw new UserError(`Public upstream list returned a non-array value for ${scope} scope.`);
  return values.map((value) => validateEntry(value, scope));
}

function normalizeSource(source) {
  let normalized = source.trim().replace(/\\/g, '/').replace(/\/$/, '').replace(/\.git$/, '');
  normalized = normalized.replace(/^git\+/, '').replace(/^git@github\.com:/, 'https://github.com/');
  normalized = normalized.replace(/^https?:\/\/(?:www\.)?github\.com\//, '');
  return normalized.toLowerCase();
}

function intentDirectory(scope) {
  if (scope === 'project') return join(process.cwd(), '.skills-manager', 'intents');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'skills-manager', 'intents');
}

function parseIntentDocument(content, path) {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  if (!match) throw new UserError(`Intent document ${path} has malformed frontmatter.`);
  const metadata = {};
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 1) throw new UserError(`Intent document ${path} has malformed frontmatter.`);
    metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  for (const field of ['source', 'skill', 'scope']) {
    if (!metadata[field]) throw new UserError(`Intent document ${path} is missing identity field ${field}.`);
  }
  for (const field of Object.keys(metadata)) {
    if (!['source', 'skill', 'scope'].includes(field)) throw new UserError(`Intent document ${path} contains unsupported identity field ${field}.`);
  }
  const body = content.slice(match[0].length).trim();
  if (!body.startsWith('# Active Intents') || !/(?:^|\n)-\s+\S/.test(body)) {
    throw new UserError(`Intent document ${path} contains no active Intent; remove the empty document.`);
  }
  return metadata;
}

async function intentFor(installation) {
  const directory = intentDirectory(installation.scope);
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const documents = [];
  for (const name of names.filter((entry) => entry.endsWith('.md')).sort()) {
    const path = join(directory, name);
    const content = await readFile(path, 'utf8');
    const metadata = parseIntentDocument(content, path);
    if (metadata.skill === installation.name && metadata.scope === installation.scope) documents.push({ path, content, metadata });
  }
  if (documents.length > 1) throw new UserError(`Multiple Intent documents claim ${installation.scope} Installation ${installation.name}; resolve the duplicate identity before continuing.`);
  const document = documents[0];
  if (!document) return null;
  const rawInstalledSource = installation.sourceUrl || installation.source;
  if (typeof rawInstalledSource === 'string' && normalizeSource(document.metadata.source) !== normalizeSource(rawInstalledSource)) {
    throw new UserError(`Intent document ${document.path} belongs to a different Skill identity. Present explicit migration choices to the user; do not reuse it automatically.`);
  }
  return document;
}

function validateUpstreamIdentity(installation) {
  if (installation.sourceType === 'local') throw new UserError('Local Skills do not have a tracked upstream baseline; clean-upstream comparison is unsupported.');
  const source = installation.sourceUrl || installation.source;
  if (typeof source !== 'string' || source.length === 0 || typeof installation.sourceType !== 'string') {
    throw new UserError('Installation has missing or malformed public source metadata; clean-upstream comparison is unsupported.');
  }
  return source;
}

async function selectInstallation(name, suppliedScope) {
  const [project, global] = await Promise.all([list('project'), list('global')]);
  const matches = [...project, ...global].filter((entry) => entry.name === name);
  const identities = new Set(matches.map((entry) => `${entry.scope}:${entry.path}`));
  if (identities.size !== matches.length) throw new UserError(`Public upstream list returned a duplicate Installation for ${name}.`);
  if (matches.length === 0) throw new UserError(`Skill ${name} is not installed in project or global scope.`);
  const scopes = new Set(matches.map((entry) => entry.scope));
  if (matches.length > 2 || matches.some((entry, index) => matches.findIndex((other) => other.scope === entry.scope) !== index)) {
    throw new UserError(`Public upstream list returned duplicate ${name} entries in one scope.`);
  }
  if (scopes.size === 2) {
    if (!suppliedScope) throw new UserError(`${name} is installed in both project and global scope. Ask the user which Installation they mean, then rerun with --scope project|global.`, 2);
    return matches.find((entry) => entry.scope === suppliedScope);
  }
  if (suppliedScope) throw new UserError('--scope is accepted only to resolve an observed project/global ambiguity.', 2);
  return matches[0];
}

async function regularFiles(root) {
  const files = new Map();
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join('/');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.set(name, await readFile(path));
      else if (entry.isSymbolicLink()) files.set(name, Buffer.from(`symbolic link -> ${await readlink(path)}\n`));
    }
  }
  await visit(root);
  return files;
}

function textual(buffer) {
  return !buffer.includes(0);
}

function linePatch(path, clean, installed) {
  const cleanLabel = clean ? `clean/${path}` : '/dev/null';
  const installedLabel = installed ? `installed/${path}` : '/dev/null';
  if ((clean && !textual(clean)) || (installed && !textual(installed))) return `Binary files ${cleanLabel} and ${installedLabel} differ\n`;
  const beforeText = clean?.toString('utf8');
  const afterText = installed?.toString('utf8');
  const before = beforeText === undefined ? [] : beforeText.split('\n').slice(0, beforeText.endsWith('\n') ? -1 : undefined);
  const after = afterText === undefined ? [] : afterText.split('\n').slice(0, afterText.endsWith('\n') ? -1 : undefined);
  return [
    `diff -- ${cleanLabel} ${installedLabel}`,
    `--- ${cleanLabel}`,
    `+++ ${installedLabel}`,
    '@@',
    ...before.map((line) => `-${line}`),
    ...after.map((line) => `+${line}`),
    '',
  ].join('\n');
}

async function comparison(cleanRoot, installedRoot) {
  const [clean, installed] = await Promise.all([regularFiles(cleanRoot), regularFiles(installedRoot)]);
  const names = [...new Set([...clean.keys(), ...installed.keys()])].sort();
  return names.flatMap((name) => {
    const before = clean.get(name);
    const after = installed.get(name);
    return before && after && before.equals(after) ? [] : [linePatch(name, before, after)];
  }).join('');
}

async function acquireClean(installation, source) {
  const work = await mkdtemp(join(tmpdir(), 'skills-manager-customization-'));
  try {
    const acquired = await command(['add', source, '--skill', installation.name, '--agent', 'universal', '--copy', '--yes'], { cwd: work });
    if (acquired.exitCode !== 0) throw new UserError(`Clean upstream acquisition failed${acquired.stderr ? `: ${acquired.stderr.trim()}` : '.'}`);
    const candidates = (await list('project', work)).filter((entry) => entry.name === installation.name);
    if (candidates.length !== 1) throw new UserError(`Clean upstream acquisition did not expose exactly one selected Skill named ${installation.name} through public list output.`);
    const candidateSource = validateUpstreamIdentity(candidates[0]);
    if (normalizeSource(candidateSource) !== normalizeSource(source)) throw new UserError('Clean upstream acquisition returned a different source identity through public list output.');
    const root = await realpath(resolve(candidates[0].path));
    const workRoot = await realpath(work);
    if (!(root === workRoot || root.startsWith(`${workRoot}${sep}`))) throw new UserError('Clean upstream candidate path escaped temporary storage.');
    await lstat(root);
    return { work, root };
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
}

async function installedDirectory(path) {
  try {
    const root = await realpath(resolve(path));
    if (!(await lstat(root)).isDirectory()) throw new UserError(`Public installed path ${path} is not a directory.`);
    return root;
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(`Public installed path ${path} does not resolve to an accessible Installation directory.`);
  }
}

async function main() {
  const { name, scope } = parseArguments(process.argv.slice(2));
  const installation = await selectInstallation(name, scope);
  const installedRoot = await installedDirectory(installation.path);
  const intent = await intentFor(installation);
  if (!intent) {
    console.log(`No Intent document exists for ${installation.scope} Installation ${name}. Do not acquire or generate a Customization patch; after a successful upstream Update, the semantic branch is complete.`);
    return;
  }
  const source = validateUpstreamIdentity(installation);
  const { work, root } = await acquireClean(installation, source);
  try {
    const patch = await comparison(root, installedRoot);
    if (!patch) {
      console.log(`Active Intents exist, but the Customization patch is empty. Determine whether clean upstream fulfills every Intent or Intent application is incomplete; do not decide automatically.`);
      return;
    }
    console.log('Customization patch (best-effort baseline):');
    console.log(patch);
    console.log('Translate this raw patch into ephemeral natural-language Customization evidence for the current conversation. Verify every observed change corresponds to an active Intent and surface unrelated changes. The baseline may differ from the exact installed upstream revision.');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof UserError ? error.exitCode : 1;
}
