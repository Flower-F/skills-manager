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
import { dirname, join } from 'node:path';
await appendFile(process.env.FAKE_CALLS, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
const args = process.argv.slice(2);
if (args[0] !== 'skills') process.exit(91);
if (process.env.FAKE_DESCENDANT_DELAY_MS) {
  const { spawn } = await import('node:child_process');
  const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, Number(process.argv[1]))', process.env.FAKE_DESCENDANT_DELAY_MS], { stdio: ['ignore', 'inherit', 'inherit'] });
  await new Promise((resolve) => descendant.on('close', resolve));
}
if (process.env.FAKE_DELAY_COMMAND === args[1]) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_DELAY_MS || 0)));
if (process.env.FAKE_STDOUT_BYTES) process.stdout.write('o'.repeat(Number(process.env.FAKE_STDOUT_BYTES)));
if (process.env.FAKE_STDERR_BYTES) process.stderr.write('e'.repeat(Number(process.env.FAKE_STDERR_BYTES)));
if (args[1] === 'update') {
  if (process.env.FAKE_UPDATE_FAIL === '1') process.exit(13);
  if (process.env.FAKE_UPDATE_WARNING) process.stderr.write(process.env.FAKE_UPDATE_WARNING);
  process.exit(0);
}
if (args[1] === 'add') {
  if (process.env.FAKE_ADD_FAIL === '1') process.exit(12);
  const skill = args[args.indexOf('--skill') + 1];
  const target = join(process.cwd(), '.agents', 'skills', skill);
  const { mkdir, writeFile } = await import('node:fs/promises');
  for (const [name, content] of Object.entries(JSON.parse(process.env.FAKE_CLEAN_FILES || '{}'))) {
    const path = join(target, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  process.exit(0);
}
if (args[1] !== 'list') process.exit(92);
const global = args.includes('--global');
if ((global && process.env.FAKE_GLOBAL_FAIL === '1') || (!global && process.env.FAKE_PROJECT_FAIL === '1')) process.exit(11);
const temporary = process.cwd().includes('skills-manager-fulfillment-');
const cleanSkill = process.env.FAKE_CLEAN_SKILL || 'alpha';
const cleanSource = process.env.FAKE_CLEAN_SOURCE || 'acme/skills';
const cleanEntry = [{ name: cleanSkill, path: join(process.cwd(), '.agents', 'skills', cleanSkill), scope: 'project', agents: ['Universal'], source: cleanSource, sourceUrl: 'https://github.com/' + cleanSource + '.git', sourceType: 'github' }];
const payload = temporary ? JSON.stringify(cleanEntry) : global ? (process.env.FAKE_GLOBAL_LIST || '[]') : (process.env.FAKE_PROJECT_LIST || '[]');
process.stdout.write((global && process.env.FAKE_GLOBAL_MALFORMED === '1') || (!global && process.env.FAKE_PROJECT_MALFORMED === '1') ? '{' : payload);
`);
  await chmod(executable, 0o755);
  return { executable, calls };
}

test('Update preflight inspects both scopes and returns the exact active Intent state without mutation', async () => {
  const root = await temp('skills-manager-preflight-active-');
  const project = join(root, 'project');
  const installed = join(project, 'alpha');
  await write(join(installed, 'SKILL.md'), '---\nname: alpha\n---\n');
  await write(join(project, '.skills-manager/intents/acme-2Fskills--alpha.md'), '---\nsource: acme/skills\nskill: alpha\nscope: project\n---\n\n# Active Intents\n\n- Preserve one outcome.\n- Preserve another outcome\n  with detail.\n');
  const fake = await fakeNpx(join(root, 'fake'));
  const result = await run(['preflight', '--name', 'alpha'], { cwd: project, fake, env: { FAKE_PROJECT_LIST: JSON.stringify([installation('alpha', installed)]) } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.json.status, 'complete');
  assert.equal(result.json.operation, 'preflight');
  assert.deepEqual(result.json.installation, { name: 'alpha', source: 'acme/skills', scope: 'project', path: resolve(installed), agents: ['Codex'] });
  assert.deepEqual(result.json.intent, { status: 'active', outcomes: ['Preserve one outcome.', 'Preserve another outcome\nwith detail.'] });
  const observed = (await readFile(fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(observed.map(({ argv }) => argv), [['skills', 'list', '--json'], ['skills', 'list', '--json', '--global']]);
});

test('Update preflight returns an absent Intent state and resolves explicit cross-scope selection', async () => {
  const root = await temp('skills-manager-preflight-scope-');
  const project = join(root, 'project');
  const projectInstalled = join(project, 'alpha');
  const globalInstalled = join(root, 'home/alpha');
  await write(join(projectInstalled, 'SKILL.md'), 'project\n');
  await write(join(globalInstalled, 'SKILL.md'), 'global\n');
  const fake = await fakeNpx(join(root, 'fake'));
  const env = {
    XDG_CONFIG_HOME: join(root, 'home/.config'),
    FAKE_PROJECT_LIST: JSON.stringify([installation('alpha', projectInstalled)]),
    FAKE_GLOBAL_LIST: JSON.stringify([installation('alpha', globalInstalled, 'global')]),
  };
  const ambiguous = await run(['preflight', '--name', 'alpha'], { cwd: project, fake, env });
  assert.equal(ambiguous.exitCode, 1);
  assert.equal(ambiguous.json.error.code, 'scope_ambiguous');
  const selected = await run(['preflight', '--name', 'alpha', '--scope', 'global'], { cwd: project, fake, env });
  assert.equal(selected.exitCode, 0, selected.stderr);
  assert.equal(selected.json.installation.scope, 'global');
  assert.deepEqual(selected.json.intent, { status: 'absent', outcomes: [] });
});

test('Update preflight rejects incomplete scope inspection, malformed identity, and malformed matching Intent state', async (t) => {
  const root = await temp('skills-manager-preflight-failure-');
  const project = join(root, 'project');
  const installed = join(project, 'alpha');
  await write(join(installed, 'SKILL.md'), 'installed\n');
  const fake = await fakeNpx(join(root, 'fake'));
  const baseEnv = { FAKE_PROJECT_LIST: JSON.stringify([installation('alpha', installed)]) };
  const cases = [
    ['project list failure', { ...baseEnv, FAKE_PROJECT_FAIL: '1' }, 'listing_failed'],
    ['global list failure', { ...baseEnv, FAKE_GLOBAL_FAIL: '1' }, 'listing_failed'],
    ['malformed project JSON', { ...baseEnv, FAKE_PROJECT_MALFORMED: '1' }, 'malformed_listing'],
    ['malformed required field', { FAKE_PROJECT_LIST: JSON.stringify([{ ...installation('alpha', installed), agents: [] }]) }, 'malformed_listing'],
    ['empty normalized source', { FAKE_PROJECT_LIST: JSON.stringify([{ ...installation('alpha', installed), source: '.git', sourceUrl: '.git' }]) }, 'malformed_listing'],
  ];
  for (const [label, env, code] of cases) await t.test(label, async () => {
    const result = await run(['preflight', '--name', 'alpha'], { cwd: project, fake, env });
    assert.equal(result.exitCode, 1);
    assert.equal(result.json.error.code, code);
  });
  const document = join(project, '.skills-manager/intents/acme-2Fskills--alpha.md');
  const invalidDocuments = [
    ['wrong source', '---\nsource: other/skills\nskill: alpha\nscope: project\n---\n\n# Active Intents\n\n- Outcome.\n'],
    ['wrong skill', '---\nsource: acme/skills\nskill: beta\nscope: project\n---\n\n# Active Intents\n\n- Outcome.\n'],
    ['wrong scope', '---\nsource: acme/skills\nskill: alpha\nscope: global\n---\n\n# Active Intents\n\n- Outcome.\n'],
    ['empty outcomes', '---\nsource: acme/skills\nskill: alpha\nscope: project\n---\n\n# Active Intents\n'],
    ['unsupported shape', '---\nsource: acme/skills\nskill: alpha\nscope: project\nhistory: no\n---\n\n# Active Intents\n\n- Outcome.\n'],
  ];
  for (const [label, content] of invalidDocuments) await t.test(label, async () => {
    await write(document, content);
    const result = await run(['preflight', '--name', 'alpha'], { cwd: project, fake, env: baseEnv });
    assert.equal(result.exitCode, 1);
    assert.match(result.json.error.code, /invalid_intent|intent_identity_mismatch/);
    const observed = (await readFile(fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(observed.some(({ argv }) => ['update', 'add'].includes(argv[1])), false);
  });
});

test('clean upstream is acquired only for explicit upstream-fulfillment verification and temporary content is cleaned', async () => {
  const fixture = await captureFixture();
  const ordinaryCalls = (await readFile(fixture.fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(ordinaryCalls.some(({ argv }) => argv[1] === 'add'), false);
  const verification = await run(['verify-fulfillment', ...fixture.args], { cwd: fixture.project, fake: fixture.fake, env: { ...fixture.env, FAKE_CLEAN_FILES: JSON.stringify({ 'SKILL.md': '---\nname: alpha\n---\n\nClean.\n' }) } });
  assert.equal(verification.exitCode, 0, verification.stderr);
  assert.equal(verification.json.status, 'verification_ready');
  assert.deepEqual(verification.json.changedPaths, ['SKILL.md']);
  assert.match(verification.json.patch, /--- clean-upstream\/SKILL\.md/);
  assert.doesNotMatch(verification.json.patch, /baseline\/SKILL\.md/);
  assert.match(verification.json.patch, /Clean\./);
  const observed = (await readFile(fixture.fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  const add = observed.find(({ argv }) => argv[1] === 'add');
  assert.deepEqual(add.argv, ['skills', 'add', 'acme/skills', '--skill', 'alpha', '--agent', 'universal', '--copy', '--yes']);
  assert.equal(observed.filter(({ argv }) => argv[1] === 'add').length, 1);
  await assert.rejects(lstat(add.cwd), { code: 'ENOENT' });
  await rm(fixture.result.json.handle.path, { recursive: true });
});

test('failed optional upstream-fulfillment verification is bounded to a warning-compatible machine failure and cleans up', async () => {
  const fixture = await captureFixture();
  const verification = await run(['verify-fulfillment', ...fixture.args], { cwd: fixture.project, fake: fixture.fake, env: { ...fixture.env, FAKE_ADD_FAIL: '1' } });
  assert.equal(verification.exitCode, 1);
  assert.equal(verification.json.status, 'failed');
  assert.equal(verification.json.error.code, 'clean_acquisition_failed');
  const observed = (await readFile(fixture.fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  const add = observed.find(({ argv }) => argv[1] === 'add');
  await assert.rejects(lstat(add.cwd), { code: 'ENOENT' });
  await rm(fixture.result.json.handle.path, { recursive: true });
});

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

async function runDirectUpdate(name, scope, { cwd, fake, env = {} }) {
  const child = spawn(fake.executable, ['skills', 'update', name, `--${scope}`], {
    cwd,
    env: { ...process.env, FAKE_CALLS: fake.calls, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exitCode = await new Promise((done) => child.on('close', done));
  return { exitCode, stderr };
}

function identityArgs({ name = 'alpha', source = 'acme/skills', scope = 'project', path }) {
  return ['--name', name, '--source', source, '--scope', scope, '--path', path];
}

function handleArgs(capture) {
  return ['--handle', capture.json.handle.path, '--marker', capture.json.handle.marker];
}

test('single-Skill Update uses three ordinary upstream calls without Intents and four with active Intents', async (t) => {
  for (const active of [false, true]) await t.test(active ? 'active Intent' : 'no Intent', async () => {
    const root = await temp(`skills-manager-update-count-${active ? 'active' : 'plain'}-`);
    const project = join(root, 'project');
    const installed = join(project, 'alpha');
    await write(join(installed, 'SKILL.md'), '---\nname: alpha\n---\n');
    if (active) await write(join(project, '.skills-manager/intents/acme-2Fskills--alpha.md'), '---\nsource: acme/skills\nskill: alpha\nscope: project\n---\n\n# Active Intents\n\n- Preserve the approved outcome.\n');
    const fake = await fakeNpx(join(root, 'fake'));
    const env = { FAKE_PROJECT_LIST: JSON.stringify([installation('alpha', installed)]) };
    const preflight = await run(['preflight', '--name', 'alpha'], { cwd: project, fake, env });
    assert.equal(preflight.exitCode, 0, preflight.stderr);
    const update = await runDirectUpdate('alpha', 'project', { cwd: project, fake, env: { ...env, FAKE_UPDATE_WARNING: 'upstream warning\n' } });
    assert.equal(update.exitCode, 0);
    assert.match(update.stderr, /upstream warning/);
    if (active) {
      const identity = preflight.json.installation;
      const captured = await run(['capture', ...identityArgs(identity)], { cwd: project, fake, env });
      assert.equal(captured.exitCode, 0, captured.stderr);
      await write(join(installed, 'SKILL.md'), '---\nname: alpha\n---\n\nApproved outcome applied.\n');
      const review = await run(['review', ...identityArgs(identity), ...handleArgs(captured)], { cwd: project, fake, env });
      assert.equal(review.exitCode, 0, review.stderr);
      assert.equal(review.json.status, 'review_required');
      assert.deepEqual(review.json.changedPaths, ['SKILL.md']);
      const close = await run(['close', ...identityArgs(identity), ...handleArgs(captured), '--outcome', 'complete'], { cwd: project, fake, env });
      assert.equal(close.exitCode, 0, close.stderr);
      await assert.rejects(lstat(captured.json.handle.path), { code: 'ENOENT' });
    }
    const observed = (await readFile(fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(observed.length, active ? 4 : 3);
    assert.deepEqual(observed.map(({ argv }) => argv[1]), active ? ['list', 'list', 'update', 'list'] : ['list', 'list', 'update']);
    assert.equal(observed.some(({ argv }) => argv[1] === 'add'), false);
  });
});

test('failed direct mutation stops the attempt and recovery begins with a new preflight rather than automatic replay', async () => {
  const root = await temp('skills-manager-update-failure-');
  const project = join(root, 'project');
  const installed = join(project, 'alpha');
  await write(join(installed, 'SKILL.md'), '---\nname: alpha\n---\n');
  const fake = await fakeNpx(join(root, 'fake'));
  const env = { FAKE_PROJECT_LIST: JSON.stringify([installation('alpha', installed)]) };
  const firstPreflight = await run(['preflight', '--name', 'alpha'], { cwd: project, fake, env });
  assert.equal(firstPreflight.exitCode, 0);
  const failed = await runDirectUpdate('alpha', 'project', { cwd: project, fake, env: { ...env, FAKE_UPDATE_FAIL: '1' } });
  assert.equal(failed.exitCode, 13);
  let observed = (await readFile(fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(observed.map(({ argv }) => argv[1]), ['list', 'list', 'update']);
  const recoveryPreflight = await run(['preflight', '--name', 'alpha'], { cwd: project, fake, env });
  assert.equal(recoveryPreflight.exitCode, 0);
  observed = (await readFile(fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(observed.map(({ argv }) => argv[1]), ['list', 'list', 'update', 'list', 'list']);
  assert.equal(observed.filter(({ argv }) => argv[1] === 'update').length, 1);
});

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
    assert.match(result.json.error.code, /identity_mismatch|installation_not_found|malformed_listing/);
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

test('focused unified hunks separate distant edits without dumping unchanged middle content', async () => {
  const fixture = await captureFixture();
  const before = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`);
  await write(join(fixture.installed, 'notes.md'), `${before.join('\n')}\n`);
  const capture = await run(['capture', ...fixture.args], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  const after = [...before];
  after[1] = 'first change';
  after[22] = 'second change';
  await write(join(fixture.installed, 'notes.md'), `${after.join('\n')}\n`);
  const review = await run(['review', ...fixture.args, ...handleArgs(capture)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  assert.equal(review.exitCode, 0, review.stderr);
  assert.equal(review.json.patch.match(/^@@ /gm)?.length, 2);
  assert.doesNotMatch(review.json.patch, /^ line 12$/m);
  await rm(capture.json.handle.path, { recursive: true });
});

test('focused unified hunks retain alignment across a large insertion plus a later edit', async () => {
  const fixture = await captureFixture();
  const before = Array.from({ length: 400 }, (_, index) => `stable line ${index + 1}`);
  await write(join(fixture.installed, 'notes.md'), `${before.join('\n')}\n`);
  const capture = await run(['capture', ...fixture.args], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  const after = [...before];
  after.splice(100, 0, ...Array.from({ length: 200 }, (_, index) => `inserted line ${index + 1}`));
  after[550] = 'later edit';
  await write(join(fixture.installed, 'notes.md'), `${after.join('\n')}\n`);
  const review = await run(['review', ...fixture.args, ...handleArgs(capture)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  assert.equal(review.exitCode, 0, review.stderr);
  assert.equal(review.json.status, 'review_required');
  assert.equal(review.json.patch.match(/^@@ /gm)?.length, 2);
  assert.doesNotMatch(review.json.patch, /^ stable line 200$/m);
  await rm(capture.json.handle.path, { recursive: true });
});

test('diff alignment budget becomes targeted review instead of a whole-file replacement', async () => {
  const fixture = await captureFixture();
  const before = Array.from({ length: 1_030 }, (_, index) => `stable line ${index + 1}`);
  await write(join(fixture.installed, 'many-edits.md'), `${before.join('\n')}\n`);
  const capture = await run(['capture', ...fixture.args], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  const after = before.map((line, index) => index % 2 === 0 ? `changed line ${index + 1}` : line);
  await write(join(fixture.installed, 'many-edits.md'), `${after.join('\n')}\n`);
  const review = await run(['review', ...fixture.args, ...handleArgs(capture)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  assert.equal(review.exitCode, 0, review.stderr);
  assert.equal(review.json.status, 'targeted_review_required');
  assert.equal(review.json.patch, '');
  assert.deepEqual(review.json.targetedReviewPaths, ['many-edits.md']);
  assert.equal(review.json.summaries[0].kind, 'patch_limit');
  await rm(capture.json.handle.path, { recursive: true });
});

test('newline-dense text uses targeted review before line objects amplify memory', async () => {
  const fixture = await captureFixture();
  await write(join(fixture.installed, 'dense.txt'), `${'\n'.repeat(100_001)}before\n`);
  const capture = await run(['capture', ...fixture.args], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  await write(join(fixture.installed, 'dense.txt'), `${'\n'.repeat(100_001)}after\n`);
  const review = await run(['review', ...fixture.args, ...handleArgs(capture)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  assert.equal(review.exitCode, 0, review.stderr);
  assert.equal(review.json.status, 'targeted_review_required');
  assert.deepEqual(review.json.targetedReviewPaths, ['dense.txt']);
  assert.equal(review.json.summaries[0].kind, 'patch_limit');
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

test('review summarizes binary and invalid UTF-8 changes with bounded size and hash metadata', async () => {
  const fixture = await captureFixture();
  await write(join(fixture.installed, 'asset.bin'), Buffer.from([0, 1, 2, 3]));
  await write(join(fixture.installed, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
  await write(join(fixture.installed, 'control.dat'), Buffer.from([1, 2, 3, 4]));
  const capture = await run(['capture', ...fixture.args], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  await write(join(fixture.installed, 'asset.bin'), Buffer.from([0, 4, 5]));
  await write(join(fixture.installed, 'invalid.txt'), Buffer.from([0xff, 0xfe, 0xfd]));
  await write(join(fixture.installed, 'control.dat'), Buffer.from([5, 6, 7, 8]));
  const review = await run(['review', ...fixture.args, ...handleArgs(capture)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  assert.equal(review.exitCode, 0, review.stderr);
  assert.equal(review.json.status, 'review_required');
  assert.deepEqual(review.json.changedPaths, ['asset.bin', 'control.dat', 'invalid.txt']);
  assert.equal(review.json.patch, '');
  assert.deepEqual(review.json.summaries.map(({ path, kind }) => [path, kind]), [['asset.bin', 'binary'], ['control.dat', 'binary'], ['invalid.txt', 'invalid_utf8']]);
  for (const summary of review.json.summaries) for (const side of ['before', 'after']) {
    assert.equal(Number.isInteger(summary[side].size), true);
    assert.match(summary[side].sha256, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(review.json.targetedReviewPaths, []);
  await rm(capture.json.handle.path, { recursive: true });
});

test('mixed binary-to-oversized text changes still require targeted review', async () => {
  const fixture = await captureFixture();
  await write(join(fixture.installed, 'mixed.dat'), Buffer.from([0, 1, 2]));
  const capture = await run(['capture', ...fixture.args], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  await write(join(fixture.installed, 'mixed.dat'), 'x'.repeat(2 * 1024 * 1024 + 1));
  const review = await run(['review', ...fixture.args, ...handleArgs(capture)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  assert.equal(review.exitCode, 0, review.stderr);
  assert.equal(review.json.status, 'targeted_review_required');
  assert.deepEqual(review.json.targetedReviewPaths, ['mixed.dat']);
  assert.equal(review.json.summaries[0].kind, 'oversized_text');
  await rm(capture.json.handle.path, { recursive: true });
});

test('review accounts for empty directories and escapes control characters in patch paths', async () => {
  const fixture = await captureFixture();
  const capture = await run(['capture', ...fixture.args], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  await mkdir(join(fixture.installed, 'empty'));
  await write(join(fixture.installed, 'bad\n--- forged.md'), 'content\n');
  const review = await run(['review', ...fixture.args, ...handleArgs(capture)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  assert.equal(review.exitCode, 0, review.stderr);
  assert.deepEqual(review.json.changedPaths, ['bad\n--- forged.md', 'empty']);
  assert.deepEqual(review.json.summaries.map(({ path, kind }) => [path, kind]), [['empty', 'directory']]);
  assert.match(review.json.patch, /"installation\/bad\\n--- forged\.md"/);
  assert.doesNotMatch(review.json.patch, /\n--- forged\.md\n/);
  await rm(fixture.result.json.handle.path, { recursive: true });
  await rm(capture.json.handle.path, { recursive: true });
});

test('review accounts for executable-mode changes without treating untouched content as invalid', async () => {
  const fixture = await captureFixture();
  await write(join(fixture.installed, 'script.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(join(fixture.installed, 'script.sh'), 0o644);
  const capture = await run(['capture', ...fixture.args], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  await chmod(join(fixture.installed, 'script.sh'), 0o755);
  const review = await run(['review', ...fixture.args, ...handleArgs(capture)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  assert.equal(review.exitCode, 0, review.stderr);
  assert.equal(review.json.status, 'review_required');
  assert.deepEqual(review.json.changedPaths, ['script.sh']);
  assert.match(review.json.patch, /old mode 100644[\s\S]*new mode 100755/);
  await rm(capture.json.handle.path, { recursive: true });
});

test('review accounts for directory-mode changes with bounded metadata', async () => {
  const fixture = await captureFixture();
  await mkdir(join(fixture.installed, 'private'), { mode: 0o755 });
  const capture = await run(['capture', ...fixture.args], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  await chmod(join(fixture.installed, 'private'), 0o700);
  const review = await run(['review', ...fixture.args, ...handleArgs(capture)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  assert.equal(review.exitCode, 0, review.stderr);
  assert.equal(review.json.status, 'review_required');
  assert.deepEqual(review.json.changedPaths, ['private']);
  assert.equal(review.json.summaries[0].kind, 'directory');
  assert.notEqual(review.json.summaries[0].before.mode, review.json.summaries[0].after.mode);
  await rm(capture.json.handle.path, { recursive: true });
});

test('deep-tree comparison bounds open directory handles while preserving accounting', async () => {
  const fixture = await captureFixture();
  const capture = await run(['capture', ...fixture.args], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  const segments = Array.from({ length: 64 }, (_, index) => `d${index}`);
  const deepest = join(fixture.installed, ...segments);
  await write(join(deepest, 'leaf.txt'), 'leaf\n');
  await Promise.all(Array.from({ length: 200 }, (_, index) => mkdir(join(deepest, `wide-${index}`))));
  const review = await run(['review', ...fixture.args, ...handleArgs(capture)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
  assert.equal(review.exitCode, 0, review.stderr);
  assert.equal(review.json.status, 'review_required');
  assert.equal(review.json.changedPaths.length, 265);
  assert.ok(review.json.changedPaths.includes(`${segments.join('/')}/leaf.txt`));
  await rm(capture.json.handle.path, { recursive: true });
});

test('oversized text and total patch overflow require targeted review with complete path accounting', async (t) => {
  await t.test('oversized text', async () => {
    const fixture = await captureFixture();
    const large = `${'line\n'.repeat(430_000)}before\n`;
    await write(join(fixture.installed, 'large.md'), large);
    const capture = await run(['capture', ...fixture.args], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
    await write(join(fixture.installed, 'large.md'), `${large.slice(0, -7)}after\n`);
    const review = await run(['review', ...fixture.args, ...handleArgs(capture)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
    assert.equal(review.exitCode, 0, review.stderr || JSON.stringify(review.json));
    assert.equal(review.json.status, 'targeted_review_required');
    assert.deepEqual(review.json.changedPaths, ['large.md']);
    assert.deepEqual(review.json.targetedReviewPaths, ['large.md']);
    assert.deepEqual(review.json.summaries.map(({ path, kind }) => [path, kind]), [['large.md', 'oversized_text']]);
    assert.ok(Buffer.byteLength(review.json.patch) <= 2 * 1024 * 1024);
    await rm(capture.json.handle.path, { recursive: true });
  });

  await t.test('total patch overflow', async () => {
    const fixture = await captureFixture();
    for (const name of ['one.md', 'two.md', 'three.md']) await write(join(fixture.installed, name), `${'before line\n'.repeat(55_000)}`);
    const capture = await run(['capture', ...fixture.args], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
    for (const name of ['one.md', 'two.md', 'three.md']) await write(join(fixture.installed, name), `${'after line\n'.repeat(55_000)}`);
    const review = await run(['review', ...fixture.args, ...handleArgs(capture)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
    assert.equal(review.exitCode, 0, review.stderr || JSON.stringify(review.json));
    assert.equal(review.json.status, 'targeted_review_required');
    assert.ok(Buffer.byteLength(review.json.patch) <= 2 * 1024 * 1024);
    const patched = review.json.changedPaths.filter((path) => review.json.patch.includes(`baseline/${path}`));
    assert.deepEqual(new Set([...patched, ...review.json.summaries.map(({ path }) => path), ...review.json.targetedReviewPaths]), new Set(review.json.changedPaths));
    assert.ok(review.json.targetedReviewPaths.length > 0);
    await rm(capture.json.handle.path, { recursive: true });
  });
});

test('review preserves trailing-newline evidence and rejects broken workflow integrity', async (t) => {
  await t.test('trailing newline', async () => {
    const fixture = await captureFixture();
    await write(join(fixture.installed, 'notes.md'), 'same line\n');
    const capture = await run(['capture', ...fixture.args], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
    await write(join(fixture.installed, 'notes.md'), 'same line');
    const review = await run(['review', ...fixture.args, ...handleArgs(capture)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
    assert.equal(review.exitCode, 0, review.stderr);
    assert.match(review.json.patch, /\\ No newline at end of file/);
    await rm(capture.json.handle.path, { recursive: true });
  });

  for (const [label, mutate, code] of [
    ['missing SKILL.md', async (fixture) => rm(join(fixture.installed, 'SKILL.md')), 'invalid_skill'],
    ['invalid UTF-8 SKILL.md', async (fixture) => write(join(fixture.installed, 'SKILL.md'), Buffer.from([0xff])), 'invalid_skill'],
    ['changed Skill identity', async (fixture) => write(join(fixture.installed, 'SKILL.md'), '---\nname: beta\n---\n'), 'identity_mismatch'],
    ['escaping changed symlink', async (fixture) => symlink('../../outside', join(fixture.installed, 'escape')), 'escaping_symlink'],
  ]) await t.test(label, async () => {
    const fixture = await captureFixture();
    await mutate(fixture);
    const review = await run(['review', ...fixture.args, ...handleArgs(fixture.result)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
    assert.equal(review.exitCode, 1);
    assert.equal(review.json.error.code, code);
    await rm(fixture.result.json.handle.path, { recursive: true });
  });

  await t.test('escaping changed symlink through a dangling target chain', async () => {
    const fixture = await captureFixture();
    await mkdir(join(fixture.root, 'outside'), { recursive: true });
    await symlink('../../outside', join(fixture.installed, 'redirect'));
    const capture = await run(['capture', ...fixture.args], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
    await symlink('redirect/missing', join(fixture.installed, 'escape-chain'));
    const review = await run(['review', ...fixture.args, ...handleArgs(capture)], { cwd: fixture.project, fake: fixture.fake, env: fixture.env });
    assert.equal(review.exitCode, 1);
    assert.equal(review.json.error.code, 'escaping_symlink');
    await rm(fixture.result.json.handle.path, { recursive: true });
    await rm(capture.json.handle.path, { recursive: true });
  });
});

test('internal child timeout and per-stream overflow return bounded machine failures', async (t) => {
  const root = await temp('skills-manager-child-bounds-');
  const project = join(root, 'project');
  const installed = join(project, 'alpha');
  await write(join(installed, 'SKILL.md'), '---\nname: alpha\n---\n');
  const fake = await fakeNpx(join(root, 'fake'));
  const base = { FAKE_PROJECT_LIST: JSON.stringify([installation('alpha', installed)]), NODE_ENV: 'test' };
  for (const [label, env, code] of [
    ['list timeout', { ...base, FAKE_DELAY_COMMAND: 'list', FAKE_DELAY_MS: '100', SKILLS_MANAGER_LIST_TIMEOUT_MS: '20' }, 'child_timeout'],
    ['stdout overflow', { ...base, FAKE_STDOUT_BYTES: String(4 * 1024 * 1024 + 1) }, 'child_output_overflow'],
    ['stderr overflow', { ...base, FAKE_STDERR_BYTES: String(4 * 1024 * 1024 + 1) }, 'child_output_overflow'],
  ]) await t.test(label, async () => {
    const result = await run(['preflight', '--name', 'alpha'], { cwd: project, fake, env });
    assert.equal(result.exitCode, 1);
    assert.equal(result.json.error.code, code);
    assert.ok(Buffer.byteLength(result.stdout) < 16 * 1024);
  });

  await t.test('timeout terminates descendants that inherit helper pipes', async () => {
    const started = Date.now();
    const result = await run(['preflight', '--name', 'alpha'], {
      cwd: project,
      fake,
      env: { ...base, FAKE_DESCENDANT_DELAY_MS: '2000', SKILLS_MANAGER_LIST_TIMEOUT_MS: '20' },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.json.error.code, 'child_timeout');
    assert.ok(Date.now() - started < 1000);
  });

  const verificationFixture = await captureFixture();
  const acquisition = await run(['verify-fulfillment', ...verificationFixture.args], {
    cwd: verificationFixture.project,
    fake: verificationFixture.fake,
    env: { ...verificationFixture.env, NODE_ENV: 'test', FAKE_DELAY_COMMAND: 'add', FAKE_DELAY_MS: '100', SKILLS_MANAGER_ACQUIRE_TIMEOUT_MS: '20' },
  });
  assert.equal(acquisition.exitCode, 1);
  assert.equal(acquisition.json.error.code, 'child_timeout');
  await rm(verificationFixture.result.json.handle.path, { recursive: true });
});
