import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const helper = resolve('skills/skills-manager/scripts/customization-patch.mjs');

async function temp(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function fakeNpx(root) {
  const executable = join(root, 'npx');
  const calls = join(root, 'calls.jsonl');
  await mkdir(root, { recursive: true });
  await writeFile(executable, `#!/usr/bin/env node
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
await appendFile(process.env.FAKE_CALLS, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
const args = process.argv.slice(2);
if (args[0] !== 'skills') process.exit(90);
if (args[1] === 'list') {
  if (process.env.FAKE_LIST_FAIL === '1') process.exit(11);
  const global = args.includes('--global');
  let payload = JSON.parse(global ? (process.env.FAKE_GLOBAL_LIST || '[]') : (process.env.FAKE_PROJECT_LIST || '[]'));
  if (!global && process.cwd().includes('skills-manager-customization-')) {
    const skill = process.env.FAKE_SELECTED_SKILL || 'alpha';
    const source = process.env.FAKE_CANDIDATE_SOURCE || 'acme/skills';
    payload = process.env.FAKE_MISSING_CANDIDATE === '1' ? [] : [{ name: skill, path: join(process.cwd(), '.agents', 'skills', skill), scope: 'project', agents: ['Universal'], source, sourceUrl: 'https://github.com/' + source + '.git', sourceType: 'github' }];
  }
  const malformed = process.env.FAKE_MALFORMED_LIST === (global ? 'global' : 'project') || (!global && process.cwd().includes('skills-manager-customization-') && process.env.FAKE_MALFORMED_CANDIDATE === '1');
  process.stdout.write(malformed ? '{' : JSON.stringify(payload));
  process.exit(0);
}
if (args[1] === 'add') {
  if (process.env.FAKE_ADD_FAIL === '1') process.exit(12);
  const skill = args[args.indexOf('--skill') + 1];
  const root = join(process.cwd(), '.agents', 'skills', skill);
  await mkdir(root, { recursive: true });
  for (const [name, content] of Object.entries(JSON.parse(process.env.FAKE_CLEAN_FILES || '{}'))) {
    const path = join(root, name);
    await mkdir(new URL('.', 'file://' + path), { recursive: true });
    await writeFile(path, content);
  }
  for (const [name, content] of Object.entries(JSON.parse(process.env.FAKE_CLEAN_BASE64 || '{}'))) {
    const path = join(root, name);
    await mkdir(new URL('.', 'file://' + path), { recursive: true });
    await writeFile(path, Buffer.from(content, 'base64'));
  }
  process.exit(0);
}
process.exit(91);
`);
  await chmod(executable, 0o755);
  return { executable, calls };
}

async function run(args, { cwd, home, fake, env = {} }) {
  const child = spawn(process.execPath, [helper, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      PATH: `${dirname(fake.executable)}:${process.env.PATH}`,
      FAKE_CALLS: fake.calls,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exitCode = await new Promise((done) => child.on('close', done));
  return { exitCode, stdout, stderr };
}

function installation(name, path, scope = 'project', source = 'acme/skills') {
  return { name, path, scope, agents: ['Codex'], source, sourceUrl: `https://github.com/${source}.git`, sourceType: 'github' };
}

async function calls(fake) {
  return (await readFile(fake.calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('no Intent document ends without acquiring clean upstream content', async () => {
  const root = await temp('skills-manager-no-intent-');
  const project = join(root, 'project');
  const home = join(root, 'home');
  const installed = join(project, '.agents/skills/alpha');
  await write(join(installed, 'SKILL.md'), 'installed\n');
  const fake = await fakeNpx(join(root, 'fake'));
  const result = await run(['alpha'], { cwd: project, home, fake, env: { FAKE_PROJECT_LIST: JSON.stringify([installation('alpha', installed)]) } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /No Intent document exists/);
  assert.match(result.stdout, /do not acquire or generate a Customization patch/i);
  assert.deepEqual((await calls(fake)).map((call) => call.argv.slice(0, 2)), [['skills', 'list'], ['skills', 'list']]);
});

test('active Intents with no diff require Agent judgment', async () => {
  const root = await temp('skills-manager-no-diff-');
  const project = join(root, 'project');
  const home = join(root, 'home');
  const installed = join(project, '.agents/skills/alpha');
  await write(join(installed, 'SKILL.md'), 'same\n');
  await write(join(project, '.skills-manager/intents/acme--skills--alpha.md'), '---\nsource: acme/skills\nskill: alpha\nscope: project\n---\n\n# Active Intents\n\n- Keep the same behavior.\n');
  const fake = await fakeNpx(join(root, 'fake'));
  const result = await run(['alpha'], { cwd: project, home, fake, env: {
    FAKE_PROJECT_LIST: JSON.stringify([installation('alpha', installed)]),
    FAKE_CLEAN_FILES: JSON.stringify({ 'SKILL.md': 'same\n' }),
  } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /active Intents exist, but the Customization patch is empty/i);
  assert.match(result.stdout, /upstream fulfills.*or.*application is incomplete/is);
});

test('non-empty comparison emits additions, modifications, deletions, and nested files', async () => {
  const root = await temp('skills-manager-diff-');
  const project = join(root, 'project');
  const home = join(root, 'home');
  const installed = join(project, '.agents/skills/alpha');
  await write(join(installed, 'SKILL.md'), 'custom\n');
  await write(join(installed, 'added.md'), 'added\n');
  await write(join(installed, 'nested/changed.md'), 'new nested\n');
  await write(join(project, '.skills-manager/intents/acme--skills--alpha.md'), '---\nsource: acme/skills\nskill: alpha\nscope: project\n---\n\n# Active Intents\n\n- Customize the Skill.\n');
  const fake = await fakeNpx(join(root, 'fake'));
  const result = await run(['alpha'], { cwd: project, home, fake, env: {
    FAKE_PROJECT_LIST: JSON.stringify([installation('alpha', installed)]),
    FAKE_CLEAN_FILES: JSON.stringify({ 'SKILL.md': 'clean\n', 'deleted.md': 'removed\n', 'nested/changed.md': 'old nested\n' }),
  } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Customization patch \(best-effort baseline\)/);
  assert.match(result.stdout, /--- clean\/SKILL\.md/);
  assert.match(result.stdout, /\+custom/);
  assert.match(result.stdout, /added\.md/);
  assert.match(result.stdout, /deleted\.md/);
  assert.match(result.stdout, /nested\/changed\.md/);
  assert.match(result.stdout, /ephemeral natural-language Customization evidence/i);
  assert.equal(await readFile(join(installed, 'SKILL.md'), 'utf8'), 'custom\n');
  const acquisition = (await calls(fake)).find((call) => call.argv[1] === 'add');
  await assert.rejects(lstat(acquisition.cwd), { code: 'ENOENT' });
});

test('unambiguous global Installation uses only the global Intent sidecar', async () => {
  const root = await temp('skills-manager-global-intent-');
  const project = join(root, 'project');
  const home = join(root, 'home');
  const installed = join(home, 'alpha');
  await write(join(installed, 'SKILL.md'), 'same\n');
  await write(join(home, '.config/skills-manager/intents/acme--skills--alpha.md'), '---\nsource: acme/skills\nskill: alpha\nscope: global\n---\n\n# Active Intents\n\n- Keep global behavior.\n');
  await write(join(project, '.skills-manager/intents/acme--skills--alpha.md'), '---\nsource: acme/skills\nskill: alpha\nscope: project\n---\n\n# Active Intents\n\n- This other scope must stay isolated.\n');
  const fake = await fakeNpx(join(root, 'fake'));
  const result = await run(['alpha'], { cwd: project, home, fake, env: {
    FAKE_GLOBAL_LIST: JSON.stringify([installation('alpha', installed, 'global')]),
    FAKE_CLEAN_FILES: JSON.stringify({ 'SKILL.md': 'same\n' }),
  } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /active Intents exist, but the Customization patch is empty/i);
});

test('binary differences have explicit raw-patch behavior', async () => {
  const root = await temp('skills-manager-binary-');
  const project = join(root, 'project');
  const home = join(root, 'home');
  const installed = join(project, 'alpha');
  await write(join(installed, 'asset.bin'), Buffer.from([0, 2]));
  await write(join(project, '.skills-manager/intents/acme--skills--alpha.md'), '---\nsource: acme/skills\nskill: alpha\nscope: project\n---\n\n# Active Intents\n\n- Customize binary asset.\n');
  const fake = await fakeNpx(join(root, 'fake'));
  const result = await run(['alpha'], { cwd: project, home, fake, env: {
    FAKE_PROJECT_LIST: JSON.stringify([installation('alpha', installed)]),
    FAKE_CLEAN_FILES: JSON.stringify({ 'asset.bin': '\u0000\u0001' }),
  } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Binary files clean\/asset\.bin and installed\/asset\.bin differ/);
});

test('invalid UTF-8 without NUL bytes is treated as non-textual content', async () => {
  const root = await temp('skills-manager-invalid-utf8-');
  const project = join(root, 'project');
  const home = join(root, 'home');
  const installed = join(project, 'alpha');
  await write(join(installed, 'asset.bin'), Buffer.from([0xff, 2]));
  await write(join(project, '.skills-manager/intents/acme--skills--alpha.md'), '---\nsource: acme/skills\nskill: alpha\nscope: project\n---\n\n# Active Intents\n\n- Customize binary asset.\n');
  const fake = await fakeNpx(join(root, 'fake'));
  const result = await run(['alpha'], { cwd: project, home, fake, env: {
    FAKE_PROJECT_LIST: JSON.stringify([installation('alpha', installed)]),
    FAKE_CLEAN_BASE64: JSON.stringify({ 'asset.bin': Buffer.from([0xfe, 2]).toString('base64') }),
  } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Binary files clean\/asset\.bin and installed\/asset\.bin differ/);
  assert.doesNotMatch(result.stdout, /�/);
});

test('text without a trailing newline remains visible in the raw patch', async () => {
  const root = await temp('skills-manager-no-newline-');
  const project = join(root, 'project');
  const home = join(root, 'home');
  const installed = join(project, 'alpha');
  await write(join(installed, 'SKILL.md'), 'custom-without-newline');
  await write(join(project, '.skills-manager/intents/acme--skills--alpha.md'), '---\nsource: acme/skills\nskill: alpha\nscope: project\n---\n\n# Active Intents\n\n- Customize.\n');
  const fake = await fakeNpx(join(root, 'fake'));
  const result = await run(['alpha'], { cwd: project, home, fake, env: {
    FAKE_PROJECT_LIST: JSON.stringify([installation('alpha', installed)]),
    FAKE_CLEAN_FILES: JSON.stringify({ 'SKILL.md': 'clean-without-newline' }),
  } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /-clean-without-newline/);
  assert.match(result.stdout, /\+custom-without-newline/);
});

test('same name in project and global scope is ambiguous until scope is supplied', async () => {
  const root = await temp('skills-manager-ambiguity-');
  const project = join(root, 'project');
  const home = join(root, 'home');
  await mkdir(project, { recursive: true });
  const fake = await fakeNpx(join(root, 'fake'));
  const projectEntry = installation('alpha', join(project, 'project-alpha'));
  const globalEntry = installation('alpha', join(home, 'global-alpha'), 'global');
  const env = { FAKE_PROJECT_LIST: JSON.stringify([projectEntry]), FAKE_GLOBAL_LIST: JSON.stringify([globalEntry]) };
  const ambiguous = await run(['alpha'], { cwd: project, home, fake, env });
  assert.equal(ambiguous.exitCode, 2);
  assert.match(ambiguous.stderr, /installed in both project and global scope/i);
  assert.match(ambiguous.stderr, /--scope project\|global/);
  const invalidResolution = await run(['alpha', '--scope', 'global'], { cwd: project, home, fake, env: { ...env, FAKE_GLOBAL_LIST: '[]' } });
  assert.equal(invalidResolution.exitCode, 2);
  assert.match(invalidResolution.stderr, /scope is accepted only to resolve/i);
});

test('malformed public fields, duplicate entries, local sources, and identity mismatch fail clearly', async (t) => {
  const root = await temp('skills-manager-invalid-');
  const project = join(root, 'project');
  const home = join(root, 'home');
  await mkdir(project, { recursive: true });
  const fake = await fakeNpx(join(root, 'fake'));
  const base = installation('alpha', join(project, 'alpha'));
  await write(join(base.path, 'SKILL.md'), 'installed\n');
  const cases = [
    ['missing path', [{ ...base, path: null }], /required field.*path/i],
    ['duplicate', [base, base], /duplicate/i],
    ['local', [{ ...base, sourceType: 'local' }], /Local Skills.*unsupported/i],
    ['missing source', [{ ...base, source: null, sourceUrl: null }], /source metadata.*unsupported/i],
  ];
  for (const [name, entries, pattern] of cases) await t.test(name, async () => {
    const localIntent = join(project, '.skills-manager/intents/acme--skills--alpha.md');
    if (name === 'local' || name === 'missing source') await write(localIntent, '---\nsource: acme/skills\nskill: alpha\nscope: project\n---\n\n# Active Intents\n\n- Customize.\n');
    const result = await run(['alpha'], { cwd: project, home, fake, env: { FAKE_PROJECT_LIST: JSON.stringify(entries) } });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, pattern);
    if (name === 'local' || name === 'missing source') await rm(localIntent);
  });
  await write(join(project, '.skills-manager/intents/other--alpha.md'), '---\nsource: other/skills\nskill: alpha\nscope: project\n---\n\n# Active Intents\n\n- Wrong identity.\n');
  const mismatch = await run(['alpha'], { cwd: project, home, fake, env: { FAKE_PROJECT_LIST: JSON.stringify([base]) } });
  assert.equal(mismatch.exitCode, 1);
  assert.match(mismatch.stderr, /different Skill identity/i);
});

test('upstream acquisition failure is reported and temporary content is cleaned', async () => {
  const root = await temp('skills-manager-upstream-failure-');
  const project = join(root, 'project');
  const home = join(root, 'home');
  const installed = join(project, 'alpha');
  await write(join(installed, 'SKILL.md'), 'custom\n');
  await write(join(project, '.skills-manager/intents/acme--skills--alpha.md'), '---\nsource: acme/skills\nskill: alpha\nscope: project\n---\n\n# Active Intents\n\n- Customize.\n');
  const fake = await fakeNpx(join(root, 'fake'));
  const result = await run(['alpha'], { cwd: project, home, fake, env: { FAKE_PROJECT_LIST: JSON.stringify([installation('alpha', installed)]), FAKE_ADD_FAIL: '1' } });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /clean upstream acquisition failed/i);
});

test('Intent documents reject extra durable state and an empty active list', async (t) => {
  const root = await temp('skills-manager-intent-shape-');
  const project = join(root, 'project');
  const home = join(root, 'home');
  const installed = join(project, 'alpha');
  const document = join(project, '.skills-manager/intents/acme--skills--alpha.md');
  await write(join(installed, 'SKILL.md'), 'custom\n');
  const fake = await fakeNpx(join(root, 'fake'));
  const env = { FAKE_PROJECT_LIST: JSON.stringify([installation('alpha', installed)]) };
  await t.test('extra metadata', async () => {
    await write(document, '---\nsource: acme/skills\nskill: alpha\nscope: project\nhistory: forbidden\n---\n\n# Active Intents\n\n- Customize.\n');
    const result = await run(['alpha'], { cwd: project, home, fake, env });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /unsupported identity field history/i);
  });
  await t.test('empty active list', async () => {
    await write(document, '---\nsource: acme/skills\nskill: alpha\nscope: project\n---\n\n# Active Intents\n');
    const result = await run(['alpha'], { cwd: project, home, fake, env });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /contains no active Intent/i);
  });
  await t.test('history after an active outcome', async () => {
    await write(document, '---\nsource: acme/skills\nskill: alpha\nscope: project\n---\n\n# Active Intents\n\n- Customize.\n\n## History\n\n- Old evidence.\n');
    const result = await run(['alpha'], { cwd: project, home, fake, env });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /content outside the active Intent list/i);
  });
});

test('sidecars for distinct source identities coexist while the matching identity is selected', async () => {
  const root = await temp('skills-manager-coexisting-identities-');
  const project = join(root, 'project');
  const home = join(root, 'home');
  const installed = join(project, 'alpha');
  await write(join(installed, 'SKILL.md'), 'same\n');
  await write(join(project, '.skills-manager/intents/old--skills--alpha.md'), '---\nsource: old/skills\nskill: alpha\nscope: project\n---\n\n# Active Intents\n\n- Preserve old identity.\n');
  await write(join(project, '.skills-manager/intents/acme--skills--alpha.md'), '---\nsource: acme/skills\nskill: alpha\nscope: project\n---\n\n# Active Intents\n\n- Preserve current identity.\n');
  const fake = await fakeNpx(join(root, 'fake'));
  const result = await run(['alpha'], { cwd: project, home, fake, env: {
    FAKE_PROJECT_LIST: JSON.stringify([installation('alpha', installed)]),
    FAKE_CLEAN_FILES: JSON.stringify({ 'SKILL.md': 'same\n' }),
  } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /active Intents exist, but the Customization patch is empty/i);
});

test('non-GitHub source paths preserve case when resolving Skill identity', async () => {
  const root = await temp('skills-manager-source-case-');
  const project = join(root, 'project');
  const home = join(root, 'home');
  const installed = join(project, 'alpha');
  await write(join(installed, 'SKILL.md'), 'installed\n');
  await write(join(project, '.skills-manager/intents/gitlab--alpha.md'), '---\nsource: https://gitlab.com/acme/skills\nskill: alpha\nscope: project\n---\n\n# Active Intents\n\n- Preserve another identity.\n');
  const fake = await fakeNpx(join(root, 'fake'));
  const entry = {
    ...installation('alpha', installed),
    source: 'https://gitlab.com/Acme/Skills',
    sourceUrl: 'https://gitlab.com/Acme/Skills.git',
    sourceType: 'git',
  };
  const result = await run(['alpha'], { cwd: project, home, fake, env: { FAKE_PROJECT_LIST: JSON.stringify([entry]) } });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /different Skill identity/i);
});

test('malformed machine output and a missing acquired Skill fail at the public interface', async () => {
  const root = await temp('skills-manager-machine-output-');
  const project = join(root, 'project');
  const home = join(root, 'home');
  const installed = join(project, 'alpha');
  await write(join(installed, 'SKILL.md'), 'custom\n');
  await write(join(project, '.skills-manager/intents/acme--skills--alpha.md'), '---\nsource: acme/skills\nskill: alpha\nscope: project\n---\n\n# Active Intents\n\n- Customize.\n');
  const fake = await fakeNpx(join(root, 'fake'));
  const malformed = await run(['alpha'], { cwd: project, home, fake, env: { FAKE_MALFORMED_LIST: 'project' } });
  assert.equal(malformed.exitCode, 1);
  assert.match(malformed.stderr, /malformed JSON/i);
  const missing = await run(['alpha'], { cwd: project, home, fake, env: {
    FAKE_PROJECT_LIST: JSON.stringify([installation('alpha', installed)]),
    FAKE_MISSING_CANDIDATE: '1',
  } });
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /did not expose exactly one selected Skill/i);
  const acquisition = (await calls(fake)).findLast((call) => call.argv[1] === 'add');
  await assert.rejects(lstat(acquisition.cwd), { code: 'ENOENT' });
  const malformedCandidate = await run(['alpha'], { cwd: project, home, fake, env: {
    FAKE_PROJECT_LIST: JSON.stringify([installation('alpha', installed)]),
    FAKE_MALFORMED_CANDIDATE: '1',
  } });
  assert.equal(malformedCandidate.exitCode, 1);
  assert.match(malformedCandidate.stderr, /malformed JSON.*project scope/i);
  const wrongSource = await run(['alpha'], { cwd: project, home, fake, env: {
    FAKE_PROJECT_LIST: JSON.stringify([installation('alpha', installed)]),
    FAKE_CANDIDATE_SOURCE: 'other/skills',
  } });
  assert.equal(wrongSource.exitCode, 1);
  assert.match(wrongSource.stderr, /different source identity/i);
});

test('a public installed path must resolve before a no-Intent terminal result', async () => {
  const root = await temp('skills-manager-missing-installation-');
  const project = join(root, 'project');
  const home = join(root, 'home');
  await mkdir(project, { recursive: true });
  const fake = await fakeNpx(join(root, 'fake'));
  const result = await run(['alpha'], { cwd: project, home, fake, env: {
    FAKE_PROJECT_LIST: JSON.stringify([installation('alpha', join(project, 'missing'))]),
  } });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /installed path.*does not resolve/i);
});

test('no-Intent state still rejects missing upstream source metadata', async () => {
  const root = await temp('skills-manager-no-intent-source-');
  const project = join(root, 'project');
  const home = join(root, 'home');
  const installed = join(project, 'alpha');
  await write(join(installed, 'SKILL.md'), 'installed\n');
  const fake = await fakeNpx(join(root, 'fake'));
  const entry = installation('alpha', installed);
  const result = await run(['alpha'], { cwd: project, home, fake, env: {
    FAKE_PROJECT_LIST: JSON.stringify([{ ...entry, source: null, sourceUrl: null }]),
  } });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /source metadata.*unsupported/i);
});
