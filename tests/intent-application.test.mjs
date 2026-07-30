import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const helper = resolve('skills/skills-manager/scripts/intent-application.mjs');

async function temp(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function installation(name, path, scope = 'project', source = 'acme/skills') {
  return { name, path, scope, agents: ['Codex'], source, sourceUrl: `https://github.com/${source}.git`, sourceType: 'github' };
}

async function fakeNpx(root) {
  const executable = join(root, 'npx');
  const calls = join(root, 'calls.jsonl');
  await mkdir(root, { recursive: true });
  await writeFile(executable, `#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
await appendFile(process.env.FAKE_CALLS, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
const args = process.argv.slice(2);
if (args[0] !== 'skills' || args[1] !== 'list') process.exit(91);
const global = args.includes('--global');
const payload = global ? (process.env.FAKE_GLOBAL_LIST || '[]') : (process.env.FAKE_PROJECT_LIST || '[]');
process.stdout.write(payload);
`);
  await chmod(executable, 0o755);
  return { executable, calls };
}

async function run(args, { cwd, fake, env = {} }) {
  const child = spawn(process.execPath, [helper, ...args], {
    cwd,
    env: { ...process.env, PATH: `${dirname(fake.executable)}:${process.env.PATH}`, FAKE_CALLS: fake.calls, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exitCode = await new Promise((done) => child.on('close', done));
  return { exitCode, stdout, stderr, json: stdout ? JSON.parse(stdout) : null };
}

function identityArgs({ name = 'alpha', source = 'acme/skills', scope = 'project', path }) {
  return ['--name', name, '--source', source, '--scope', scope, '--path', path];
}

function handleArgs(capture) {
  return ['--handle', capture.json.handle.path, '--marker', capture.json.handle.marker];
}

async function captureFixture(scope = 'project') {
  const root = await temp(`skills-manager-${scope}-capture-`);
  const project = join(root, 'project');
  const installed = join(root, scope === 'project' ? 'project/alpha' : 'home/alpha');
  await mkdir(project, { recursive: true });
  await write(join(installed, 'SKILL.md'), '---\nname: alpha\n---\n\nOriginal.\n');
  const fake = await fakeNpx(join(root, 'fake'));
  const entry = installation('alpha', installed, scope);
  const env = { [scope === 'global' ? 'FAKE_GLOBAL_LIST' : 'FAKE_PROJECT_LIST']: JSON.stringify([entry]) };
  const args = identityArgs({ path: installed, scope });
  const result = await run(['capture', ...args], { cwd: project, fake, env });
  return { root, project, installed, fake, env, args, result };
}

test('project and global capture use one selected-scope listing and return a bound secure Baseline handle', async (t) => {
  for (const scope of ['project', 'global']) await t.test(scope, async () => {
    const fixture = await captureFixture(scope);
    assert.equal(fixture.result.exitCode, 0, fixture.result.stderr);
    assert.deepEqual({ version: fixture.result.json.version, operation: fixture.result.json.operation, status: fixture.result.json.status }, { version: 1, operation: 'capture', status: 'complete' });
    assert.deepEqual(fixture.result.json.installation, { name: 'alpha', source: 'acme/skills', scope, path: resolve(fixture.installed) });
    assert.match(fixture.result.json.handle.path, new RegExp(`^${tmpdir().replaceAll('\\', '\\\\')}`));
    assert.match(fixture.result.json.handle.marker, /^[a-f0-9]{32,}$/);
    const mode = (await lstat(fixture.result.json.handle.path)).mode & 0o777;
    assert.equal(mode & 0o077, 0);
    const calls = (await readFile(fixture.fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map(({ argv }) => argv), [['skills', 'list', '--json', ...(scope === 'global' ? ['--global'] : [])]]);
    await rm(fixture.result.json.handle.path, { recursive: true });
  });
});

test('capture rejects identity, source, scope, and installed-path mismatches without leaving a handle', async (t) => {
  const root = await temp('skills-manager-capture-mismatch-');
  const project = join(root, 'project');
  const installed = join(project, 'alpha');
  await write(join(installed, 'SKILL.md'), '---\nname: alpha\n---\n');
  const fake = await fakeNpx(join(root, 'fake'));
  const base = installation('alpha', installed);
  const cases = [
    ['name', { ...base, name: 'beta' }],
    ['source', { ...base, source: 'other/skills', sourceUrl: 'https://github.com/other/skills.git' }],
    ['scope', { ...base, scope: 'global' }],
    ['path', { ...base, path: join(project, 'other') }],
  ];
  for (const [label, entry] of cases) await t.test(label, async () => {
    const result = await run(['capture', ...identityArgs({ path: installed })], { cwd: project, fake, env: { FAKE_PROJECT_LIST: JSON.stringify([entry]) } });
    assert.equal(result.exitCode, 1);
    assert.equal(result.json.status, 'failed');
    assert.deepEqual(result.json.installation, { name: 'alpha', source: 'acme/skills', scope: 'project', path: resolve(installed) });
    assert.match(result.json.error.code, /identity_mismatch|installation_not_found/);
  });
});

test('review reports attempt-local additions, modifications, and deletions with a complete changed-path list', async () => {
  const fixture = await captureFixture();
  assert.equal(fixture.result.exitCode, 0);
  await write(join(fixture.installed, 'SKILL.md'), '---\nname: alpha\n---\n\nModified.\n');
  await write(join(fixture.installed, 'nested/added.md'), 'Added.\n');
  await write(join(fixture.installed, 'removed.md'), 'Remove me.\n');
  const secondCapture = await run(['capture', ...fixture.args], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  await rm(join(fixture.installed, 'removed.md'));
  await write(join(fixture.installed, 'nested/added.md'), 'Changed after baseline.\n');
  await write(join(fixture.installed, 'created.md'), 'Created after baseline.\n');
  const review = await run(['review', ...fixture.args, ...handleArgs(secondCapture)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  assert.equal(review.exitCode, 0, review.stderr);
  assert.equal(review.json.operation, 'review');
  assert.equal(review.json.status, 'review_required');
  assert.deepEqual(review.json.changedPaths, ['created.md', 'nested/added.md', 'removed.md']);
  assert.match(review.json.patch, /created\.md/);
  assert.match(review.json.patch, /\+Created after baseline\./);
  assert.match(review.json.patch, /nested\/added\.md/);
  assert.match(review.json.patch, /\+Changed after baseline\./);
  assert.match(review.json.patch, /removed\.md/);
  assert.match(review.json.patch, /-Remove me\./);
  await rm(fixture.result.json.handle.path, { recursive: true });
  await rm(secondCapture.json.handle.path, { recursive: true });
});

test('review is repeatable against the same baseline after correcting an unrelated change', async () => {
  const fixture = await captureFixture();
  await rm(fixture.result.json.handle.path, { recursive: true });
  await write(join(fixture.installed, 'SKILL.md'), '---\nname: alpha\n---\n\nline 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\n');
  const capture = await run(['capture', ...fixture.args], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  await write(join(fixture.installed, 'SKILL.md'), '---\nname: alpha\n---\n\nline 1\nline 2\nline 3\nline 4\nline 5\nApproved.\nline 7\nline 8\nline 9\nline 10\n');
  await write(join(fixture.installed, 'unrelated.md'), 'accidental\n');
  const first = await run(['review', ...fixture.args, ...handleArgs(capture)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  assert.deepEqual(first.json.changedPaths, ['SKILL.md', 'unrelated.md']);
  await rm(join(fixture.installed, 'unrelated.md'));
  const second = await run(['review', ...fixture.args, ...handleArgs(capture)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  assert.deepEqual(second.json.changedPaths, ['SKILL.md']);
  assert.equal(second.json.status, 'review_required');
  assert.match(second.json.patch, /@@ -/);
  assert.match(second.json.patch, /\+Approved\./);
  assert.doesNotMatch(second.json.patch, /\+line 1\n/);
  await rm(capture.json.handle.path, { recursive: true });
});

test('review distinguishes no application change from review required', async () => {
  const fixture = await captureFixture();
  const review = await run(['review', ...fixture.args, ...handleArgs(fixture.result)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  assert.equal(review.exitCode, 0, review.stderr);
  assert.equal(review.json.status, 'no_application_change');
  assert.deepEqual(review.json.changedPaths, []);
  assert.equal(review.json.patch, '');
  await rm(fixture.result.json.handle.path, { recursive: true });
});

test('focused unified hunks preserve blank context lines', async () => {
  const fixture = await captureFixture();
  await rm(fixture.result.json.handle.path, { recursive: true });
  await write(join(fixture.installed, 'notes.md'), 'first\nold\n\n');
  const capture = await run(['capture', ...fixture.args], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  await write(join(fixture.installed, 'notes.md'), 'first\nnew\n\n');
  const review = await run(['review', ...fixture.args, ...handleArgs(capture)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  assert.equal(review.exitCode, 0, review.stderr);
  assert.match(review.json.patch, /@@ -1,3 \+1,3 @@\n first\n-old\n\+new\n \n/);
  await rm(capture.json.handle.path, { recursive: true });
});

test('a public installed directory symlink remains reviewable through the captured identity path', async () => {
  const root = await temp('skills-manager-symlinked-installation-');
  const project = join(root, 'project');
  const target = join(project, 'real-alpha');
  const installed = join(project, 'alpha');
  await write(join(target, 'SKILL.md'), '---\nname: alpha\n---\n\nOriginal.\n');
  await symlink(target, installed);
  const fake = await fakeNpx(join(root, 'fake'));
  const env = { FAKE_PROJECT_LIST: JSON.stringify([installation('alpha', installed)]) };
  const args = identityArgs({ path: installed });
  const capture = await run(['capture', ...args], { cwd: project, fake, env });
  assert.equal(capture.exitCode, 0, capture.stderr);
  await write(join(target, 'SKILL.md'), '---\nname: alpha\n---\n\nChanged.\n');
  const review = await run(['review', ...args, ...handleArgs(capture)], { cwd: project, fake, env });
  assert.equal(review.exitCode, 0, review.stderr);
  assert.equal(review.json.status, 'review_required');
  assert.deepEqual(review.json.changedPaths, ['SKILL.md']);
  await rm(capture.json.handle.path, { recursive: true });
});

test('review and close reject handles outside temporary storage, invalid metadata, wrong marker, and another Installation', async (t) => {
  const fixture = await captureFixture();
  const outside = join(fixture.project, 'forged');
  await mkdir(outside, { recursive: true });
  const cases = [
    ['outside temporary storage', ['--handle', outside, '--marker', fixture.result.json.handle.marker], fixture.args],
    ['wrong marker', ['--handle', fixture.result.json.handle.path, '--marker', '0'.repeat(64)], fixture.args],
    ['another Installation', handleArgs(fixture.result), identityArgs({ name: 'beta', path: fixture.installed })],
  ];
  for (const operation of ['review', 'close']) for (const [label, handle, identity] of cases) await t.test(`${operation}: ${label}`, async () => {
    const result = await run([operation, ...identity, ...handle, ...(operation === 'close' ? ['--outcome', 'cancelled'] : [])], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
    assert.equal(result.exitCode, 1);
    assert.equal(result.json.status, 'failed');
    assert.ok(await lstat(fixture.result.json.handle.path));
  });
  const metadataPath = join(fixture.result.json.handle.path, 'handle.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  await writeFile(metadataPath, JSON.stringify({ ...metadata, createdAt: 'not-a-date' }));
  const invalid = await run(['review', ...fixture.args, ...handleArgs(fixture.result)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  assert.equal(invalid.exitCode, 1);
  assert.equal(invalid.json.error.code, 'invalid_handle');
  await rm(fixture.result.json.handle.path, { recursive: true });
});

test('close removes validated temporary state after completion, Conflict, or cancellation', async (t) => {
  for (const outcome of ['complete', 'conflict', 'cancelled']) await t.test(outcome, async () => {
    const fixture = await captureFixture();
    const close = await run(['close', ...fixture.args, ...handleArgs(fixture.result), '--outcome', outcome], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
    assert.equal(close.exitCode, 0, close.stderr);
    assert.deepEqual({ operation: close.json.operation, status: close.json.status, outcome: close.json.outcome }, { operation: 'close', status: 'complete', outcome });
    await assert.rejects(lstat(fixture.result.json.handle.path), { code: 'ENOENT' });
  });
});

test('changed symbolic links are represented in attempt-local evidence', async () => {
  const fixture = await captureFixture();
  await write(join(fixture.installed, 'target-a'), 'a\n');
  await symlink('target-a', join(fixture.installed, 'link'));
  const capture = await run(['capture', ...fixture.args], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  await rm(join(fixture.installed, 'link'));
  await symlink('target-b', join(fixture.installed, 'link'));
  const review = await run(['review', ...fixture.args, ...handleArgs(capture)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  assert.deepEqual(review.json.changedPaths, ['link']);
  assert.match(review.json.patch, /symbolic link -> target-a/);
  assert.match(review.json.patch, /symbolic link -> target-b/);
  await rm(fixture.result.json.handle.path, { recursive: true });
  await rm(capture.json.handle.path, { recursive: true });
});
