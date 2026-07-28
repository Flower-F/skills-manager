import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const cli = resolve('skills/skills-manager/scripts/skills-manager.mjs');

async function temporaryDirectory(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function renderingHash(root) {
  const hash = createHash('sha256');
  async function visit(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        hash.update(relativePath).update('symlink\0').update(await readlink(path));
      } else if (info.isDirectory()) {
        await visit(path, relativePath);
      } else if (info.isFile()) {
        hash.update(relativePath).update(await readFile(path));
      }
    }
  }
  await visit(root);
  return hash.digest('hex');
}

async function fakeUpstream(workspace) {
  const executable = join(workspace, 'fake-npx.mjs');
  const calls = join(workspace, 'calls.jsonl');
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFile, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
await appendFile(process.env.FAKE_UPSTREAM_CALLS, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  telemetry: process.env.DISABLE_TELEMETRY ?? null,
}) + '\\n');
const command = process.argv.find((argument) => argument === 'add' || argument === 'remove');
if (command === 'remove') {
  if (process.env.FAKE_UPSTREAM_REMOVE_FAIL === '1') process.exit(7);
  const skill = process.argv[process.argv.indexOf('remove') + 1];
  const runtime = process.argv[process.argv.indexOf('--agent') + 1];
  const global = process.argv.includes('--global');
  const directory = global && runtime === 'codex'
    ? '.codex/skills/'
    : runtime === 'claude-code'
      ? '.claude/skills/'
      : runtime === 'droid'
        ? '.factory/skills/'
        : '.agents/skills/';
  await rm(new URL('./' + directory + skill + '/', 'file://' + process.cwd() + '/'), {
    recursive: true,
    force: true,
  });
  if (process.env.FAKE_UPSTREAM_REMOVE_LINK === '1') {
    await rm(new URL('./.claude/skills', 'file://' + process.cwd() + '/'), { force: true });
  }
  if (process.env.FAKE_UPSTREAM_REMOVE_FAIL_AFTER_DELETE === '1') process.exit(8);
  process.exit(0);
}
const skill = process.argv[process.argv.indexOf('--skill') + 1];
const source = process.argv[process.argv.indexOf('add') + 1];
const runtime = process.argv[process.argv.indexOf('--agent') + 1];
const directory = runtime === 'claude-code' ? '.claude/skills/' : runtime === 'droid' ? '.factory/skills/' : '.agents/skills/';
const root = new URL('./' + directory + skill + '/', 'file://' + process.cwd() + '/');
await mkdir(root, { recursive: true });
const content = process.env.FAKE_UPSTREAM_SKILL_CONTENT ?? '---\\nname: ' + skill + '\\ndescription: Candidate description.\\n---\\n\\n# Candidate\\n';
await writeFile(new URL('SKILL.md', root), content);
await mkdir(new URL('scripts/', root), { recursive: true });
const script = "import { writeFile } from 'node:fs/promises'; await writeFile(process.env.UNTRUSTED_MARKER, 'executed');\\n";
await writeFile(new URL('scripts/untrusted.mjs', root), script);
const hash = createHash('sha256');
if (process.env.FAKE_UPSTREAM_INTERNAL_ABSOLUTE_LINK === '1') {
  const reference = 'internal reference\\n';
  const referenceUrl = new URL('reference.md', root);
  await writeFile(referenceUrl, reference);
  await symlink(fileURLToPath(referenceUrl), new URL('linked.md', root));
  hash.update('reference.md').update(reference);
}
const computedHash = hash.update('scripts/untrusted.mjs').update(script)
  .update('SKILL.md').update(content)
  .digest('hex');
await writeFile(new URL('./skills-lock.json', 'file://' + process.cwd() + '/'), JSON.stringify({
  version: 1,
  skills: {
    [skill]: { source, sourceType: 'github', skillPath: 'skills/' + skill + '/SKILL.md', computedHash },
  },
}, null, 2) + '\\n');
`,
  );
  await chmod(executable, 0o755);
  return { executable, calls };
}

async function auditService() {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      'alpha-skill': {
        ath: { risk: 'safe' },
        socket: { alerts: 0 },
        snyk: { risk: 'low' },
      },
    }));
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/audit`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function runCli(args, options) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exitCode = await new Promise((done) => child.on('close', done));
  return { exitCode, stderr, result: JSON.parse(stdout) };
}

async function assessedAttempt(repository, fake, audit, extraEnvironment = {}, runtime = 'codex') {
  return runCli(
    ['assess', '--source', 'example/skills', '--skill', 'alpha-skill', '--runtime', runtime],
    {
      cwd: repository,
      env: {
        FAKE_UPSTREAM_CALLS: fake.calls,
        SKILLS_MANAGER_AUDIT_URL: audit.url,
        SKILLS_MANAGER_NPX_PATH: fake.executable,
        ...extraEnvironment,
      },
    },
  );
}

test('a reviewed safe candidate publishes as one complete managed project installation', async () => {
  const repository = await temporaryDirectory('skills-manager-install-repository-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const marker = join(repository, 'candidate-script-executed');
  try {
    const assessed = await assessedAttempt(repository, fake, audit);
    assert.equal(assessed.result.status, 'ready');

    const validated = await runCli(
      ['validate', '--work-dir', assessed.result.data.workDir],
      { cwd: repository, env: { UNTRUSTED_MARKER: marker } },
    );
    assert.equal(validated.exitCode, 0, JSON.stringify(validated.result));
    assert.equal(validated.result.status, 'needs_confirmation');
    assert.deepEqual(validated.result.data.review.files, ['scripts/untrusted.mjs', 'SKILL.md']);
    assert.equal(validated.result.data.validation.valid, true);
    assert.deepEqual(await readdir(repository), ['.git']);

    const published = await runCli(
      ['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: { UNTRUSTED_MARKER: marker } },
    );
    assert.equal(published.exitCode, 0);
    assert.equal(published.result.status, 'complete', JSON.stringify(published.result));
    assert.equal(
      await readFile(join(repository, '.agents/skills/alpha-skill/SKILL.md'), 'utf8'),
      '---\nname: alpha-skill\ndescription: Candidate description.\n---\n\n# Candidate\n',
    );

    const state = JSON.parse(await readFile(join(repository, '.skills-manager/state.json'), 'utf8'));
    assert.equal(state.version, 1);
    assert.equal(Object.keys(state.skills).length, 1);
    const [managed] = Object.values(state.skills);
    assert.deepEqual(managed.identity, {
      source: 'example/skills',
      skill: 'skills/alpha-skill/SKILL.md',
    });
    assert.equal(managed.scope, 'project');
    assert.match(managed.upstreamHash, /^[a-f0-9]{64}$/);
    assert.match(managed.renderedHash, /^[a-f0-9]{64}$/);
    assert.equal(managed.desiredRenderedHash, managed.renderedHash);

    const lock = JSON.parse(await readFile(join(repository, 'skills-lock.json'), 'utf8'));
    assert.deepEqual(Object.keys(lock.skills), ['alpha-skill']);
    assert.equal(lock.skills['alpha-skill'].computedHash, managed.upstreamHash);
    await assert.rejects(lstat(assessed.result.data.workDir), { code: 'ENOENT' });
    await assert.rejects(lstat(marker), { code: 'ENOENT' });

    const calls = (await readFile(fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].telemetry, '1');
  } finally {
    await audit.close();
  }
});

test('aborting after validation rejects publication without workspace state', async () => {
  const repository = await temporaryDirectory('skills-manager-reject-install-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit);
    const validated = await runCli(['validate', '--work-dir', assessed.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    assert.equal(validated.result.status, 'needs_confirmation');
    const aborted = await runCli(['abort', '--work-dir', assessed.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    assert.equal(aborted.result.status, 'complete');
    assert.deepEqual(await readdir(repository), ['.git']);
  } finally {
    await audit.close();
  }
});

test('structural validation failure aborts the attempt before workspace publication', async () => {
  const repository = await temporaryDirectory('skills-manager-invalid-install-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit, {
      FAKE_UPSTREAM_SKILL_CONTENT: '---\nname: wrong-name\ndescription: Candidate description.\n---\n',
    });
    const validated = await runCli(['validate', '--work-dir', assessed.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    assert.equal(validated.exitCode, 1);
    assert.equal(validated.result.error.code, 'validation_failed');
    await assert.rejects(lstat(assessed.result.data.workDir), { code: 'ENOENT' });
    assert.deepEqual(await readdir(repository), ['.git']);
  } finally {
    await audit.close();
  }
});

test('validation rejects missing local resources without executing candidate content', async () => {
  const repository = await temporaryDirectory('skills-manager-missing-resource-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit, {
      FAKE_UPSTREAM_SKILL_CONTENT:
        '---\nname: alpha-skill\ndescription: Candidate description.\n---\n\n[Missing](references/missing.md)\n',
    });
    const validated = await runCli(['validate', '--work-dir', assessed.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    assert.equal(validated.exitCode, 1);
    assert.equal(validated.result.error.code, 'validation_failed');
    assert.match(validated.result.error.message, /missing or unsafe/);
    assert.deepEqual(await readdir(repository), ['.git']);
  } finally {
    await audit.close();
  }
});

test('publication rejects a candidate changed after review', async () => {
  const repository = await temporaryDirectory('skills-manager-changed-after-review-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit);
    const validated = await runCli(['validate', '--work-dir', assessed.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    assert.equal(validated.result.status, 'needs_confirmation');
    await writeFile(
      join(assessed.result.data.candidate.root, 'SKILL.md'),
      '---\nname: alpha-skill\ndescription: Changed after review.\n---\n',
    );
    const published = await runCli(
      ['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.exitCode, 1);
    assert.equal(published.result.error.code, 'validation_failed');
    await assert.rejects(lstat(assessed.result.data.workDir), { code: 'ENOENT' });
    assert.deepEqual(await readdir(repository), ['.git']);
  } finally {
    await audit.close();
  }
});

test('validation rejects an absolute symlink even when it currently points inside the candidate', async () => {
  const repository = await temporaryDirectory('skills-manager-invalid-sibling-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit, {
      FAKE_UPSTREAM_INTERNAL_ABSOLUTE_LINK: '1',
    });
    const validated = await runCli(['validate', '--work-dir', assessed.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    assert.equal(validated.exitCode, 1);
    assert.equal(validated.result.error.code, 'validation_failed');
    assert.match(validated.result.error.message, /Absolute symbolic link/);
    await assert.rejects(lstat(assessed.result.data.workDir), { code: 'ENOENT' });
    assert.deepEqual(await readdir(repository), ['.git']);
  } finally {
    await audit.close();
  }
});

test('publication rejects a project target that resolves outside the repository', async () => {
  const repository = await temporaryDirectory('skills-manager-escaped-publish-');
  await mkdir(join(repository, '.git'));
  const outside = await temporaryDirectory('skills-manager-publish-outside-');
  await symlink(outside, join(repository, '.agents'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit);
    const validated = await runCli(['validate', '--work-dir', assessed.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    assert.equal(validated.result.status, 'needs_confirmation');
    const published = await runCli(
      ['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.exitCode, 1);
    assert.equal(published.result.error.code, 'invalid_publication_target');
    assert.deepEqual(await readdir(outside), []);
    await assert.rejects(lstat(join(repository, '.skills-manager')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(repository, 'skills-lock.json')), { code: 'ENOENT' });
  } finally {
    await audit.close();
  }
});

test('publication rejects a managed-state directory that resolves outside the repository', async () => {
  const repository = await temporaryDirectory('skills-manager-escaped-state-');
  await mkdir(join(repository, '.git'));
  const outside = await temporaryDirectory('skills-manager-state-outside-');
  await symlink(outside, join(repository, '.skills-manager'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit);
    await runCli(['validate', '--work-dir', assessed.result.data.workDir], { cwd: repository, env: {} });
    const published = await runCli(
      ['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.exitCode, 1);
    assert.equal(published.result.error.code, 'invalid_publication_target');
    assert.deepEqual(await readdir(outside), []);
    await assert.rejects(lstat(join(repository, '.agents')), { code: 'ENOENT' });
  } finally {
    await audit.close();
  }
});

test('same install name from a different identity returns conflict without writes', async () => {
  const repository = await temporaryDirectory('skills-manager-identity-conflict-');
  await mkdir(join(repository, '.git'));
  const originalLock = {
    version: 1,
    skills: {
      'alpha-skill': {
        source: 'another/source',
        sourceType: 'github',
        skillPath: 'skills/alpha-skill/SKILL.md',
        computedHash: 'a'.repeat(64),
      },
    },
  };
  await writeFile(join(repository, 'skills-lock.json'), `${JSON.stringify(originalLock, null, 2)}\n`);
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit);
    await runCli(['validate', '--work-dir', assessed.result.data.workDir], { cwd: repository, env: {} });
    const published = await runCli(
      ['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.exitCode, 0);
    assert.equal(published.result.status, 'conflict');
    assert.equal(published.result.data.reason, 'skill_identity_collision');
    assert.deepEqual(JSON.parse(await readFile(join(repository, 'skills-lock.json'), 'utf8')), originalLock);
    await assert.rejects(lstat(join(repository, '.agents')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(repository, '.skills-manager')), { code: 'ENOENT' });
  } finally {
    await audit.close();
  }
});

test('any duplicate managed identity for the install name blocks publication', async () => {
  const repository = await temporaryDirectory('skills-manager-duplicate-identity-');
  await mkdir(join(repository, '.git'));
  await mkdir(join(repository, '.skills-manager'));
  const managedEntry = (source, skill) => ({
    identity: { source, skill },
    installName: 'alpha-skill',
    scope: 'project',
    upstreamHash: 'a'.repeat(64),
    renderedHash: 'b'.repeat(64),
    desiredRenderedHash: 'b'.repeat(64),
    effectiveIntentsHash: 'c'.repeat(64),
    physicalTargets: ['.agents/skills/alpha-skill'],
  });
  const originalState = {
    version: 1,
    skills: {
      matching: managedEntry('example/skills', 'skills/alpha-skill/SKILL.md'),
      conflicting: managedEntry('another/source', 'skills/alpha-skill/SKILL.md'),
    },
  };
  await writeFile(
    join(repository, '.skills-manager/state.json'),
    `${JSON.stringify(originalState, null, 2)}\n`,
  );
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit);
    await runCli(['validate', '--work-dir', assessed.result.data.workDir], { cwd: repository, env: {} });
    const published = await runCli(
      ['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.exitCode, 0);
    assert.equal(published.result.status, 'conflict');
    assert.deepEqual(
      JSON.parse(await readFile(join(repository, '.skills-manager/state.json'), 'utf8')),
      originalState,
    );
    await assert.rejects(lstat(join(repository, '.agents')), { code: 'ENOENT' });
  } finally {
    await audit.close();
  }
});

test('publication fails closed on corrupt managed state and lock schemas', async (t) => {
  for (const scenario of [
    { name: 'managed state', path: '.skills-manager/state.json', code: 'invalid_managed_state' },
    { name: 'upstream lock', path: 'skills-lock.json', code: 'invalid_lock' },
  ]) {
    await t.test(scenario.name, async () => {
      const repository = await temporaryDirectory('skills-manager-corrupt-publication-state-');
      await mkdir(join(repository, '.git'));
      await mkdir(dirname(join(repository, scenario.path)), { recursive: true });
      await writeFile(join(repository, scenario.path), '{"version":1,"skills":null}\n');
      const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
      const audit = await auditService();
      try {
        const assessed = await assessedAttempt(repository, fake, audit);
        await runCli(['validate', '--work-dir', assessed.result.data.workDir], {
          cwd: repository,
          env: {},
        });
        const published = await runCli(
          ['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'],
          { cwd: repository, env: {} },
        );
        assert.equal(published.exitCode, 1);
        assert.equal(published.result.error.code, scenario.code);
        assert.equal(await readFile(join(repository, scenario.path), 'utf8'), '{"version":1,"skills":null}\n');
        await assert.rejects(lstat(join(repository, '.agents')), { code: 'ENOENT' });
      } finally {
        await audit.close();
      }
    });
  }
});

test('publication rejects malformed durable topology-link metadata', async () => {
  const repository = await temporaryDirectory('skills-manager-corrupt-topology-state-');
  await mkdir(join(repository, '.git'));
  await mkdir(join(repository, '.skills-manager'));
  await writeFile(
    join(repository, '.skills-manager/state.json'),
    `${JSON.stringify({
      version: 1,
      skills: {
        existing: {
          identity: { source: 'other/source', skill: 'skills/other/SKILL.md' },
          installName: 'other',
          scope: 'project',
          upstreamHash: 'a'.repeat(64),
          renderedHash: 'b'.repeat(64),
          desiredRenderedHash: 'b'.repeat(64),
          effectiveIntentsHash: 'c'.repeat(64),
          physicalTargets: ['.agents/skills/other'],
          topologyLinks: 'not-an-array',
        },
      },
    }, null, 2)}\n`,
  );
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit);
    await runCli(['validate', '--work-dir', assessed.result.data.workDir], { cwd: repository, env: {} });
    const published = await runCli(
      ['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.exitCode, 1);
    assert.equal(published.result.error.code, 'invalid_managed_state');
    await assert.rejects(lstat(join(repository, '.agents')), { code: 'ENOENT' });
  } finally {
    await audit.close();
  }
});

test('publication rejects parent-traversal in durable topology metadata', async () => {
  const repository = await temporaryDirectory('skills-manager-traversal-topology-state-');
  await mkdir(join(repository, '.git'));
  await mkdir(join(repository, '.skills-manager'));
  const entry = {
    identity: { source: 'other/source', skill: 'skills/other/SKILL.md' },
    installName: 'other',
    scope: 'project',
    upstreamHash: 'a'.repeat(64),
    renderedHash: 'b'.repeat(64),
    desiredRenderedHash: 'b'.repeat(64),
    effectiveIntentsHash: 'c'.repeat(64),
    physicalTargets: ['safe/../../outside'],
    topologyLinks: [{ path: 'safe/link', target: '../../../outside' }],
  };
  await writeFile(
    join(repository, '.skills-manager/state.json'),
    `${JSON.stringify({ version: 1, skills: { existing: entry } }, null, 2)}\n`,
  );
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit);
    await runCli(['validate', '--work-dir', assessed.result.data.workDir], { cwd: repository, env: {} });
    const published = await runCli(
      ['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.exitCode, 1);
    assert.equal(published.result.error.code, 'invalid_managed_state');
  } finally {
    await audit.close();
  }
});

test('validation rejects malformed quoted frontmatter', async () => {
  const repository = await temporaryDirectory('skills-manager-malformed-frontmatter-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit, {
      FAKE_UPSTREAM_SKILL_CONTENT:
        '---\nname: alpha-skill\ndescription: "unterminated description\n---\n',
    });
    const validated = await runCli(['validate', '--work-dir', assessed.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    assert.equal(validated.exitCode, 1);
    assert.equal(validated.result.error.code, 'validation_failed');
    assert.match(validated.result.error.message, /frontmatter/);
    assert.deepEqual(await readdir(repository), ['.git']);
  } finally {
    await audit.close();
  }
});

test('an empty repository publishes only to the active runtime default directory', async () => {
  const repository = await temporaryDirectory('skills-manager-empty-runtime-install-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit, {}, 'claude-code');
    const validated = await runCli(['validate', '--work-dir', assessed.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    assert.equal(validated.result.status, 'needs_confirmation');
    assert.deepEqual(validated.result.data.review.topology, {
      mode: 'single',
      physicalTargets: ['.claude/skills/alpha-skill'],
      links: [],
    });
    const published = await runCli(
      ['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.result.status, 'complete');
    await readFile(join(repository, '.claude/skills/alpha-skill/SKILL.md'));
    await assert.rejects(lstat(join(repository, '.agents')), { code: 'ENOENT' });
  } finally {
    await audit.close();
  }
});

test('multiple represented runtimes prefer one canonical Rendering with directory links', async () => {
  const repository = await temporaryDirectory('skills-manager-new-canonical-links-');
  await mkdir(join(repository, '.git'));
  await mkdir(join(repository, '.claude'));
  await mkdir(join(repository, '.factory'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit);
    const validated = await runCli(['validate', '--work-dir', assessed.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    assert.equal(validated.result.status, 'needs_confirmation');
    assert.deepEqual(validated.result.data.review.topology, {
      mode: 'canonical_links',
      physicalTargets: ['.agents/skills/alpha-skill'],
      links: [
        { path: '.claude/skills', target: '../.agents/skills' },
        { path: '.factory/skills', target: '../.agents/skills' },
      ],
    });
    const published = await runCli(
      ['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.result.status, 'complete');
    assert.equal(await readlink(join(repository, '.claude/skills')), '../.agents/skills');
    assert.equal(await readlink(join(repository, '.factory/skills')), '../.agents/skills');
    assert.equal(
      await readFile(join(repository, '.claude/skills/alpha-skill/SKILL.md'), 'utf8'),
      await readFile(join(repository, '.factory/skills/alpha-skill/SKILL.md'), 'utf8'),
    );
  } finally {
    await audit.close();
  }
});

test('duplicate runtime links to one canonical directory are deduplicated before publication', async () => {
  const repository = await temporaryDirectory('skills-manager-deduplicated-links-');
  await mkdir(join(repository, '.git'));
  await mkdir(join(repository, '.agents/skills'), { recursive: true });
  await mkdir(join(repository, '.claude'));
  await mkdir(join(repository, '.factory'));
  await symlink('../.agents/skills', join(repository, '.claude/skills'));
  await symlink('../.agents/skills', join(repository, '.factory/skills'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit);
    const validated = await runCli(['validate', '--work-dir', assessed.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    assert.deepEqual(validated.result.data.review.topology.physicalTargets, [
      '.agents/skills/alpha-skill',
    ]);
    const published = await runCli(
      ['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.result.status, 'complete');
    const state = JSON.parse(await readFile(join(repository, '.skills-manager/state.json'), 'utf8'));
    assert.deepEqual(Object.values(state.skills)[0].physicalTargets, [
      '.agents/skills/alpha-skill',
    ]);
  } finally {
    await audit.close();
  }
});

test('contained absolute canonical links are normalized in durable topology state', async () => {
  const repository = await temporaryDirectory('skills-manager-absolute-canonical-link-');
  await mkdir(join(repository, '.git'));
  await mkdir(join(repository, '.agents/skills'), { recursive: true });
  await mkdir(join(repository, '.claude'));
  await symlink(join(repository, '.agents/skills'), join(repository, '.claude/skills'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit);
    await runCli(['validate', '--work-dir', assessed.result.data.workDir], { cwd: repository, env: {} });
    const published = await runCli(
      ['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.result.status, 'complete');
    const state = JSON.parse(await readFile(join(repository, '.skills-manager/state.json'), 'utf8'));
    assert.deepEqual(Object.values(state.skills)[0].topologyLinks, [
      {
        path: '.claude/skills',
        target: '../.agents/skills',
        resolvedPath: '.agents/skills',
      },
    ]);
  } finally {
    await audit.close();
  }
});

test('explicit copy-mode confirmation publishes complete converged independent copies', async () => {
  const repository = await temporaryDirectory('skills-manager-copy-mode-');
  await mkdir(join(repository, '.git'));
  await mkdir(join(repository, '.agents/skills'), { recursive: true });
  await mkdir(join(repository, '.claude/skills'), { recursive: true });
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit);
    const validated = await runCli(['validate', '--work-dir', assessed.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    assert.equal(validated.exitCode, 0);
    assert.equal(validated.result.status, 'conflict');
    assert.equal(validated.result.data.reason, 'copy_topology_requires_confirmation');
    assert.deepEqual(validated.result.data.targets, [
      '.agents/skills/alpha-skill',
      '.claude/skills/alpha-skill',
    ]);

    const continued = await runCli(
      ['continue', '--work-dir', assessed.result.data.workDir, '--accept-copy-mode'],
      { cwd: repository, env: {} },
    );
    assert.equal(continued.exitCode, 0);
    assert.equal(continued.result.status, 'needs_confirmation');

    const published = await runCli(
      ['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.result.status, 'complete');
    const canonical = await readFile(join(repository, '.agents/skills/alpha-skill/SKILL.md'), 'utf8');
    const copy = await readFile(join(repository, '.claude/skills/alpha-skill/SKILL.md'), 'utf8');
    assert.equal(copy, canonical);
    const state = JSON.parse(await readFile(join(repository, '.skills-manager/state.json'), 'utf8'));
    const managed = Object.values(state.skills)[0];
    assert.deepEqual(managed.physicalTargets, [
      '.agents/skills/alpha-skill',
      '.claude/skills/alpha-skill',
    ]);
    assert.equal(managed.renderedHash, managed.desiredRenderedHash);
  } finally {
    await audit.close();
  }
});

test('mixed and broken-link topologies pause without changing any target', async (t) => {
  for (const scenario of ['mixed', 'broken']) {
    await t.test(scenario, async () => {
      const repository = await temporaryDirectory('skills-manager-conflicting-topology-');
      await mkdir(join(repository, '.git'));
      await mkdir(join(repository, '.agents/skills'), { recursive: true });
      await mkdir(join(repository, '.claude'));
      if (scenario === 'mixed') {
        await symlink('../.agents/skills', join(repository, '.claude/skills'));
        await mkdir(join(repository, '.factory/skills'), { recursive: true });
      } else {
        await symlink('../missing/skills', join(repository, '.claude/skills'));
      }
      const before = await readdir(repository);
      const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
      const audit = await auditService();
      try {
        const assessed = await assessedAttempt(repository, fake, audit);
        const validated = await runCli(['validate', '--work-dir', assessed.result.data.workDir], {
          cwd: repository,
          env: {},
        });
        assert.equal(validated.exitCode, 0);
        assert.equal(validated.result.status, 'conflict');
        assert.equal(validated.result.data.reason, 'copy_topology_requires_confirmation');
        if (scenario === 'broken') {
          assert.deepEqual(
            validated.result.data.topology.targets.find(({ path }) => path === '.claude/skills'),
            {
              path: '.claude/skills',
              kind: 'symbolic_link',
              role: 'link',
              linkTarget: '../missing/skills',
              dangling: true,
              resolvedPath: 'missing/skills',
            },
          );
        }
        assert.deepEqual(await readdir(repository), before);
        await runCli(['abort', '--work-dir', assessed.result.data.workDir], {
          cwd: repository,
          env: {},
        });
      } finally {
        await audit.close();
      }
    });
  }
});

test('confirmed copy mode replaces a dangling runtime link with a complete independent directory', async () => {
  const repository = await temporaryDirectory('skills-manager-confirmed-broken-link-');
  await mkdir(join(repository, '.git'));
  await mkdir(join(repository, '.agents/skills'), { recursive: true });
  await mkdir(join(repository, '.claude'));
  await symlink('../missing/skills', join(repository, '.claude/skills'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit);
    const validated = await runCli(['validate', '--work-dir', assessed.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    assert.equal(validated.result.status, 'conflict');
    const continued = await runCli(
      ['continue', '--work-dir', assessed.result.data.workDir, '--accept-copy-mode'],
      { cwd: repository, env: {} },
    );
    assert.equal(continued.result.status, 'needs_confirmation');
    const published = await runCli(
      ['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.result.status, 'complete', JSON.stringify(published.result));
    assert.equal((await lstat(join(repository, '.claude/skills'))).isDirectory(), true);
    assert.equal(
      await readFile(join(repository, '.claude/skills/alpha-skill/SKILL.md'), 'utf8'),
      await readFile(join(repository, '.agents/skills/alpha-skill/SKILL.md'), 'utf8'),
    );
  } finally {
    await audit.close();
  }
});

test('publication rejects topology drift in an existing canonical link before mutation', async () => {
  const repository = await temporaryDirectory('skills-manager-link-drift-');
  await mkdir(join(repository, '.git'));
  await mkdir(join(repository, '.agents/skills'), { recursive: true });
  await mkdir(join(repository, '.claude'));
  await mkdir(join(repository, 'alternate-skills'));
  await symlink('../.agents/skills', join(repository, '.claude/skills'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit);
    await runCli(['validate', '--work-dir', assessed.result.data.workDir], { cwd: repository, env: {} });
    await rm(join(repository, '.claude/skills'));
    await symlink('../alternate-skills', join(repository, '.claude/skills'));
    const published = await runCli(
      ['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.exitCode, 1);
    assert.equal(published.result.error.code, 'topology_changed');
    await assert.rejects(lstat(join(repository, '.agents/skills/alpha-skill')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(repository, '.skills-manager')), { code: 'ENOENT' });
  } finally {
    await audit.close();
  }
});

test('copy publication contains a dangling-link replacement parent before removing it', async () => {
  const repository = await temporaryDirectory('skills-manager-external-parent-');
  await mkdir(join(repository, '.git'));
  await mkdir(join(repository, '.agents/skills'), { recursive: true });
  const outside = await temporaryDirectory('skills-manager-external-agent-directory-');
  await symlink('../missing/skills', join(outside, 'skills'));
  await symlink(outside, join(repository, '.claude'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit);
    const validated = await runCli(['validate', '--work-dir', assessed.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    assert.equal(validated.result.status, 'conflict');
    await runCli(['continue', '--work-dir', assessed.result.data.workDir, '--accept-copy-mode'], {
      cwd: repository,
      env: {},
    });
    const published = await runCli(
      ['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.exitCode, 1);
    assert.equal(published.result.error.code, 'invalid_publication_target');
    assert.equal((await lstat(join(outside, 'skills'))).isSymbolicLink(), true);
    await assert.rejects(lstat(join(repository, '.agents/skills/alpha-skill')), { code: 'ENOENT' });
  } finally {
    await audit.close();
  }
});

test('copy-mode continuation rejects simultaneous security acceptance', async () => {
  const repository = await temporaryDirectory('skills-manager-ambiguous-confirmation-');
  await mkdir(join(repository, '.git'));
  await mkdir(join(repository, '.agents/skills'), { recursive: true });
  await mkdir(join(repository, '.claude/skills'), { recursive: true });
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit);
    await runCli(['validate', '--work-dir', assessed.result.data.workDir], { cwd: repository, env: {} });
    const continued = await runCli(
      [
        'continue',
        '--work-dir',
        assessed.result.data.workDir,
        '--accept-copy-mode',
        '--accept-risk',
      ],
      { cwd: repository, env: {} },
    );
    assert.equal(continued.exitCode, 1);
    assert.equal(continued.result.error.code, 'invalid_continuation');
    assert.match(continued.result.error.message, /copy-mode confirmation/);
  } finally {
    await audit.close();
  }
});

test('a late link-publication failure rolls back targets, links, state, and lock', async () => {
  const repository = await temporaryDirectory('skills-manager-late-link-failure-');
  await mkdir(join(repository, '.git'));
  await mkdir(join(repository, '.claude'));
  await mkdir(join(repository, '.factory'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    const assessed = await assessedAttempt(repository, fake, audit);
    await runCli(['validate', '--work-dir', assessed.result.data.workDir], { cwd: repository, env: {} });
    await chmod(join(repository, '.factory'), 0o500);
    const published = await runCli(
      ['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.exitCode, 1);
    await assert.rejects(lstat(join(repository, '.agents/skills/alpha-skill')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(repository, '.claude/skills')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(repository, '.skills-manager')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(repository, 'skills-lock.json')), { code: 'ENOENT' });
  } finally {
    await chmod(join(repository, '.factory'), 0o700);
    await audit.close();
  }
});

async function installManagedAlpha(repository, fake, audit) {
  const assessed = await assessedAttempt(repository, fake, audit);
  await runCli(['validate', '--work-dir', assessed.result.data.workDir], { cwd: repository, env: {} });
  return runCli(['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'], {
    cwd: repository,
    env: {},
  });
}

async function cloneManagedAlphaToGlobal(repository, globalHome) {
  const projectState = JSON.parse(
    await readFile(join(repository, '.skills-manager/state.json'), 'utf8'),
  );
  const [key, projectManaged] = Object.entries(projectState.skills)[0];
  const globalManaged = {
    ...projectManaged,
    scope: 'global',
    physicalTargets: ['.codex/skills/alpha-skill'],
    topologyLinks: [],
  };
  await mkdir(join(globalHome, '.skills-manager'), { recursive: true });
  await writeFile(
    join(globalHome, '.skills-manager/state.json'),
    `${JSON.stringify({ version: 1, skills: { [key]: globalManaged } }, null, 2)}\n`,
  );
  await mkdir(join(globalHome, '.codex/skills'), { recursive: true });
  await cp(
    join(repository, '.agents/skills/alpha-skill'),
    join(globalHome, '.codex/skills/alpha-skill'),
    { recursive: true },
  );
  await cp(join(repository, 'skills-lock.json'), join(globalHome, 'skills-lock.json'));
  return globalManaged;
}

async function installManagedAlphaCopies(repository, fake, audit) {
  await mkdir(join(repository, '.agents/skills'), { recursive: true });
  await mkdir(join(repository, '.claude/skills'), { recursive: true });
  const assessed = await assessedAttempt(repository, fake, audit);
  await runCli(['validate', '--work-dir', assessed.result.data.workDir], {
    cwd: repository,
    env: {},
  });
  await runCli(['continue', '--work-dir', assessed.result.data.workDir, '--accept-copy-mode'], {
    cwd: repository,
    env: {},
  });
  return runCli(['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'], {
    cwd: repository,
    env: {},
  });
}

test('Intent input is constrained to one concise semantic outcome', async () => {
  const repository = await temporaryDirectory('skills-manager-intent-input-');
  await mkdir(join(repository, '.git'));
  const result = await runCli(
    [
      'intent-add',
      '--skill',
      'alpha-skill',
      '--intent',
      'User said this.\nAgent replied with that.',
      '--runtime',
      'codex',
    ],
    { cwd: repository, env: {} },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.result.error.code, 'invalid_intent');
});

test('an approved Intent rerenders from latest upstream through work order, result, review, and publication', async () => {
  const repository = await temporaryDirectory('skills-manager-intent-add-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const intentText = 'Prefer concise examples in the candidate guidance.';
  try {
    await installManagedAlpha(repository, fake, audit);
    const begun = await runCli(
      ['intent-add', '--skill', 'alpha-skill', '--intent', intentText, '--runtime', 'codex'],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
          FAKE_UPSTREAM_SKILL_CONTENT:
            '---\nname: alpha-skill\ndescription: Latest upstream description.\n---\n\n# Latest upstream\n',
        },
      },
    );
    assert.equal(begun.exitCode, 0);
    assert.equal(begun.result.status, 'ready');
    assert.equal(begun.result.data.operation.type, 'intent_add');
    assert.notEqual(
      begun.result.data.candidate.root,
      join(repository, '.agents/skills/alpha-skill'),
    );

    const ordered = await runCli(['work-order', '--work-dir', begun.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    assert.equal(ordered.exitCode, 0);
    assert.equal(ordered.result.status, 'work_order');
    assert.equal(ordered.result.data.intent.text, intentText);
    assert.equal(ordered.result.data.candidate.root, begun.result.data.candidate.root);
    assert.deepEqual(ordered.result.data.editingBoundary, {
      root: begun.result.data.candidate.root,
      allowExistingFiles: true,
      newFilesRequireConfirmation: true,
    });
    assert.deepEqual(ordered.result.data.requiredResultStatuses, [
      'applied',
      'adapted',
      'obsolete',
      'failed',
    ]);

    await writeFile(
      join(begun.result.data.candidate.root, 'SKILL.md'),
      '---\nname: alpha-skill\ndescription: Latest upstream description.\n---\n\n# Latest upstream\n\nUse concise examples.\n',
    );
    const resulted = await runCli(
      [
        'intent-result',
        '--work-dir',
        begun.result.data.workDir,
        '--result',
        'applied',
        '--summary',
        'Added concise-example guidance.',
      ],
      { cwd: repository, env: {} },
    );
    assert.equal(resulted.exitCode, 0);
    assert.equal(resulted.result.status, 'needs_confirmation');
    assert.equal(resulted.result.data.review.semanticOutcome.intent, intentText);
    assert.equal(resulted.result.data.review.semanticOutcome.result, 'applied');
    assert.deepEqual(
      resulted.result.data.review.materialDiff.map(({ path, status }) => ({ path, status })),
      [{ path: 'SKILL.md', status: 'modified' }],
    );
    assert.deepEqual(
      resulted.result.data.review.totalDiff.map(({ path, status }) => ({ path, status })),
      [{ path: 'SKILL.md', status: 'modified' }],
    );

    const published = await runCli(
      ['publish', '--work-dir', begun.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.result.status, 'complete');
    assert.match(
      await readFile(join(repository, '.agents/skills/alpha-skill/SKILL.md'), 'utf8'),
      /Use concise examples/,
    );
    const state = JSON.parse(await readFile(join(repository, '.skills-manager/state.json'), 'utf8'));
    const [managed] = Object.values(state.skills);
    assert.notEqual(managed.upstreamHash, managed.renderedHash);
    assert.equal(managed.renderedHash, managed.desiredRenderedHash);
    const lock = JSON.parse(await readFile(join(repository, 'skills-lock.json'), 'utf8'));
    assert.equal(lock.skills['alpha-skill'].computedHash, managed.upstreamHash);
    assert.match(managed.effectiveIntentsHash, /^[a-f0-9]{64}$/);
    const intentFiles = await readdir(join(repository, '.skills-manager/intents'));
    assert.match(intentFiles[0], /^alpha-skill__[a-f0-9]{8}\.json$/);
    const intentRecord = JSON.parse(
      await readFile(join(repository, '.skills-manager/intents', intentFiles[0]), 'utf8'),
    );
    assert.deepEqual(intentRecord.identity, managed.identity);
    assert.equal(intentRecord.intents.length, 1);
    assert.equal(intentRecord.intents[0].text, intentText);
    assert.equal(intentRecord.intents[0].state, 'active');
    assert.equal(
      managed.effectiveIntentsHash,
      createHash('sha256')
        .update(JSON.stringify(intentRecord.intents.map(({ id, text }) => ({ id, text }))))
        .digest('hex'),
    );
    const calls = (await readFile(fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 2);
  } finally {
    await audit.close();
  }
});

test('Intent candidates fail closed when an Agent adds an escaping symlink', async () => {
  const repository = await temporaryDirectory('skills-manager-intent-escape-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    await installManagedAlpha(repository, fake, audit);
    const begun = await runCli(
      [
        'intent-add',
        '--skill',
        'alpha-skill',
        '--intent',
        'Link to the repository policy.',
        '--runtime',
        'codex',
      ],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
        },
      },
    );
    await runCli(['work-order', '--work-dir', begun.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    await symlink('/tmp', join(begun.result.data.candidate.root, 'outside'));
    const resulted = await runCli(
      ['intent-result', '--work-dir', begun.result.data.workDir, '--result', 'applied'],
      { cwd: repository, env: {} },
    );
    assert.equal(resulted.exitCode, 1);
    assert.equal(resulted.result.error.code, 'validation_failed');
    assert.match(resulted.result.error.message, /symbolic link is prohibited/i);
  } finally {
    await audit.close();
  }
});

test('adding another Intent preserves and reapplies the complete Effective-intent set', async () => {
  const repository = await temporaryDirectory('skills-manager-intent-merge-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const addAndPublish = async (intent, renderedBody) => {
    const begun = await runCli(
      ['intent-add', '--skill', 'alpha-skill', '--intent', intent, '--runtime', 'codex'],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
        },
      },
    );
    const ordered = await runCli(['work-order', '--work-dir', begun.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    await writeFile(
      join(begun.result.data.candidate.root, 'SKILL.md'),
      `---\nname: alpha-skill\ndescription: Candidate description.\n---\n\n${renderedBody}\n`,
    );
    const resultArguments = ordered.result.data.effectiveIntents.length === 1
      ? ['--result', 'applied']
      : [
          '--results',
          JSON.stringify(
            ordered.result.data.effectiveIntents.map(({ id }) => ({ id, status: 'applied' })),
          ),
        ];
    const resulted = await runCli(
      ['intent-result', '--work-dir', begun.result.data.workDir, ...resultArguments],
      { cwd: repository, env: {} },
    );
    assert.equal(resulted.result.status, 'needs_confirmation', JSON.stringify(resulted.result));
    const published = await runCli(
      ['publish', '--work-dir', begun.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.result.status, 'complete');
    return ordered.result.data.effectiveIntents;
  };
  try {
    await installManagedAlpha(repository, fake, audit);
    const first = await addAndPublish('Prefer concise examples.', 'Use concise examples.');
    assert.deepEqual(first.map(({ text }) => text), ['Prefer concise examples.']);

    const second = await addAndPublish(
      'Include one failure example.',
      'Use concise examples.\n\nInclude one failure example.',
    );
    assert.deepEqual(second.map(({ text }) => text), [
      'Prefer concise examples.',
      'Include one failure example.',
    ]);
    const [intentFile] = await readdir(join(repository, '.skills-manager/intents'));
    const record = JSON.parse(
      await readFile(join(repository, '.skills-manager/intents', intentFile), 'utf8'),
    );
    assert.deepEqual(record.intents.map(({ text }) => text), [
      'Prefer concise examples.',
      'Include one failure example.',
    ]);
  } finally {
    await audit.close();
  }
});

test('Intent work orders reject a managed Rendering replaced by an external link', async () => {
  const repository = await temporaryDirectory('skills-manager-intent-current-link-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const external = await temporaryDirectory('skills-manager-external-rendering-');
  try {
    await installManagedAlpha(repository, fake, audit);
    const begun = await runCli(
      ['intent-add', '--skill', 'alpha-skill', '--intent', 'Prefer concise output.', '--runtime', 'codex'],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
        },
      },
    );
    const target = join(repository, '.agents/skills/alpha-skill');
    await rm(target, { recursive: true });
    await symlink(external, target);
    const ordered = await runCli(['work-order', '--work-dir', begun.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    assert.equal(ordered.exitCode, 1);
    assert.equal(ordered.result.error.code, 'untracked_change');
  } finally {
    await audit.close();
  }
});

test('intent-add rejects an external Intent-state directory before reading records', async () => {
  const repository = await temporaryDirectory('skills-manager-intent-read-link-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const external = await temporaryDirectory('skills-manager-external-intent-read-');
  try {
    await installManagedAlpha(repository, fake, audit);
    await symlink(external, join(repository, '.skills-manager/intents'));
    const begun = await runCli(
      ['intent-add', '--skill', 'alpha-skill', '--intent', 'Prefer concise output.', '--runtime', 'codex'],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
        },
      },
    );
    assert.equal(begun.exitCode, 1);
    assert.equal(begun.result.error.code, 'invalid_publication_target');
  } finally {
    await audit.close();
  }
});

test('overlapping Intent additions cannot overwrite a newly published Intent baseline', async () => {
  const repository = await temporaryDirectory('skills-manager-intent-concurrent-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const environment = {
    FAKE_UPSTREAM_CALLS: fake.calls,
    SKILLS_MANAGER_AUDIT_URL: audit.url,
    SKILLS_MANAGER_NPX_PATH: fake.executable,
  };
  try {
    await installManagedAlpha(repository, fake, audit);
    const first = await runCli(
      ['intent-add', '--skill', 'alpha-skill', '--intent', 'Prefer concise output.', '--runtime', 'codex'],
      { cwd: repository, env: environment },
    );
    const second = await runCli(
      ['intent-add', '--skill', 'alpha-skill', '--intent', 'Include failure guidance.', '--runtime', 'codex'],
      { cwd: repository, env: environment },
    );
    for (const attempt of [first, second]) {
      await runCli(['work-order', '--work-dir', attempt.result.data.workDir], {
        cwd: repository,
        env: {},
      });
      await writeFile(
        join(attempt.result.data.candidate.root, 'SKILL.md'),
        `---\nname: alpha-skill\ndescription: Candidate description.\n---\n\n${attempt === first ? 'Concise.' : 'Failure guidance.'}\n`,
      );
      await runCli(
        ['intent-result', '--work-dir', attempt.result.data.workDir, '--result', 'applied'],
        { cwd: repository, env: {} },
      );
    }
    const firstPublished = await runCli(
      ['publish', '--work-dir', first.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(firstPublished.result.status, 'complete');
    const secondPublished = await runCli(
      ['publish', '--work-dir', second.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(secondPublished.exitCode, 0);
    assert.equal(secondPublished.result.status, 'conflict');
    assert.equal(secondPublished.result.data.reason, 'operation_baseline_changed');
    const [intentFile] = await readdir(join(repository, '.skills-manager/intents'));
    const record = JSON.parse(
      await readFile(join(repository, '.skills-manager/intents', intentFile), 'utf8'),
    );
    assert.deepEqual(record.intents.map(({ text }) => text), ['Prefer concise output.']);
    assert.match(
      await readFile(join(repository, '.agents/skills/alpha-skill/SKILL.md'), 'utf8'),
      /Concise/,
    );
  } finally {
    await audit.close();
  }
});

test('Intent validation rejects staging lock changes after the work order', async () => {
  const repository = await temporaryDirectory('skills-manager-intent-lock-drift-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    await installManagedAlpha(repository, fake, audit);
    const begun = await runCli(
      ['intent-add', '--skill', 'alpha-skill', '--intent', 'Prefer concise output.', '--runtime', 'codex'],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
        },
      },
    );
    await runCli(['work-order', '--work-dir', begun.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    const stagingLockPath = join(begun.result.data.workDir, 'skills-lock.json');
    const stagingLock = JSON.parse(await readFile(stagingLockPath, 'utf8'));
    stagingLock.skills['alpha-skill'].computedHash = 'f'.repeat(64);
    await writeFile(stagingLockPath, `${JSON.stringify(stagingLock, null, 2)}\n`);
    await writeFile(
      join(begun.result.data.candidate.root, 'SKILL.md'),
      '---\nname: alpha-skill\ndescription: Candidate description.\n---\n\nConcise.\n',
    );
    const resulted = await runCli(
      ['intent-result', '--work-dir', begun.result.data.workDir, '--result', 'applied'],
      { cwd: repository, env: {} },
    );
    assert.equal(resulted.exitCode, 1);
    assert.equal(resulted.result.error.code, 'validation_failed');
    assert.match(resulted.result.error.message, /upstream lock changed/i);
  } finally {
    await audit.close();
  }
});

test('Intent publication rejects an external nested Intent-state link', async () => {
  const repository = await temporaryDirectory('skills-manager-intent-state-link-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const external = await temporaryDirectory('skills-manager-external-intents-');
  try {
    await installManagedAlpha(repository, fake, audit);
    const begun = await runCli(
      ['intent-add', '--skill', 'alpha-skill', '--intent', 'Prefer concise output.', '--runtime', 'codex'],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
        },
      },
    );
    await runCli(['work-order', '--work-dir', begun.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    await writeFile(
      join(begun.result.data.candidate.root, 'SKILL.md'),
      '---\nname: alpha-skill\ndescription: Candidate description.\n---\n\nConcise.\n',
    );
    await runCli(
      ['intent-result', '--work-dir', begun.result.data.workDir, '--result', 'applied'],
      { cwd: repository, env: {} },
    );
    await symlink(external, join(repository, '.skills-manager/intents'));
    const published = await runCli(
      ['publish', '--work-dir', begun.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.exitCode, 1);
    assert.equal(published.result.error.code, 'invalid_publication_target');
    assert.deepEqual(await readdir(external), []);
  } finally {
    await audit.close();
  }
});

test('new files in an Intent result require explicit scope confirmation before review', async () => {
  const repository = await temporaryDirectory('skills-manager-intent-new-file-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    await installManagedAlpha(repository, fake, audit);
    const begun = await runCli(
      [
        'intent-add',
        '--skill',
        'alpha-skill',
        '--intent',
        'Add a short local reference with usage guidance.',
        '--runtime',
        'codex',
      ],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
        },
      },
    );
    await runCli(['work-order', '--work-dir', begun.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    await mkdir(join(begun.result.data.candidate.root, 'references'));
    await writeFile(
      join(begun.result.data.candidate.root, 'references/usage.md'),
      '# Usage\n\nKeep examples concise.\n',
    );
    const resulted = await runCli(
      ['intent-result', '--work-dir', begun.result.data.workDir, '--result', 'applied'],
      { cwd: repository, env: {} },
    );
    assert.equal(resulted.result.status, 'needs_confirmation');
    assert.equal(resulted.result.data.reason, 'changed_file_scope');
    assert.deepEqual(resulted.result.data.addedFiles, ['references/usage.md']);

    const continued = await runCli(
      ['continue', '--work-dir', begun.result.data.workDir, '--accept-change-scope'],
      { cwd: repository, env: {} },
    );
    assert.equal(continued.result.status, 'needs_confirmation');
    assert.deepEqual(
      continued.result.data.review.materialDiff.map(({ path, status }) => ({ path, status })),
      [{ path: 'references/usage.md', status: 'added' }],
    );
  } finally {
    await audit.close();
  }
});

test('changed-file confirmation cannot approve later unreviewed candidate edits', async () => {
  const repository = await temporaryDirectory('skills-manager-intent-scope-race-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    await installManagedAlpha(repository, fake, audit);
    const begun = await runCli(
      [
        'intent-add',
        '--skill',
        'alpha-skill',
        '--intent',
        'Add a short local reference.',
        '--runtime',
        'codex',
      ],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
        },
      },
    );
    await runCli(['work-order', '--work-dir', begun.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    await writeFile(join(begun.result.data.candidate.root, 'usage.md'), '# Usage\n');
    await runCli(
      ['intent-result', '--work-dir', begun.result.data.workDir, '--result', 'applied'],
      { cwd: repository, env: {} },
    );
    await writeFile(
      join(begun.result.data.candidate.root, 'SKILL.md'),
      '---\nname: alpha-skill\ndescription: Changed after result.\n---\n',
    );
    const continued = await runCli(
      ['continue', '--work-dir', begun.result.data.workDir, '--accept-change-scope'],
      { cwd: repository, env: {} },
    );
    assert.equal(continued.exitCode, 1);
    assert.equal(continued.result.error.code, 'validation_failed');
    assert.match(continued.result.error.message, /changed after the Agent result/i);
    await assert.rejects(lstat(begun.result.data.workDir), { code: 'ENOENT' });
  } finally {
    await audit.close();
  }
});

async function publishOneIntent(repository, fake, audit, intent, body = 'Apply the Intent.') {
  const begun = await runCli(
    ['intent-add', '--skill', 'alpha-skill', '--intent', intent, '--runtime', 'codex'],
    {
      cwd: repository,
      env: {
        FAKE_UPSTREAM_CALLS: fake.calls,
        SKILLS_MANAGER_AUDIT_URL: audit.url,
        SKILLS_MANAGER_NPX_PATH: fake.executable,
      },
    },
  );
  const ordered = await runCli(['work-order', '--work-dir', begun.result.data.workDir], {
    cwd: repository,
    env: {},
  });
  await writeFile(
    join(begun.result.data.candidate.root, 'SKILL.md'),
    `---\nname: alpha-skill\ndescription: Candidate description.\n---\n\n${body}\n`,
  );
  const resultArguments = ordered.result.data.effectiveIntents.length === 1
    ? ['--result', 'applied']
    : [
        '--results',
        JSON.stringify(
          ordered.result.data.effectiveIntents.map(({ id }) => ({ id, status: 'applied' })),
        ),
      ];
  await runCli(
    ['intent-result', '--work-dir', begun.result.data.workDir, ...resultArguments],
    { cwd: repository, env: {} },
  );
  return runCli(['publish', '--work-dir', begun.result.data.workDir, '--accept-publication'], {
    cwd: repository,
    env: {},
  });
}

test('update starts from latest upstream and reapplies every Effective Intent', async () => {
  const repository = await temporaryDirectory('skills-manager-update-intent-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    await installManagedAlpha(repository, fake, audit);
    await publishOneIntent(repository, fake, audit, 'Prefer concise examples.', 'Use concise examples.');
    const updated = await runCli(
      ['update', '--skill', 'alpha-skill', '--runtime', 'codex'],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
          FAKE_UPSTREAM_SKILL_CONTENT:
            '---\nname: alpha-skill\ndescription: New upstream.\n---\n\n# New upstream structure\n',
        },
      },
    );
    assert.equal(updated.result.status, 'ready');
    assert.equal(updated.result.data.operation.type, 'update');
    assert.match(
      await readFile(join(updated.result.data.candidate.root, 'SKILL.md'), 'utf8'),
      /New upstream structure/,
    );
    const ordered = await runCli(['work-order', '--work-dir', updated.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    assert.equal(ordered.result.status, 'work_order');
    assert.deepEqual(ordered.result.data.effectiveIntents.map(({ text }) => text), [
      'Prefer concise examples.',
    ]);
    await writeFile(
      join(updated.result.data.candidate.root, 'SKILL.md'),
      '---\nname: alpha-skill\ndescription: New upstream.\n---\n\n# New upstream structure\n\nUse concise examples.\n',
    );
    const resulted = await runCli(
      [
        'intent-result',
        '--work-dir',
        updated.result.data.workDir,
        '--results',
        JSON.stringify([{ id: ordered.result.data.effectiveIntents[0].id, status: 'applied' }]),
      ],
      { cwd: repository, env: {} },
    );
    assert.equal(resulted.result.status, 'needs_confirmation');
    assert.equal(resulted.result.data.review.semanticOutcome.result, 'applied');
    const published = await runCli(
      ['publish', '--work-dir', updated.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.result.status, 'complete');
    const state = JSON.parse(await readFile(join(repository, '.skills-manager/state.json'), 'utf8'));
    const [managed] = Object.values(state.skills);
    assert.notEqual(managed.upstreamHash, managed.renderedHash);
    assert.equal(managed.renderedHash, managed.desiredRenderedHash);
    const updatedLock = JSON.parse(await readFile(join(repository, 'skills-lock.json'), 'utf8'));
    assert.equal(updatedLock.skills['alpha-skill'].computedHash, managed.upstreamHash);
    assert.match(
      await readFile(join(repository, '.agents/skills/alpha-skill/SKILL.md'), 'utf8'),
      /New upstream structure[\s\S]*Use concise examples/,
    );
  } finally {
    await audit.close();
  }
});

test('update checks the installed Rendering hash before fetching upstream', async () => {
  const repository = await temporaryDirectory('skills-manager-update-drift-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    await installManagedAlpha(repository, fake, audit);
    await writeFile(
      join(repository, '.agents/skills/alpha-skill/SKILL.md'),
      '---\nname: alpha-skill\ndescription: Manual edit.\n---\n',
    );
    const updated = await runCli(
      ['update', '--skill', 'alpha-skill', '--runtime', 'codex'],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
        },
      },
    );
    assert.equal(updated.exitCode, 0);
    assert.equal(updated.result.status, 'conflict');
    assert.equal(updated.result.data.reason, 'untracked_change');
    const calls = (await readFile(fake.calls, 'utf8')).trim().split('\n');
    assert.equal(calls.length, 1);
  } finally {
    await audit.close();
  }
});

test('a bare upstream update skips semantic work and publishes after review', async () => {
  const repository = await temporaryDirectory('skills-manager-update-bare-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    await installManagedAlpha(repository, fake, audit);
    const updated = await runCli(
      ['update', '--skill', 'alpha-skill', '--runtime', 'codex'],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
          FAKE_UPSTREAM_SKILL_CONTENT:
            '---\nname: alpha-skill\ndescription: Bare update.\n---\n\n# Bare update\n',
        },
      },
    );
    assert.equal(updated.result.status, 'needs_confirmation');
    assert.equal(updated.result.data.review.semanticOutcome.result, 'not_required');
    assert.deepEqual(updated.result.data.review.materialDiff, []);
    const ordered = await runCli(['work-order', '--work-dir', updated.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    assert.equal(ordered.exitCode, 1);
    assert.equal(ordered.result.error.code, 'invalid_continuation');
    const published = await runCli(
      ['publish', '--work-dir', updated.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.result.status, 'complete');
  } finally {
    await audit.close();
  }
});

test('a no-change bare update completes without replacing the workspace Rendering', async () => {
  const repository = await temporaryDirectory('skills-manager-update-noop-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    await installManagedAlpha(repository, fake, audit);
    const target = join(repository, '.agents/skills/alpha-skill');
    const before = await lstat(target);
    const updated = await runCli(
      ['update', '--skill', 'alpha-skill', '--runtime', 'codex'],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
        },
      },
    );
    assert.equal(updated.result.status, 'complete');
    assert.equal(updated.result.data.noChange, true);
    const after = await lstat(target);
    assert.equal(after.ino, before.ino);
    await assert.rejects(lstat(updated.result.data.workDir), { code: 'ENOENT' });
  } finally {
    await audit.close();
  }
});

test('a no-change customized update skips a redundant semantic work order', async () => {
  const repository = await temporaryDirectory('skills-manager-update-custom-noop-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    await installManagedAlpha(repository, fake, audit);
    await publishOneIntent(repository, fake, audit, 'Prefer concise examples.', 'Use concise examples.');
    const target = join(repository, '.agents/skills/alpha-skill');
    const before = await lstat(target);
    const updated = await runCli(
      ['update', '--skill', 'alpha-skill', '--runtime', 'codex'],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
        },
      },
    );
    assert.equal(updated.result.status, 'complete');
    assert.equal(updated.result.data.noChange, true);
    assert.equal((await lstat(target)).ino, before.ino);
  } finally {
    await audit.close();
  }
});

test('update does not report no-change while desired and published Rendering hashes diverge', async () => {
  const repository = await temporaryDirectory('skills-manager-update-desired-drift-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    await installManagedAlpha(repository, fake, audit);
    const statePath = join(repository, '.skills-manager/state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const [managed] = Object.values(state.skills);
    managed.desiredRenderedHash = 'f'.repeat(64);
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const updated = await runCli(
      ['update', '--skill', 'alpha-skill', '--runtime', 'codex'],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
        },
      },
    );
    assert.equal(updated.result.status, 'needs_confirmation');
    assert.notEqual(updated.result.data.noChange, true);
    const published = await runCli(
      ['publish', '--work-dir', updated.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.result.status, 'complete');
    const repaired = JSON.parse(await readFile(statePath, 'utf8'));
    const [repairedManaged] = Object.values(repaired.skills);
    assert.equal(repairedManaged.renderedHash, repairedManaged.desiredRenderedHash);
  } finally {
    await audit.close();
  }
});

test('update heals interrupted desired Renderings and rejects unexplained divergent copies', async (t) => {
  for (const scenario of ['one_desired_copy', 'all_desired_copies', 'unexplained_copy']) {
    await t.test(scenario, async () => {
      const repository = await temporaryDirectory(`skills-manager-recovery-${scenario}-`);
      await mkdir(join(repository, '.git'));
      const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
      const audit = await auditService();
      const environment = {
        FAKE_UPSTREAM_CALLS: fake.calls,
        SKILLS_MANAGER_AUDIT_URL: audit.url,
        SKILLS_MANAGER_NPX_PATH: fake.executable,
      };
      try {
        await installManagedAlphaCopies(repository, fake, audit);
        const canonical = join(repository, '.agents/skills/alpha-skill');
        const copy = join(repository, '.claude/skills/alpha-skill');
        await writeFile(
          join(canonical, 'SKILL.md'),
          '---\nname: alpha-skill\ndescription: Candidate description.\n---\n\n# Desired complete Rendering\n',
        );
        const desiredHash = await renderingHash(canonical);
        if (scenario === 'all_desired_copies') {
          await cp(canonical, copy, { recursive: true, force: true });
        } else if (scenario === 'unexplained_copy') {
          await writeFile(join(copy, 'SKILL.md'), '# neither old nor desired\n');
        }
        const statePath = join(repository, '.skills-manager/state.json');
        const state = JSON.parse(await readFile(statePath, 'utf8'));
        const [managed] = Object.values(state.skills);
        managed.desiredRenderedHash = desiredHash;
        await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
        const callsBefore = (await readFile(fake.calls, 'utf8')).trim().split('\n').length;
        const recovered = await runCli(
          ['update', '--skill', 'alpha-skill', '--runtime', 'codex'],
          { cwd: repository, env: environment },
        );
        if (scenario === 'unexplained_copy') {
          assert.equal(recovered.result.status, 'conflict');
          assert.equal(recovered.result.data.reason, 'untracked_change');
          assert.match(await readFile(join(copy, 'SKILL.md'), 'utf8'), /neither old nor desired/);
          return;
        }
        assert.equal(recovered.result.status, 'complete', JSON.stringify(recovered.result));
        assert.equal(recovered.result.data.recovered, true);
        assert.equal(await renderingHash(canonical), desiredHash);
        assert.equal(await renderingHash(copy), desiredHash);
        const repaired = JSON.parse(await readFile(statePath, 'utf8'));
        const [repairedManaged] = Object.values(repaired.skills);
        assert.equal(repairedManaged.renderedHash, desiredHash);
        assert.equal(repairedManaged.desiredRenderedHash, desiredHash);
        const lock = JSON.parse(await readFile(join(repository, 'skills-lock.json'), 'utf8'));
        assert.equal(lock.skills['alpha-skill'].computedHash, repairedManaged.upstreamHash);
        const callsAfter = (await readFile(fake.calls, 'utf8')).trim().split('\n').length;
        assert.equal(callsAfter, callsBefore);
      } finally {
        await audit.close();
      }
    });
  }
});

test('recovery ignores lookalike artifacts and refuses parents that resolve outside the project', async (t) => {
  await t.test('lookalike artifact', async () => {
    const repository = await temporaryDirectory('skills-manager-recovery-lookalike-');
    await mkdir(join(repository, '.git'));
    const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
    const audit = await auditService();
    const environment = {
      FAKE_UPSTREAM_CALLS: fake.calls,
      SKILLS_MANAGER_AUDIT_URL: audit.url,
      SKILLS_MANAGER_NPX_PATH: fake.executable,
    };
    try {
      await installManagedAlphaCopies(repository, fake, audit);
      const lookalike = join(
        repository,
        '.agents/skills/.alpha-skill.skills-manager-not-an-artifact-0',
      );
      await mkdir(lookalike);
      await writeFile(join(lookalike, 'user.txt'), 'preserve me\n');
      await runCli(['update', '--skill', 'alpha-skill', '--runtime', 'codex'], {
        cwd: repository,
        env: environment,
      });
      assert.equal(await readFile(join(lookalike, 'user.txt'), 'utf8'), 'preserve me\n');
    } finally {
      await audit.close();
    }
  });

  await t.test('external symlink parent', async () => {
    const repository = await temporaryDirectory('skills-manager-recovery-containment-');
    await mkdir(join(repository, '.git'));
    const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
    const audit = await auditService();
    const environment = {
      FAKE_UPSTREAM_CALLS: fake.calls,
      SKILLS_MANAGER_AUDIT_URL: audit.url,
      SKILLS_MANAGER_NPX_PATH: fake.executable,
    };
    try {
      await installManagedAlphaCopies(repository, fake, audit);
      const external = await temporaryDirectory('skills-manager-external-parent-');
      await rename(join(repository, '.agents'), join(repository, '.agents-original'));
      await symlink(external, join(repository, '.agents'), 'dir');
      const attempted = await runCli(['update', '--skill', 'alpha-skill', '--runtime', 'codex'], {
        cwd: repository,
        env: environment,
      });
      assert.equal(attempted.result.status, 'failed');
      assert.equal(attempted.result.error.code, 'invalid_publication_target');
      assert.deepEqual(await readdir(external), []);
    } finally {
      await audit.close();
    }
  });
});

test('the next update recovers every injected publication boundary', async (t) => {
  const installBoundaries = ['state', 'lock', 'target_activated:0', 'link:0', 'final_state'];
  for (const boundary of installBoundaries) {
    await t.test(`install ${boundary}`, async () => {
      const repository = await temporaryDirectory('skills-manager-install-interruption-');
      await mkdir(join(repository, '.git'));
      await mkdir(join(repository, '.claude'));
      const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
      const audit = await auditService();
      const environment = {
        FAKE_UPSTREAM_CALLS: fake.calls,
        SKILLS_MANAGER_AUDIT_URL: audit.url,
        SKILLS_MANAGER_NPX_PATH: fake.executable,
      };
      try {
        const assessed = await assessedAttempt(repository, fake, audit);
        await runCli(['validate', '--work-dir', assessed.result.data.workDir], {
          cwd: repository,
          env: {},
        });
        const interrupted = await runCli(
          ['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'],
          {
            cwd: repository,
            env: { SKILLS_MANAGER_SIMULATE_INTERRUPTION: boundary },
          },
        );
        assert.equal(interrupted.result.error.code, 'simulated_interruption');
        const resumed = await runCli(['update', '--skill', 'alpha-skill', '--runtime', 'codex'], {
          cwd: repository,
          env: environment,
        });
        if (resumed.result.status === 'needs_confirmation') {
          const published = await runCli(
            ['publish', '--work-dir', resumed.result.data.workDir, '--accept-publication'],
            { cwd: repository, env: {} },
          );
          assert.equal(published.result.status, 'complete', JSON.stringify(published.result));
        } else {
          assert.equal(resumed.result.status, 'complete', JSON.stringify(resumed.result));
        }
        const state = JSON.parse(await readFile(join(repository, '.skills-manager/state.json'), 'utf8'));
        const [managed] = Object.values(state.skills);
        assert.equal(managed.publicationPending, undefined);
        assert.equal(managed.renderedHash, managed.desiredRenderedHash);
        assert.ok(await lstat(join(repository, '.agents/skills/alpha-skill')));
        assert.equal((await lstat(join(repository, '.claude/skills'))).isSymbolicLink(), true);
        assert.equal(
          (await readdir(join(repository, '.agents/skills'))).some((name) =>
            name.includes('.skills-manager-'),
          ),
          false,
        );
      } finally {
        await audit.close();
      }
    });
  }

  const updateBoundaries = [
    'state',
    'lock',
    'target_displaced:0',
    'target_activated:0',
    'target_displaced:1',
    'target_activated:1',
    'final_state',
  ];
  for (const boundary of updateBoundaries) {
    await t.test(`copy update ${boundary}`, async () => {
      const repository = await temporaryDirectory('skills-manager-update-interruption-');
      await mkdir(join(repository, '.git'));
      const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
      const audit = await auditService();
      const environment = {
        FAKE_UPSTREAM_CALLS: fake.calls,
        SKILLS_MANAGER_AUDIT_URL: audit.url,
        SKILLS_MANAGER_NPX_PATH: fake.executable,
        FAKE_UPSTREAM_SKILL_CONTENT:
          '---\nname: alpha-skill\ndescription: Updated candidate.\n---\n\n# Updated upstream\n',
      };
      try {
        await installManagedAlphaCopies(repository, fake, audit);
        const updated = await runCli(['update', '--skill', 'alpha-skill', '--runtime', 'codex'], {
          cwd: repository,
          env: environment,
        });
        const reviewed =
          updated.result.status === 'conflict'
            ? await runCli(
                ['continue', '--work-dir', updated.result.data.workDir, '--accept-copy-mode'],
                { cwd: repository, env: {} },
              )
            : updated;
        assert.equal(reviewed.result.status, 'needs_confirmation', JSON.stringify(reviewed.result));
        const interrupted = await runCli(
          ['publish', '--work-dir', updated.result.data.workDir, '--accept-publication'],
          {
            cwd: repository,
            env: { SKILLS_MANAGER_SIMULATE_INTERRUPTION: boundary },
          },
        );
        assert.equal(interrupted.result.error.code, 'simulated_interruption');
        const resumed = await runCli(['update', '--skill', 'alpha-skill', '--runtime', 'codex'], {
          cwd: repository,
          env: environment,
        });
        if (resumed.result.status === 'conflict') {
          assert.equal(resumed.result.data.reason, 'copy_topology_requires_confirmation');
          const continued = await runCli(
            ['continue', '--work-dir', resumed.result.data.workDir, '--accept-copy-mode'],
            { cwd: repository, env: {} },
          );
          assert.equal(continued.result.status, 'needs_confirmation');
          await runCli(['publish', '--work-dir', resumed.result.data.workDir, '--accept-publication'], {
            cwd: repository,
            env: {},
          });
        } else if (resumed.result.status === 'needs_confirmation') {
          await runCli(['publish', '--work-dir', resumed.result.data.workDir, '--accept-publication'], {
            cwd: repository,
            env: {},
          });
        } else {
          assert.equal(resumed.result.status, 'complete', JSON.stringify(resumed.result));
        }
        const state = JSON.parse(await readFile(join(repository, '.skills-manager/state.json'), 'utf8'));
        const [managed] = Object.values(state.skills);
        assert.equal(managed.publicationPending, undefined);
        assert.equal(await renderingHash(join(repository, '.agents/skills/alpha-skill')), managed.renderedHash);
        assert.equal(await renderingHash(join(repository, '.claude/skills/alpha-skill')), managed.renderedHash);
        for (const directory of ['.agents/skills', '.claude/skills']) {
          assert.equal(
            (await readdir(join(repository, directory))).some((name) =>
              name.includes('.skills-manager-'),
            ),
            false,
          );
        }
      } finally {
        await audit.close();
      }
    });
  }
});

test('an update semantic conflict pauses and an explicitly adapted result can continue', async () => {
  const repository = await temporaryDirectory('skills-manager-update-conflict-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    await installManagedAlpha(repository, fake, audit);
    await publishOneIntent(repository, fake, audit, 'Never publish automatically.', 'Never publish automatically.');
    await publishOneIntent(
      repository,
      fake,
      audit,
      'Include failure guidance.',
      'Never publish automatically.\n\nInclude failure guidance.',
    );
    const updated = await runCli(
      ['update', '--skill', 'alpha-skill', '--runtime', 'codex'],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
          FAKE_UPSTREAM_SKILL_CONTENT:
            '---\nname: alpha-skill\ndescription: New behavior.\n---\n\nAlways publish automatically.\n',
        },
      },
    );
    const ordered = await runCli(['work-order', '--work-dir', updated.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    const byText = new Map(
      ordered.result.data.effectiveIntents.map((intent) => [intent.text, intent.id]),
    );
    const conflict = await runCli(
      [
        'intent-result',
        '--work-dir',
        updated.result.data.workDir,
        '--results',
        JSON.stringify([
          {
            id: byText.get('Never publish automatically.'),
            status: 'failed',
            summary: 'Latest upstream requires automatic publication.',
          },
          { id: byText.get('Include failure guidance.'), status: 'applied' },
        ]),
      ],
      { cwd: repository, env: {} },
    );
    assert.equal(conflict.result.status, 'conflict');
    assert.equal(conflict.result.data.reason, 'intent_failed');
    assert.deepEqual(conflict.result.data.choices, ['revise', 'abort']);
    assert.deepEqual(conflict.result.data.intents, [
      {
        id: byText.get('Never publish automatically.'),
        text: 'Never publish automatically.',
        scopes: ['project'],
        status: 'failed',
        summary: 'Latest upstream requires automatic publication.',
      },
    ]);
    const resumed = await runCli(
      [
        'continue',
        '--work-dir',
        updated.result.data.workDir,
        '--accept-semantic-revision',
      ],
      { cwd: repository, env: {} },
    );
    assert.equal(resumed.result.status, 'work_order');
    assert.equal(resumed.result.data.resolution, 'revise');
    await writeFile(
      join(updated.result.data.candidate.root, 'SKILL.md'),
      '---\nname: alpha-skill\ndescription: New behavior.\n---\n\nAsk before publishing.\n\nInclude failure guidance.\n',
    );
    const adapted = await runCli(
      [
        'intent-result',
        '--work-dir',
        updated.result.data.workDir,
        '--results',
        JSON.stringify([
          { id: byText.get('Never publish automatically.'), status: 'adapted' },
          { id: byText.get('Include failure guidance.'), status: 'applied' },
        ]),
        '--summary',
        'Resolved the upstream contradiction by requiring confirmation.',
      ],
      { cwd: repository, env: {} },
    );
    assert.equal(adapted.result.status, 'needs_confirmation');
    assert.equal(adapted.result.data.review.semanticOutcome.result, 'adapted');
  } finally {
    await audit.close();
  }
});

test('an obsolete update result requires an explicit keep decision before review', async () => {
  const repository = await temporaryDirectory('skills-manager-update-obsolete-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const updateEnvironment = {
    FAKE_UPSTREAM_CALLS: fake.calls,
    SKILLS_MANAGER_AUDIT_URL: audit.url,
    SKILLS_MANAGER_NPX_PATH: fake.executable,
    FAKE_UPSTREAM_SKILL_CONTENT:
      '---\nname: alpha-skill\ndescription: Upstream is concise.\n---\n\nUse concise examples.\n',
  };
  try {
    await installManagedAlpha(repository, fake, audit);
    await publishOneIntent(repository, fake, audit, 'Prefer concise examples.', 'Use concise examples.');
    const updated = await runCli(
      ['update', '--skill', 'alpha-skill', '--runtime', 'codex'],
      {
        cwd: repository,
        env: updateEnvironment,
      },
    );
    const ordered = await runCli(['work-order', '--work-dir', updated.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    const intentId = ordered.result.data.effectiveIntents[0].id;
    const obsolete = await runCli(
      [
        'intent-result',
        '--work-dir',
        updated.result.data.workDir,
        '--results',
        JSON.stringify([
          { id: intentId, status: 'obsolete', summary: 'Latest upstream already satisfies it.' },
        ]),
      ],
      { cwd: repository, env: {} },
    );
    assert.equal(obsolete.result.status, 'conflict', JSON.stringify(obsolete.result));
    assert.deepEqual(obsolete.result.data.choices, ['keep', 'mark_obsolete', 'abort']);
    const kept = await runCli(
      ['continue', '--work-dir', updated.result.data.workDir, '--keep-obsolete-intents'],
      { cwd: repository, env: {} },
    );
    assert.equal(kept.result.status, 'work_order');
    assert.equal(kept.result.data.resolution, 'keep');
    const applied = await runCli(
      [
        'intent-result',
        '--work-dir',
        updated.result.data.workDir,
        '--results',
        JSON.stringify([{ id: intentId, status: 'applied' }]),
      ],
      { cwd: repository, env: {} },
    );
    assert.equal(applied.result.status, 'needs_confirmation');
    assert.deepEqual(applied.result.data.review.materialDiff, []);
    await runCli(['abort', '--work-dir', updated.result.data.workDir], {
      cwd: repository,
      env: {},
    });

    const expiring = await runCli(
      ['update', '--skill', 'alpha-skill', '--runtime', 'codex'],
      { cwd: repository, env: updateEnvironment },
    );
    const expiringOrder = await runCli(
      ['work-order', '--work-dir', expiring.result.data.workDir],
      { cwd: repository, env: {} },
    );
    const expiringId = expiringOrder.result.data.effectiveIntents[0].id;
    await runCli(
      [
        'intent-result',
        '--work-dir',
        expiring.result.data.workDir,
        '--results',
        JSON.stringify([
          {
            id: expiringId,
            status: 'obsolete',
            summary: 'Latest upstream already satisfies it.',
          },
        ]),
      ],
      { cwd: repository, env: {} },
    );
    const marked = await runCli(
      ['continue', '--work-dir', expiring.result.data.workDir, '--mark-obsolete-intents'],
      { cwd: repository, env: {} },
    );
    assert.equal(marked.result.status, 'work_order');
    assert.equal(marked.result.data.resolution, 'mark_obsolete');
    assert.deepEqual(marked.result.data.effectiveIntents, []);
    const markedResult = await runCli(
      [
        'intent-result',
        '--work-dir',
        expiring.result.data.workDir,
        '--results',
        '[]',
      ],
      { cwd: repository, env: {} },
    );
    assert.equal(markedResult.result.status, 'needs_confirmation');
    const markedPublished = await runCli(
      ['publish', '--work-dir', expiring.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(markedPublished.result.status, 'complete');
    const listed = await runCli(['intent-list', '--skill', 'alpha-skill'], {
      cwd: repository,
      env: {},
    });
    assert.equal(listed.result.data.intents[0].state, 'expired');
    assert.equal(
      listed.result.data.intents[0].obsoleteReason,
      'Latest upstream already satisfies it.',
    );
  } finally {
    await audit.close();
  }
});

async function completeIntentMutation({ repository, started, body }) {
  if (started.result.status === 'ready') {
    const ordered = await runCli(['work-order', '--work-dir', started.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    await writeFile(
      join(started.result.data.candidate.root, 'SKILL.md'),
      `---\nname: alpha-skill\ndescription: Candidate description.\n---\n\n${body}\n`,
    );
    const results = ordered.result.data.effectiveIntents.map(({ id }) => ({ id, status: 'applied' }));
    const resulted = await runCli(
      [
        'intent-result',
        '--work-dir',
        started.result.data.workDir,
        '--results',
        JSON.stringify(results),
      ],
      { cwd: repository, env: {} },
    );
    assert.equal(resulted.result.status, 'needs_confirmation');
  } else {
    assert.equal(started.result.status, 'needs_confirmation');
  }
  const published = await runCli(
    ['publish', '--work-dir', started.result.data.workDir, '--accept-publication'],
    { cwd: repository, env: {} },
  );
  assert.equal(published.result.status, 'complete');
}

test('Intent lifecycle mutations rerender latest upstream and commit only with publication', async () => {
  const repository = await temporaryDirectory('skills-manager-intent-lifecycle-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const environment = {
    FAKE_UPSTREAM_CALLS: fake.calls,
    SKILLS_MANAGER_AUDIT_URL: audit.url,
    SKILLS_MANAGER_NPX_PATH: fake.executable,
  };
  const invoke = (arguments_) => runCli(arguments_, { cwd: repository, env: environment });
  const list = () => runCli(['intent-list', '--skill', 'alpha-skill'], { cwd: repository, env: {} });
  try {
    await installManagedAlpha(repository, fake, audit);
    await publishOneIntent(repository, fake, audit, 'Prefer concise examples.', 'Concise examples.');
    await publishOneIntent(
      repository,
      fake,
      audit,
      'Include failure guidance.',
      'Concise examples.\n\nFailure guidance.',
    );
    let listed = await list();
    assert.equal(listed.result.status, 'ready');
    assert.deepEqual(listed.result.data.intents.map(({ state }) => state), ['active', 'active']);
    const [firstId, secondId] = listed.result.data.intents.map(({ id }) => id);

    const edited = await invoke([
      'intent-edit',
      '--skill',
      'alpha-skill',
      '--intent-id',
      firstId,
      '--intent',
      'Prefer one concise example.',
      '--runtime',
      'codex',
    ]);
    assert.equal(edited.result.status, 'ready');
    listed = await list();
    assert.equal(listed.result.data.intents[0].text, 'Prefer concise examples.');
    await completeIntentMutation({
      repository,
      started: edited,
      body: 'One concise example.\n\nFailure guidance.',
    });
    listed = await list();
    assert.equal(listed.result.data.intents[0].text, 'Prefer one concise example.');

    const disabled = await invoke([
      'intent-disable',
      '--skill',
      'alpha-skill',
      '--intent-id',
      secondId,
      '--runtime',
      'codex',
    ]);
    await completeIntentMutation({ repository, started: disabled, body: 'One concise example.' });
    listed = await list();
    assert.equal(listed.result.data.intents[1].state, 'disabled');
    assert.deepEqual(listed.result.data.effectiveIntentIds, [firstId]);

    const enabled = await invoke([
      'intent-enable',
      '--skill',
      'alpha-skill',
      '--intent-id',
      secondId,
      '--runtime',
      'codex',
    ]);
    await completeIntentMutation({
      repository,
      started: enabled,
      body: 'One concise example.\n\nFailure guidance.',
    });
    listed = await list();
    assert.equal(listed.result.data.intents[1].state, 'active');

    const obsolete = await invoke([
      'intent-obsolete',
      '--skill',
      'alpha-skill',
      '--intent-id',
      firstId,
      '--reason',
      'Latest upstream now provides a concise example.',
      '--runtime',
      'codex',
    ]);
    await completeIntentMutation({ repository, started: obsolete, body: 'Failure guidance.' });
    listed = await list();
    assert.equal(listed.result.data.intents[0].state, 'expired');
    assert.equal(
      listed.result.data.intents[0].obsoleteReason,
      'Latest upstream now provides a concise example.',
    );

    const proposedDelete = await invoke([
      'intent-delete',
      '--skill',
      'alpha-skill',
      '--intent-id',
      firstId,
      '--runtime',
      'codex',
    ]);
    assert.equal(proposedDelete.result.status, 'conflict');
    assert.equal(proposedDelete.result.data.reason, 'permanent_intent_deletion');
    assert.deepEqual(proposedDelete.result.data.choices, ['confirm_delete', 'cancel']);
    const deletedFirst = await invoke([
      'intent-delete',
      '--skill',
      'alpha-skill',
      '--intent-id',
      firstId,
      '--runtime',
      'codex',
      '--confirm-delete',
    ]);
    await completeIntentMutation({ repository, started: deletedFirst, body: 'Failure guidance.' });
    listed = await list();
    assert.deepEqual(listed.result.data.intents.map(({ id }) => id), [secondId]);

    const deletedLast = await invoke([
      'intent-delete',
      '--skill',
      'alpha-skill',
      '--intent-id',
      secondId,
      '--runtime',
      'codex',
      '--confirm-delete',
    ]);
    await completeIntentMutation({ repository, started: deletedLast, body: '' });
    listed = await list();
    assert.deepEqual(listed.result.data.intents, []);
    assert.deepEqual(listed.result.data.effectiveIntentIds, []);
    assert.doesNotMatch(
      await readFile(join(repository, '.agents/skills/alpha-skill/SKILL.md'), 'utf8'),
      /Failure guidance|concise example/i,
    );
  } finally {
    await audit.close();
  }
});

test('an obsolete newly proposed Intent can be explicitly persisted as expired', async () => {
  const repository = await temporaryDirectory('skills-manager-intent-add-obsolete-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    await installManagedAlpha(repository, fake, audit);
    const begun = await runCli(
      [
        'intent-add',
        '--skill',
        'alpha-skill',
        '--intent',
        'Prefer concise examples.',
        '--runtime',
        'codex',
      ],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
        },
      },
    );
    const ordered = await runCli(['work-order', '--work-dir', begun.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    const intentId = ordered.result.data.intent.id;
    const obsolete = await runCli(
      [
        'intent-result',
        '--work-dir',
        begun.result.data.workDir,
        '--result',
        'obsolete',
        '--summary',
        'Latest upstream already uses concise examples.',
      ],
      { cwd: repository, env: {} },
    );
    assert.equal(obsolete.result.status, 'conflict');
    assert.equal(obsolete.result.data.intents[0].id, intentId);
    const marked = await runCli(
      ['continue', '--work-dir', begun.result.data.workDir, '--mark-obsolete-intents'],
      { cwd: repository, env: {} },
    );
    assert.deepEqual(marked.result.data.effectiveIntents, []);
    const resulted = await runCli(
      ['intent-result', '--work-dir', begun.result.data.workDir, '--results', '[]'],
      { cwd: repository, env: {} },
    );
    assert.equal(resulted.result.status, 'needs_confirmation');
    const published = await runCli(
      ['publish', '--work-dir', begun.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.result.status, 'complete');
    const listed = await runCli(['intent-list', '--skill', 'alpha-skill'], {
      cwd: repository,
      env: {},
    });
    assert.deepEqual(listed.result.data.intents, [
      {
        id: intentId,
        text: 'Prefer concise examples.',
        state: 'expired',
        obsoleteReason: 'Latest upstream already uses concise examples.',
      },
    ]);
  } finally {
    await audit.close();
  }
});

test('a failed lifecycle regeneration leaves Intent state and Rendering unchanged', async () => {
  const repository = await temporaryDirectory('skills-manager-intent-lifecycle-failure-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    await installManagedAlpha(repository, fake, audit);
    await publishOneIntent(repository, fake, audit, 'Prefer concise examples.', 'Concise examples.');
    const listed = await runCli(['intent-list', '--skill', 'alpha-skill'], {
      cwd: repository,
      env: {},
    });
    const intentId = listed.result.data.intents[0].id;
    const beforeRendering = await readFile(
      join(repository, '.agents/skills/alpha-skill/SKILL.md'),
      'utf8',
    );
    const edited = await runCli(
      [
        'intent-edit',
        '--skill',
        'alpha-skill',
        '--intent-id',
        intentId,
        '--intent',
        'Prefer exactly one concise example.',
        '--runtime',
        'codex',
      ],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
        },
      },
    );
    assert.equal(edited.result.status, 'ready');
    const ordered = await runCli(['work-order', '--work-dir', edited.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    const failed = await runCli(
      [
        'intent-result',
        '--work-dir',
        edited.result.data.workDir,
        '--results',
        JSON.stringify([
          {
            id: ordered.result.data.effectiveIntents[0].id,
            status: 'failed',
            summary: 'The requested outcome conflicts with latest upstream.',
          },
        ]),
      ],
      { cwd: repository, env: {} },
    );
    assert.equal(failed.result.status, 'conflict');
    assert.equal(failed.result.data.reason, 'intent_failed');
    const after = await runCli(['intent-list', '--skill', 'alpha-skill'], {
      cwd: repository,
      env: {},
    });
    assert.equal(after.result.data.intents[0].state, 'active');
    assert.equal(
      await readFile(join(repository, '.agents/skills/alpha-skill/SKILL.md'), 'utf8'),
      beforeRendering,
    );
    await runCli(['abort', '--work-dir', edited.result.data.workDir], {
      cwd: repository,
      env: {},
    });
  } finally {
    await audit.close();
  }
});

async function completeScopedIntentOperation({
  repository,
  started,
  body,
  environment = {},
  assertSingularRejected = false,
  singleResult = false,
}) {
  assert.equal(started.result.status, 'ready', JSON.stringify(started.result));
  const ordered = await runCli(['work-order', '--work-dir', started.result.data.workDir], {
    cwd: repository,
    env: environment,
  });
  assert.equal(ordered.result.status, 'work_order', JSON.stringify(ordered.result));
  if (assertSingularRejected) {
    const singular = await runCli(
      ['intent-result', '--work-dir', started.result.data.workDir, '--result', 'applied'],
      { cwd: repository, env: environment },
    );
    assert.equal(singular.result.status, 'failed');
    assert.equal(singular.result.error.code, 'invalid_agent_result');
  }
  await writeFile(
    join(started.result.data.candidate.root, 'SKILL.md'),
    `---\nname: alpha-skill\ndescription: Candidate description.\n---\n\n${body}\n`,
  );
  const resultArguments = singleResult
    ? ['--result', 'applied']
    : [
        '--results',
        JSON.stringify(
          ordered.result.data.effectiveIntents.map(({ id }) => ({ id, status: 'applied' })),
        ),
      ];
  const resulted = await runCli(
    ['intent-result', '--work-dir', started.result.data.workDir, ...resultArguments],
    { cwd: repository, env: environment },
  );
  assert.equal(
    resulted.result.status,
    'needs_confirmation',
    JSON.stringify({ workDir: started.result.data.workDir, result: resulted.result }),
  );
  const published = await runCli(
    ['publish', '--work-dir', started.result.data.workDir, '--accept-publication'],
    { cwd: repository, env: environment },
  );
  assert.equal(published.result.status, 'complete', JSON.stringify(published.result));
  return ordered.result.data;
}

test('global and project Intents form a deterministic union and project suppression is isolated', async () => {
  const repository = await temporaryDirectory('skills-manager-scoped-intents-');
  const globalHome = await temporaryDirectory('skills-manager-global-home-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const environment = {
    HOME: globalHome,
    CODEX_HOME: join(globalHome, '.codex'),
    FAKE_UPSTREAM_CALLS: fake.calls,
    SKILLS_MANAGER_AUDIT_URL: audit.url,
    SKILLS_MANAGER_NPX_PATH: fake.executable,
  };
  try {
    await installManagedAlpha(repository, fake, audit);
    const globalStarted = await runCli(
      [
        'intent-add',
        '--scope',
        'global',
        '--skill',
        'alpha-skill',
        '--intent',
        'Include global safety guidance.',
        '--runtime',
        'codex',
      ],
      { cwd: repository, env: environment },
    );
    const globalOrder = await completeScopedIntentOperation({
      repository,
      started: globalStarted,
      body: 'Global safety guidance.',
      environment,
      singleResult: true,
    });
    const globalId = globalOrder.effectiveIntents[0].id;

    const projectStarted = await runCli(
      [
        'intent-add',
        '--scope',
        'project',
        '--skill',
        'alpha-skill',
        '--intent',
        'Prefer concise project examples.',
        '--runtime',
        'codex',
      ],
      { cwd: repository, env: environment },
    );
    const projectOrder = await completeScopedIntentOperation({
      repository,
      started: projectStarted,
      body: 'Global safety guidance.\n\nConcise project examples.',
      environment,
      assertSingularRejected: true,
    });
    assert.deepEqual(
      projectOrder.effectiveIntents.map(({ text, scopes }) => ({ text, scopes })),
      [
        { text: 'Include global safety guidance.', scopes: ['global'] },
        { text: 'Prefer concise project examples.', scopes: ['project'] },
      ],
    );

    const globalFiles = await readdir(join(globalHome, '.skills-manager/intents'));
    assert.equal(globalFiles.length, 1);
    const globalPath = join(globalHome, '.skills-manager/intents', globalFiles[0]);
    const globalBeforeSuppression = await readFile(globalPath, 'utf8');
    const listedBefore = await runCli(['intent-list', '--skill', 'alpha-skill'], {
      cwd: repository,
      env: { HOME: globalHome },
    });
    assert.deepEqual(listedBefore.result.data.effectiveIntentIds, [
      globalId,
      projectOrder.effectiveIntents[1].id,
    ]);

    const suppressed = await runCli(
      [
        'intent-suppress',
        '--skill',
        'alpha-skill',
        '--intent-id',
        globalId,
        '--runtime',
        'codex',
      ],
      { cwd: repository, env: environment },
    );
    await completeScopedIntentOperation({
      repository,
      started: suppressed,
      body: 'Concise project examples.',
      environment,
    });
    assert.equal(await readFile(globalPath, 'utf8'), globalBeforeSuppression);
    const listedAfter = await runCli(['intent-list', '--skill', 'alpha-skill'], {
      cwd: repository,
      env: { HOME: globalHome },
    });
    assert.deepEqual(listedAfter.result.data.effectiveIntentIds, [
      projectOrder.effectiveIntents[1].id,
    ]);
    assert.deepEqual(listedAfter.result.data.scopes.project.suppressedGlobalIntentIds, [globalId]);
    const projectFiles = await readdir(join(repository, '.skills-manager/intents'));
    const projectPath = join(repository, '.skills-manager/intents', projectFiles[0]);
    const projectBeforeGlobalMutation = await readFile(projectPath, 'utf8');
    const stateBeforeGlobalMutation = JSON.parse(
      await readFile(join(repository, '.skills-manager/state.json'), 'utf8'),
    );
    const [managedBeforeGlobalMutation] = Object.values(stateBeforeGlobalMutation.skills);
    const disabled = await runCli(
      [
        'intent-disable',
        '--scope',
        'global',
        '--skill',
        'alpha-skill',
        '--intent-id',
        globalId,
        '--runtime',
        'codex',
      ],
      { cwd: repository, env: environment },
    );
    await completeScopedIntentOperation({
      repository,
      started: disabled,
      body: 'Concise project examples.',
      environment,
    });
    assert.equal(await readFile(projectPath, 'utf8'), projectBeforeGlobalMutation);
    const globalAfterMutation = JSON.parse(await readFile(globalPath, 'utf8'));
    assert.equal(globalAfterMutation.intents[0].state, 'disabled');
    const stateAfterGlobalMutation = JSON.parse(
      await readFile(join(repository, '.skills-manager/state.json'), 'utf8'),
    );
    const [managedAfterGlobalMutation] = Object.values(stateAfterGlobalMutation.skills);
    assert.equal(
      managedAfterGlobalMutation.effectiveIntentsHash,
      managedBeforeGlobalMutation.effectiveIntentsHash,
      'non-effective global state changes must not change the semantic Effective-Intent hash',
    );
  } finally {
    await audit.close();
  }
});

test('the same Intent id with different scoped semantics returns both competing interpretations', async () => {
  const repository = await temporaryDirectory('skills-manager-scoped-collision-');
  const globalHome = await temporaryDirectory('skills-manager-global-home-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const environment = {
    HOME: globalHome,
    FAKE_UPSTREAM_CALLS: fake.calls,
    SKILLS_MANAGER_AUDIT_URL: audit.url,
    SKILLS_MANAGER_NPX_PATH: fake.executable,
  };
  try {
    await installManagedAlpha(repository, fake, audit);
    const state = JSON.parse(await readFile(join(repository, '.skills-manager/state.json'), 'utf8'));
    const [managed] = Object.values(state.skills);
    const hash = createHash('sha256')
      .update(managed.identity.source)
      .update('\0')
      .update(managed.identity.skill)
      .digest('hex')
      .slice(0, 8);
    const filename = `alpha-skill__${hash}.json`;
    await mkdir(join(repository, '.skills-manager/intents'), { recursive: true });
    await mkdir(join(globalHome, '.skills-manager/intents'), { recursive: true });
    const base = { version: 1, identity: managed.identity, installName: 'alpha-skill' };
    await writeFile(
      join(repository, '.skills-manager/intents', filename),
      `${JSON.stringify({ ...base, intents: [{ id: 'shared', text: 'Use project wording.', state: 'active' }] }, null, 2)}\n`,
    );
    await writeFile(
      join(globalHome, '.skills-manager/intents', filename),
      `${JSON.stringify({ ...base, intents: [{ id: 'shared', text: 'Use global wording.', state: 'active' }] }, null, 2)}\n`,
    );
    const listed = await runCli(['intent-list', '--skill', 'alpha-skill'], {
      cwd: repository,
      env: { HOME: globalHome },
    });
    assert.equal(listed.result.status, 'conflict');
    assert.equal(listed.result.data.reason, 'scoped_intent_collision');
    assert.deepEqual(
      listed.result.data.interpretations.map(({ scope, text }) => ({ scope, text })),
      [
        { scope: 'global', text: 'Use global wording.' },
        { scope: 'project', text: 'Use project wording.' },
      ],
    );
    assert.deepEqual(listed.result.data.choices, ['edit_project', 'suppress_global', 'cancel']);

    const edited = await runCli(
      [
        'intent-edit',
        '--scope',
        'project',
        '--skill',
        'alpha-skill',
        '--intent-id',
        'shared',
        '--intent',
        'Use global wording.',
        '--runtime',
        'codex',
      ],
      { cwd: repository, env: environment },
    );
    await completeScopedIntentOperation({
      repository,
      started: edited,
      body: 'Use global wording.',
      environment,
    });
    const resolvedByEdit = await runCli(['intent-list', '--skill', 'alpha-skill'], {
      cwd: repository,
      env: { HOME: globalHome },
    });
    assert.deepEqual(resolvedByEdit.result.data.effectiveIntents[0].scopes, [
      'global',
      'project',
    ]);

    await writeFile(
      join(repository, '.skills-manager/intents', filename),
      `${JSON.stringify({ ...base, intents: [{ id: 'shared', text: 'Use project wording.', state: 'active' }] }, null, 2)}\n`,
    );
    const globalBeforeSuppression = await readFile(
      join(globalHome, '.skills-manager/intents', filename),
      'utf8',
    );
    const suppressed = await runCli(
      [
        'intent-suppress',
        '--skill',
        'alpha-skill',
        '--intent-id',
        'shared',
        '--runtime',
        'codex',
      ],
      { cwd: repository, env: environment },
    );
    await completeScopedIntentOperation({
      repository,
      started: suppressed,
      body: 'Use project wording.',
      environment,
    });
    assert.equal(
      await readFile(join(globalHome, '.skills-manager/intents', filename), 'utf8'),
      globalBeforeSuppression,
    );
    const resolvedBySuppression = await runCli(['intent-list', '--skill', 'alpha-skill'], {
      cwd: repository,
      env: { HOME: globalHome },
    });
    assert.deepEqual(resolvedBySuppression.result.data.effectiveIntentIds, ['shared']);
    assert.deepEqual(
      resolvedBySuppression.result.data.scopes.project.suppressedGlobalIntentIds,
      ['shared'],
    );
  } finally {
    await audit.close();
  }
});

test('same-named global Intent records from another source identity are not inherited', async () => {
  const repository = await temporaryDirectory('skills-manager-scoped-identity-');
  const globalHome = await temporaryDirectory('skills-manager-global-home-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    await installManagedAlpha(repository, fake, audit);
    const unrelatedIdentity = { source: 'another/skills', skill: 'skills/alpha-skill/SKILL.md' };
    const hash = createHash('sha256')
      .update(unrelatedIdentity.source)
      .update('\0')
      .update(unrelatedIdentity.skill)
      .digest('hex')
      .slice(0, 8);
    await mkdir(join(globalHome, '.skills-manager/intents'), { recursive: true });
    await writeFile(
      join(globalHome, '.skills-manager/intents', `alpha-skill__${hash}.json`),
      `${JSON.stringify({
        version: 1,
        identity: unrelatedIdentity,
        installName: 'alpha-skill',
        intents: [{ id: 'unrelated', text: 'Do not inherit me.', state: 'active' }],
      }, null, 2)}\n`,
    );
    const listed = await runCli(['intent-list', '--skill', 'alpha-skill'], {
      cwd: repository,
      env: { HOME: globalHome },
    });
    assert.equal(listed.result.status, 'ready');
    assert.deepEqual(listed.result.data.effectiveIntentIds, []);
    assert.deepEqual(listed.result.data.scopes.global.intents, []);
  } finally {
    await audit.close();
  }
});

test('ambiguous managed identities and global-only installations require explicit resolution', async () => {
  const repository = await temporaryDirectory('skills-manager-ambiguous-identity-');
  const globalHome = await temporaryDirectory('skills-manager-global-home-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    await installManagedAlpha(repository, fake, audit);
    const statePath = join(repository, '.skills-manager/state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const [managed] = Object.values(state.skills);
    state.skills.ambiguous = {
      ...managed,
      identity: { source: 'EXAMPLE/SKILLS/', skill: managed.identity.skill },
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const ambiguous = await runCli(['intent-list', '--skill', 'alpha-skill'], {
      cwd: repository,
      env: { HOME: globalHome },
    });
    assert.equal(ambiguous.result.status, 'conflict');
    assert.equal(ambiguous.result.data.reason, 'ambiguous_skill_identity');
    assert.equal(ambiguous.result.data.identities.length, 2);
    assert.deepEqual(ambiguous.result.data.identities[0], ambiguous.result.data.identities[1]);
    assert.deepEqual(ambiguous.result.data.choices, ['migrate', 'manage_clean', 'cancel']);
    await writeFile(
      join(repository, '.skills-manager/identity-resolutions.json'),
      `${JSON.stringify({
        version: 1,
        rules: {
          beta: {
            identity: { source: 'example/skills', skill: 'skills/beta/SKILL.md' },
            choice: 'manage_clean',
            competingIdentities: [],
          },
        },
      }, null, 2)}\n`,
    );
    const resolvedIdentity = await runCli(
      [
        'identity-resolve',
        '--skill',
        'alpha-skill',
        '--source',
        'example/skills',
        '--upstream-skill',
        managed.identity.skill,
        '--choice',
        'manage_clean',
      ],
      { cwd: repository, env: { HOME: globalHome } },
    );
    assert.equal(resolvedIdentity.result.status, 'complete');
    const identityRule = JSON.parse(
      await readFile(join(repository, '.skills-manager/identity-resolutions.json'), 'utf8'),
    );
    assert.equal(identityRule.rules['alpha-skill'].choice, 'manage_clean');
    assert.equal(identityRule.rules.beta.choice, 'manage_clean');
    const resolvedList = await runCli(['intent-list', '--skill', 'alpha-skill'], {
      cwd: repository,
      env: { HOME: globalHome },
    });
    assert.equal(resolvedList.result.status, 'ready');

    managed.scope = 'global';
    managed.physicalTargets = ['.codex/skills/alpha-skill'];
    managed.topologyLinks = [];
    state.skills = { [Object.keys(state.skills)[0]]: managed };
    await mkdir(join(globalHome, '.skills-manager'), { recursive: true });
    await writeFile(
      join(globalHome, '.skills-manager/state.json'),
      `${JSON.stringify(state, null, 2)}\n`,
    );
    await mkdir(join(globalHome, '.codex/skills'), { recursive: true });
    await cp(
      join(repository, '.agents/skills/alpha-skill'),
      join(globalHome, '.codex/skills/alpha-skill'),
      { recursive: true },
    );
    await rm(statePath);
    const globalOnly = await runCli(
      [
        'intent-add',
        '--scope',
        'project',
        '--skill',
        'alpha-skill',
        '--intent',
        'Require a project Rendering.',
        '--runtime',
        'codex',
      ],
      { cwd: repository, env: { HOME: globalHome } },
    );
    assert.equal(globalOnly.result.status, 'conflict');
    assert.equal(globalOnly.result.data.reason, 'project_rendering_required');
    assert.deepEqual(globalOnly.result.data.choices, [
      'create_project_rendering',
      'promote_to_global',
      'cancel',
    ]);
    assert.deepEqual(globalOnly.result.data.resolutions.create_project_rendering, {
      command: 'assess',
      options: { source: 'example/skills', skill: 'alpha-skill', scope: 'project' },
    });
    assert.deepEqual(globalOnly.result.data.resolutions.promote_to_global, {
      command: 'intent-add',
      options: { skill: 'alpha-skill', scope: 'global' },
    });
    const promoted = await runCli(
      [
        'intent-add',
        '--scope',
        'global',
        '--skill',
        'alpha-skill',
        '--intent',
        'Promote this global outcome.',
        '--runtime',
        'codex',
      ],
      {
        cwd: repository,
        env: {
          HOME: globalHome,
          CODEX_HOME: join(globalHome, '.codex'),
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
        },
      },
    );
    await completeScopedIntentOperation({
      repository,
      started: promoted,
      body: 'Promoted global outcome.',
      environment: { HOME: globalHome, CODEX_HOME: join(globalHome, '.codex') },
      singleResult: true,
    });
    const globalState = JSON.parse(
      await readFile(join(globalHome, '.skills-manager/state.json'), 'utf8'),
    );
    assert.equal(Object.values(globalState.skills)[0].scope, 'global');
    assert.deepEqual(Object.values(globalState.skills)[0].physicalTargets, [
      '.codex/skills/alpha-skill',
    ]);
    assert.match(
      await readFile(join(globalHome, '.codex/skills/alpha-skill/SKILL.md'), 'utf8'),
      /Promoted global outcome/,
    );
    assert.equal(
      (
        await readdir(join(globalHome, '.skills-manager/intents'))
      ).length,
      1,
    );
    const globalListed = await runCli(['intent-list', '--skill', 'alpha-skill'], {
      cwd: repository,
      env: { HOME: globalHome },
    });
    const promotedId = globalListed.result.data.effectiveIntentIds[0];
    assert.equal(globalListed.result.data.scope, 'global');
    const disabledGlobalOnly = await runCli(
      [
        'intent-disable',
        '--scope',
        'global',
        '--skill',
        'alpha-skill',
        '--intent-id',
        promotedId,
        '--runtime',
        'codex',
      ],
      {
        cwd: repository,
        env: {
          HOME: globalHome,
          CODEX_HOME: join(globalHome, '.codex'),
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
        },
      },
    );
    assert.equal(disabledGlobalOnly.result.status, 'needs_confirmation');
    const disabledPublished = await runCli(
      ['publish', '--work-dir', disabledGlobalOnly.result.data.workDir, '--accept-publication'],
      {
        cwd: repository,
        env: { HOME: globalHome, CODEX_HOME: join(globalHome, '.codex') },
      },
    );
    assert.equal(disabledPublished.result.status, 'complete', JSON.stringify(disabledPublished.result));
    const listedDisabled = await runCli(['intent-list', '--skill', 'alpha-skill'], {
      cwd: repository,
      env: { HOME: globalHome },
    });
    assert.deepEqual(listedDisabled.result.data.effectiveIntentIds, []);
    assert.equal(listedDisabled.result.data.scopes.global.intents[0].state, 'disabled');
  } finally {
    await audit.close();
  }
});

test('semantic conflicts preserve the global and project interpretations for user resolution', async () => {
  const repository = await temporaryDirectory('skills-manager-scoped-semantic-conflict-');
  const globalHome = await temporaryDirectory('skills-manager-global-home-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const environment = {
    HOME: globalHome,
    FAKE_UPSTREAM_CALLS: fake.calls,
    SKILLS_MANAGER_AUDIT_URL: audit.url,
    SKILLS_MANAGER_NPX_PATH: fake.executable,
  };
  try {
    await installManagedAlpha(repository, fake, audit);
    const state = JSON.parse(await readFile(join(repository, '.skills-manager/state.json'), 'utf8'));
    const [managed] = Object.values(state.skills);
    const hash = createHash('sha256')
      .update(managed.identity.source)
      .update('\0')
      .update(managed.identity.skill)
      .digest('hex')
      .slice(0, 8);
    const filename = `alpha-skill__${hash}.json`;
    const base = { version: 1, identity: managed.identity, installName: 'alpha-skill' };
    await mkdir(join(repository, '.skills-manager/intents'), { recursive: true });
    await mkdir(join(globalHome, '.skills-manager/intents'), { recursive: true });
    await writeFile(
      join(globalHome, '.skills-manager/intents', filename),
      `${JSON.stringify({ ...base, intents: [{ id: 'global-rule', text: 'Always publish.', state: 'active' }] }, null, 2)}\n`,
    );
    await writeFile(
      join(repository, '.skills-manager/intents', filename),
      `${JSON.stringify({ ...base, intents: [{ id: 'project-rule', text: 'Never publish.', state: 'active' }] }, null, 2)}\n`,
    );
    const started = await runCli(
      ['update', '--skill', 'alpha-skill', '--runtime', 'codex'],
      { cwd: repository, env: environment },
    );
    const ordered = await runCli(['work-order', '--work-dir', started.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    const conflict = await runCli(
      [
        'intent-result',
        '--work-dir',
        started.result.data.workDir,
        '--results',
        JSON.stringify(
          ordered.result.data.effectiveIntents.map(({ id }) => ({
            id,
            status: 'failed',
            summary: 'These semantic outcomes contradict.',
          })),
        ),
      ],
      { cwd: repository, env: {} },
    );
    assert.equal(conflict.result.status, 'conflict');
    assert.equal(conflict.result.data.reason, 'intent_failed');
    assert.deepEqual(
      conflict.result.data.intents.map(({ id, scopes }) => ({ id, scopes })),
      [
        { id: 'global-rule', scopes: ['global'] },
        { id: 'project-rule', scopes: ['project'] },
      ],
    );
  } finally {
    await audit.close();
  }
});

test('marking an inherited global Intent obsolete updates its owner without losing other scopes', async () => {
  const repository = await temporaryDirectory('skills-manager-global-obsolete-');
  const globalHome = await temporaryDirectory('skills-manager-global-home-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const environment = {
    HOME: globalHome,
    FAKE_UPSTREAM_CALLS: fake.calls,
    SKILLS_MANAGER_AUDIT_URL: audit.url,
    SKILLS_MANAGER_NPX_PATH: fake.executable,
  };
  try {
    await installManagedAlpha(repository, fake, audit);
    const globalStarted = await runCli(
      [
        'intent-add',
        '--scope',
        'global',
        '--skill',
        'alpha-skill',
        '--intent',
        'Retire me when upstream covers this.',
        '--runtime',
        'codex',
      ],
      { cwd: repository, env: environment },
    );
    const globalOrder = await completeScopedIntentOperation({
      repository,
      started: globalStarted,
      body: 'Global behavior.',
      environment,
      singleResult: true,
    });
    const globalId = globalOrder.effectiveIntents[0].id;
    const projectFilesBefore = await readdir(join(repository, '.skills-manager/intents')).catch(
      () => [],
    );

    const updated = await runCli(['update', '--skill', 'alpha-skill', '--runtime', 'codex'], {
      cwd: repository,
      env: {
        ...environment,
        FAKE_UPSTREAM_SKILL_CONTENT:
          '---\nname: alpha-skill\ndescription: Updated candidate.\n---\n\n# Updated\n',
      },
    });
    const ordered = await runCli(['work-order', '--work-dir', updated.result.data.workDir], {
      cwd: repository,
      env: environment,
    });
    const obsolete = await runCli(
      [
        'intent-result',
        '--work-dir',
        updated.result.data.workDir,
        '--results',
        JSON.stringify([
          {
            id: globalId,
            status: 'obsolete',
            summary: 'Latest upstream now provides this behavior.',
          },
        ]),
      ],
      { cwd: repository, env: environment },
    );
    assert.equal(obsolete.result.status, 'conflict', JSON.stringify(obsolete.result));
    assert.deepEqual(obsolete.result.data.intents[0].scopes, ['global']);
    const marked = await runCli(
      ['continue', '--work-dir', updated.result.data.workDir, '--mark-obsolete-intents'],
      { cwd: repository, env: environment },
    );
    assert.equal(marked.result.status, 'work_order', JSON.stringify(marked.result));
    assert.deepEqual(marked.result.data.effectiveIntents, []);
    const reviewed = await runCli(
      ['intent-result', '--work-dir', updated.result.data.workDir, '--results', '[]'],
      { cwd: repository, env: environment },
    );
    assert.equal(reviewed.result.status, 'needs_confirmation', JSON.stringify(reviewed.result));
    const published = await runCli(
      ['publish', '--work-dir', updated.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: environment },
    );
    assert.equal(published.result.status, 'complete', JSON.stringify(published.result));
    const globalFiles = await readdir(join(globalHome, '.skills-manager/intents'));
    const globalRecord = JSON.parse(
      await readFile(join(globalHome, '.skills-manager/intents', globalFiles[0]), 'utf8'),
    );
    assert.equal(globalRecord.intents[0].state, 'expired');
    assert.equal(
      globalRecord.intents[0].obsoleteReason,
      'Latest upstream now provides this behavior.',
    );
    assert.deepEqual(
      await readdir(join(repository, '.skills-manager/intents')).catch(() => []),
      projectFilesBefore,
    );
    assert.equal(ordered.result.data.effectiveIntents[0].id, globalId);
  } finally {
    await audit.close();
  }
});

test('global Intent publication rejects manifest root tampering and external state links', async () => {
  const repository = await temporaryDirectory('skills-manager-global-intent-security-');
  const globalHome = await temporaryDirectory('skills-manager-global-home-');
  const external = await temporaryDirectory('skills-manager-external-global-intents-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const environment = {
    HOME: globalHome,
    FAKE_UPSTREAM_CALLS: fake.calls,
    SKILLS_MANAGER_AUDIT_URL: audit.url,
    SKILLS_MANAGER_NPX_PATH: fake.executable,
  };
  try {
    await installManagedAlpha(repository, fake, audit);
    const started = await runCli(
      [
        'intent-add',
        '--scope',
        'global',
        '--skill',
        'alpha-skill',
        '--intent',
        'Keep state contained.',
        '--runtime',
        'codex',
      ],
      { cwd: repository, env: environment },
    );
    await runCli(['work-order', '--work-dir', started.result.data.workDir], {
      cwd: repository,
      env: environment,
    });
    await writeFile(
      join(started.result.data.candidate.root, 'SKILL.md'),
      '---\nname: alpha-skill\ndescription: Candidate description.\n---\n\nContained.\n',
    );
    await runCli(
      ['intent-result', '--work-dir', started.result.data.workDir, '--result', 'applied'],
      { cwd: repository, env: environment },
    );
    const manifestPath = join(started.result.data.workDir, 'skills-manager-attempt.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.candidateIntentStates[0].scopeRoot = external;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const tampered = await runCli(
      ['publish', '--work-dir', started.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: environment },
    );
    assert.equal(tampered.result.status, 'failed');
    assert.equal(tampered.result.error.code, 'invalid_intent_state');
    assert.deepEqual(await readdir(external), []);

    await rm(started.result.data.workDir, { recursive: true, force: true });
    await mkdir(join(globalHome, '.skills-manager'), { recursive: true });
    await symlink(external, join(globalHome, '.skills-manager/intents'), 'dir');
    const linked = await runCli(
      [
        'intent-add',
        '--scope',
        'global',
        '--skill',
        'alpha-skill',
        '--intent',
        'Reject linked state.',
        '--runtime',
        'codex',
      ],
      { cwd: repository, env: environment },
    );
    assert.equal(linked.result.status, 'failed');
    assert.equal(linked.result.error.code, 'invalid_publication_target');
    assert.deepEqual(await readdir(external), []);
  } finally {
    await audit.close();
  }
});

test('identity migration rebinds Intents through semantic rendering and reviewed publication', async () => {
  const repository = await temporaryDirectory('skills-manager-identity-migration-');
  const globalHome = await temporaryDirectory('skills-manager-global-home-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const environment = {
    HOME: globalHome,
    FAKE_UPSTREAM_CALLS: fake.calls,
    SKILLS_MANAGER_AUDIT_URL: audit.url,
    SKILLS_MANAGER_NPX_PATH: fake.executable,
  };
  try {
    await installManagedAlpha(repository, fake, audit);
    const statePath = join(repository, '.skills-manager/state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const [selectedKey, selectedManaged] = Object.entries(state.skills)[0];
    const oldIdentity = { source: 'legacy/skills', skill: selectedManaged.identity.skill };
    state.skills.legacy = { ...selectedManaged, identity: oldIdentity };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const oldHash = createHash('sha256')
      .update(oldIdentity.source)
      .update('\0')
      .update(oldIdentity.skill)
      .digest('hex')
      .slice(0, 8);
    await mkdir(join(repository, '.skills-manager/intents'), { recursive: true });
    await writeFile(
      join(repository, '.skills-manager/intents', `alpha-skill__${oldHash}.json`),
      `${JSON.stringify({
        version: 1,
        identity: oldIdentity,
        installName: 'alpha-skill',
        intents: [{ id: 'legacy-rule', text: 'Preserve migrated guidance.', state: 'active' }],
      }, null, 2)}\n`,
    );
    const selectedHash = createHash('sha256')
      .update(selectedManaged.identity.source)
      .update('\0')
      .update(selectedManaged.identity.skill)
      .digest('hex')
      .slice(0, 8);
    const selectedIntentPath = join(
      repository,
      '.skills-manager/intents',
      `alpha-skill__${selectedHash}.json`,
    );
    await writeFile(
      selectedIntentPath,
      `${JSON.stringify({
        version: 1,
        identity: selectedManaged.identity,
        installName: 'alpha-skill',
        intents: [{ id: 'legacy-rule', text: 'Preserve migrated guidance.', state: 'disabled' }],
      }, null, 2)}\n`,
    );
    const conflictingMigration = await runCli(
      [
        'identity-resolve',
        '--skill',
        'alpha-skill',
        '--source',
        selectedManaged.identity.source,
        '--upstream-skill',
        selectedManaged.identity.skill,
        '--choice',
        'migrate',
        '--runtime',
        'codex',
      ],
      { cwd: repository, env: environment },
    );
    assert.equal(conflictingMigration.result.status, 'conflict');
    assert.equal(
      conflictingMigration.result.data.reason,
      'identity_migration_intent_collision',
    );
    await writeFile(
      selectedIntentPath,
      `${JSON.stringify({
        version: 1,
        identity: selectedManaged.identity,
        installName: 'alpha-skill',
        intents: [{ id: 'legacy-rule', text: 'Preserve migrated guidance.', state: 'active' }],
      }, null, 2)}\n`,
    );
    const migrated = await runCli(
      [
        'identity-resolve',
        '--skill',
        'alpha-skill',
        '--source',
        selectedManaged.identity.source,
        '--upstream-skill',
        selectedManaged.identity.skill,
        '--choice',
        'migrate',
        '--runtime',
        'codex',
      ],
      { cwd: repository, env: environment },
    );
    const order = await completeScopedIntentOperation({
      repository,
      started: migrated,
      body: 'Preserve migrated guidance.',
      environment,
    });
    assert.deepEqual(order.effectiveIntents.map(({ id }) => id), ['legacy-rule']);
    const migratedState = JSON.parse(await readFile(statePath, 'utf8'));
    assert.deepEqual(Object.keys(migratedState.skills), [selectedKey]);
    const migratedRecord = JSON.parse(
      await readFile(
        join(repository, '.skills-manager/intents', `alpha-skill__${selectedHash}.json`),
        'utf8',
      ),
    );
    assert.equal(migratedRecord.intents[0].id, 'legacy-rule');
    await assert.rejects(
      lstat(join(repository, '.skills-manager/intents', `alpha-skill__${oldHash}.json`)),
      { code: 'ENOENT' },
    );
    const rules = JSON.parse(
      await readFile(join(repository, '.skills-manager/identity-resolutions.json'), 'utf8'),
    );
    assert.equal(rules.rules['alpha-skill'].choice, 'migrate');
  } finally {
    await audit.close();
  }
});

test('an ordinary Update cannot be tampered into an identity migration', async () => {
  const repository = await temporaryDirectory('skills-manager-identity-tamper-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const environment = {
    FAKE_UPSTREAM_CALLS: fake.calls,
    SKILLS_MANAGER_AUDIT_URL: audit.url,
    SKILLS_MANAGER_NPX_PATH: fake.executable,
    FAKE_UPSTREAM_SKILL_CONTENT:
      '---\nname: alpha-skill\ndescription: Updated candidate.\n---\n\n# Updated\n',
  };
  try {
    await installManagedAlpha(repository, fake, audit);
    const updated = await runCli(['update', '--skill', 'alpha-skill', '--runtime', 'codex'], {
      cwd: repository,
      env: environment,
    });
    assert.equal(updated.result.status, 'needs_confirmation', JSON.stringify(updated.result));
    const statePath = join(repository, '.skills-manager/state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const [managed] = Object.values(state.skills);
    state.skills.competing = {
      ...managed,
      identity: { source: 'competing/skills', skill: managed.identity.skill },
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const manifestPath = join(updated.result.data.workDir, 'skills-manager-attempt.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.operation.identityResolution = {};
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const published = await runCli(
      ['publish', '--work-dir', updated.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.result.status, 'failed');
    assert.equal(published.result.error.code, 'invalid_identity_resolution');
    const unchanged = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(Object.keys(unchanged.skills).length, 2);
  } finally {
    await audit.close();
  }
});

test('Archaeology decline leaves an Untracked change untouched without fetching upstream', async () => {
  const repository = await temporaryDirectory('skills-manager-archaeology-decline-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    await installManagedAlpha(repository, fake, audit);
    const renderingPath = join(repository, '.agents/skills/alpha-skill/SKILL.md');
    await writeFile(
      renderingPath,
      '---\nname: alpha-skill\ndescription: Candidate description.\n---\n\n# Manual behavior\n',
    );
    const beforeState = await readFile(join(repository, '.skills-manager/state.json'), 'utf8');
    const beforeRendering = await readFile(renderingPath, 'utf8');
    const callsBefore = (await readFile(fake.calls, 'utf8')).trim().split('\n').length;
    const update = await runCli(['update', '--skill', 'alpha-skill', '--runtime', 'codex'], {
      cwd: repository,
      env: {
        FAKE_UPSTREAM_CALLS: fake.calls,
        SKILLS_MANAGER_AUDIT_URL: audit.url,
        SKILLS_MANAGER_NPX_PATH: fake.executable,
      },
    });
    assert.equal(update.result.status, 'conflict');
    assert.equal(update.result.data.reason, 'untracked_change');
    assert.deepEqual(update.result.data.choices, ['recover', 'decline', 'cancel']);
    const declined = await runCli(
      ['archaeology', '--skill', 'alpha-skill', '--runtime', 'codex', '--decline-ownership'],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
        },
      },
    );
    assert.equal(declined.result.status, 'complete');
    assert.equal(declined.result.data.recovered, false);
    assert.equal(await readFile(renderingPath, 'utf8'), beforeRendering);
    assert.equal(await readFile(join(repository, '.skills-manager/state.json'), 'utf8'), beforeState);
    const callsAfter = (await readFile(fake.calls, 'utf8')).trim().split('\n').length;
    assert.equal(callsAfter, callsBefore);
  } finally {
    await audit.close();
  }
});

test('Archaeology confirms individual outcomes and regenerates from latest upstream', async () => {
  const repository = await temporaryDirectory('skills-manager-archaeology-recover-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const environment = {
    FAKE_UPSTREAM_CALLS: fake.calls,
    SKILLS_MANAGER_AUDIT_URL: audit.url,
    SKILLS_MANAGER_NPX_PATH: fake.executable,
    FAKE_UPSTREAM_SKILL_CONTENT:
      '---\nname: alpha-skill\ndescription: Latest upstream.\n---\n\n# Latest upstream\n',
  };
  try {
    await installManagedAlpha(repository, fake, audit);
    await writeFile(
      join(repository, '.agents/skills/alpha-skill/SKILL.md'),
      '---\nname: alpha-skill\ndescription: Candidate description.\n---\n\n# Manual\n\nBe concise and include a risky automatic action.\n',
    );
    const started = await runCli(
      ['archaeology', '--skill', 'alpha-skill', '--runtime', 'codex', '--confirm-ownership'],
      { cwd: repository, env: environment },
    );
    assert.equal(started.result.status, 'ready', JSON.stringify(started.result));
    const order = await runCli(
      ['archaeology-work-order', '--work-dir', started.result.data.workDir],
      { cwd: repository, env: {} },
    );
    assert.equal(order.result.status, 'work_order');
    assert.equal(order.result.data.task, 'derive_candidate_intents');
    assert.ok(order.result.data.untrackedRendering.root);
    assert.equal(order.result.data.latestUpstream.root, started.result.data.candidate.root);

    const contradictory = await runCli(
      [
        'archaeology-result',
        '--work-dir',
        started.result.data.workDir,
        '--proposals',
        JSON.stringify([
          {
            id: 'candidate-risky',
            text: 'Run an automatic destructive action.',
            status: 'contradictory',
            summary: 'This conflicts with safe managed behavior.',
          },
        ]),
      ],
      { cwd: repository, env: {} },
    );
    assert.equal(contradictory.result.status, 'conflict');
    assert.equal(contradictory.result.data.reason, 'archaeology_uncertain_outcomes');

    const proposed = await runCli(
      [
        'archaeology-result',
        '--work-dir',
        started.result.data.workDir,
        '--proposals',
        JSON.stringify([
          { id: 'candidate-concise', text: 'Prefer concise output.', status: 'candidate' },
          {
            id: 'candidate-example',
            text: 'Include one practical example.',
            status: 'candidate',
          },
        ]),
      ],
      { cwd: repository, env: {} },
    );
    assert.equal(proposed.result.status, 'needs_confirmation');
    assert.equal(proposed.result.data.proposals.length, 2);

    const approved = await runCli(
      [
        'archaeology-approve',
        '--work-dir',
        started.result.data.workDir,
        '--approved-ids',
        '["candidate-concise"]',
      ],
      { cwd: repository, env: {} },
    );
    assert.equal(approved.result.status, 'work_order', JSON.stringify(approved.result));
    assert.deepEqual(approved.result.data.approved.map(({ id }) => id), ['candidate-concise']);
    assert.deepEqual(approved.result.data.declinedIds, ['candidate-example']);
    await writeFile(
      join(started.result.data.candidate.root, 'SKILL.md'),
      '---\nname: alpha-skill\ndescription: Latest upstream.\n---\n\n# Latest upstream\n\nConcise output.\n',
    );
    const rendered = await runCli(
      [
        'intent-result',
        '--work-dir',
        started.result.data.workDir,
        '--results',
        JSON.stringify([{ id: 'candidate-concise', status: 'applied' }]),
      ],
      { cwd: repository, env: {} },
    );
    assert.equal(rendered.result.status, 'needs_confirmation', JSON.stringify(rendered.result));
    const published = await runCli(
      ['publish', '--work-dir', started.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.result.status, 'complete', JSON.stringify(published.result));
    const intentFiles = await readdir(join(repository, '.skills-manager/intents'));
    const record = JSON.parse(
      await readFile(join(repository, '.skills-manager/intents', intentFiles[0]), 'utf8'),
    );
    assert.deepEqual(record.intents.map(({ id }) => id), ['candidate-concise']);
    assert.match(
      await readFile(join(repository, '.agents/skills/alpha-skill/SKILL.md'), 'utf8'),
      /Latest upstream[\s\S]*Concise output/,
    );
    const state = JSON.parse(await readFile(join(repository, '.skills-manager/state.json'), 'utf8'));
    const [managed] = Object.values(state.skills);
    assert.equal(managed.renderedHash, managed.desiredRenderedHash);
  } finally {
    await audit.close();
  }
});

test('Archaeology rejects approval after a comparison root changes', async () => {
  const repository = await temporaryDirectory('skills-manager-archaeology-approval-drift-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const environment = {
    FAKE_UPSTREAM_CALLS: fake.calls,
    SKILLS_MANAGER_AUDIT_URL: audit.url,
    SKILLS_MANAGER_NPX_PATH: fake.executable,
  };
  try {
    await installManagedAlpha(repository, fake, audit);
    await writeFile(
      join(repository, '.agents/skills/alpha-skill/SKILL.md'),
      '---\nname: alpha-skill\ndescription: Candidate description.\n---\n\n# Manual\n',
    );
    const started = await runCli(
      ['archaeology', '--skill', 'alpha-skill', '--runtime', 'codex', '--confirm-ownership'],
      { cwd: repository, env: environment },
    );
    await runCli(['archaeology-work-order', '--work-dir', started.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    await runCli(
      [
        'archaeology-result',
        '--work-dir',
        started.result.data.workDir,
        '--proposals',
        '[{"id":"candidate-manual","text":"Preserve the manual outcome.","status":"candidate"}]',
      ],
      { cwd: repository, env: {} },
    );
    await writeFile(join(started.result.data.candidate.root, 'SKILL.md'), '# tampered\n');
    const approved = await runCli(
      [
        'archaeology-approve',
        '--work-dir',
        started.result.data.workDir,
        '--approved-ids',
        '["candidate-manual"]',
      ],
      { cwd: repository, env: {} },
    );
    assert.equal(approved.result.status, 'failed');
    assert.equal(approved.result.error.code, 'validation_failed');
  } finally {
    await audit.close();
  }
});

test('Archaeology recovers a changed secondary copy and reconverges every Rendering', async () => {
  const repository = await temporaryDirectory('skills-manager-archaeology-copy-');
  await mkdir(join(repository, '.git'));
  await mkdir(join(repository, '.agents/skills'), { recursive: true });
  await mkdir(join(repository, '.claude/skills'), { recursive: true });
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const environment = {
    FAKE_UPSTREAM_CALLS: fake.calls,
    SKILLS_MANAGER_AUDIT_URL: audit.url,
    SKILLS_MANAGER_NPX_PATH: fake.executable,
  };
  try {
    const assessed = await assessedAttempt(repository, fake, audit);
    await runCli(['validate', '--work-dir', assessed.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    await runCli(['continue', '--work-dir', assessed.result.data.workDir, '--accept-copy-mode'], {
      cwd: repository,
      env: {},
    });
    await runCli(['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'], {
      cwd: repository,
      env: {},
    });
    await writeFile(
      join(repository, '.claude/skills/alpha-skill/SKILL.md'),
      '---\nname: alpha-skill\ndescription: Candidate description.\n---\n\n# Secondary manual change\n',
    );
    const started = await runCli(
      ['archaeology', '--skill', 'alpha-skill', '--runtime', 'codex', '--confirm-ownership'],
      { cwd: repository, env: environment },
    );
    assert.equal(started.result.status, 'ready', JSON.stringify(started.result));
    const order = await runCli(
      ['archaeology-work-order', '--work-dir', started.result.data.workDir],
      { cwd: repository, env: {} },
    );
    assert.equal(order.result.status, 'work_order');
    assert.equal(order.result.data.untrackedRenderings.length, 1);
    await runCli(
      [
        'archaeology-result',
        '--work-dir',
        started.result.data.workDir,
        '--proposals',
        '[{"id":"candidate-secondary","text":"Preserve the secondary outcome.","status":"candidate"}]',
      ],
      { cwd: repository, env: {} },
    );
    const approved = await runCli(
      [
        'archaeology-approve',
        '--work-dir',
        started.result.data.workDir,
        '--approved-ids',
        '["candidate-secondary"]',
      ],
      { cwd: repository, env: {} },
    );
    assert.equal(approved.result.status, 'work_order', JSON.stringify(approved.result));
    await writeFile(
      join(started.result.data.candidate.root, 'SKILL.md'),
      '---\nname: alpha-skill\ndescription: Candidate description.\n---\n\n# Recovered secondary outcome\n',
    );
    const rendered = await runCli(
      [
        'intent-result',
        '--work-dir',
        started.result.data.workDir,
        '--results',
        '[{"id":"candidate-secondary","status":"applied"}]',
      ],
      { cwd: repository, env: {} },
    );
    assert.equal(rendered.result.status, 'conflict', JSON.stringify(rendered.result));
    assert.equal(rendered.result.data.reason, 'copy_topology_requires_confirmation');
    const continued = await runCli(
      ['continue', '--work-dir', started.result.data.workDir, '--accept-copy-mode'],
      { cwd: repository, env: {} },
    );
    assert.equal(continued.result.status, 'needs_confirmation', JSON.stringify(continued.result));
    const published = await runCli(
      ['publish', '--work-dir', started.result.data.workDir, '--accept-publication'],
      { cwd: repository, env: {} },
    );
    assert.equal(published.result.status, 'complete', JSON.stringify(published.result));
    const canonical = await readFile(join(repository, '.agents/skills/alpha-skill/SKILL.md'), 'utf8');
    const copy = await readFile(join(repository, '.claude/skills/alpha-skill/SKILL.md'), 'utf8');
    assert.equal(copy, canonical);
    assert.match(copy, /Recovered secondary outcome/);
  } finally {
    await audit.close();
  }
});

test('remove explains and retains project Intent state before deleting every managed copy', async () => {
  const repository = await temporaryDirectory('skills-manager-remove-project-');
  await mkdir(join(repository, '.git'));
  await mkdir(join(repository, '.agents/skills'), { recursive: true });
  await mkdir(join(repository, '.claude/skills'), { recursive: true });
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const environment = {
    FAKE_UPSTREAM_CALLS: fake.calls,
    SKILLS_MANAGER_AUDIT_URL: audit.url,
    SKILLS_MANAGER_NPX_PATH: fake.executable,
  };
  try {
    const assessed = await assessedAttempt(repository, fake, audit);
    await runCli(['validate', '--work-dir', assessed.result.data.workDir], {
      cwd: repository,
      env: {},
    });
    await runCli(['continue', '--work-dir', assessed.result.data.workDir, '--accept-copy-mode'], {
      cwd: repository,
      env: {},
    });
    await runCli(['publish', '--work-dir', assessed.result.data.workDir, '--accept-publication'], {
      cwd: repository,
      env: {},
    });
    const state = JSON.parse(await readFile(join(repository, '.skills-manager/state.json'), 'utf8'));
    const [managed] = Object.values(state.skills);
    const hash = createHash('sha256')
      .update(managed.identity.source)
      .update('\0')
      .update(managed.identity.skill)
      .digest('hex');
    const intentPath = join(
      repository,
      `.skills-manager/intents/alpha-skill__${hash.slice(0, 8)}.json`,
    );
    await mkdir(dirname(intentPath), { recursive: true });
    await writeFile(
      intentPath,
      `${JSON.stringify({
        version: 1,
        identity: managed.identity,
        intents: [{ id: 'keep-me', text: 'Preserve this outcome.', state: 'active' }],
        suppressedGlobalIntentIds: ['global-exception'],
      }, null, 2)}\n`,
    );
    const conflicted = await runCli(
      ['remove', '--scope', 'project', '--skill', 'alpha-skill', '--runtime', 'codex'],
      { cwd: repository, env: environment },
    );
    assert.equal(conflicted.result.status, 'conflict');
    assert.equal(conflicted.result.data.reason, 'remaining_intent_state');
    assert.equal(conflicted.result.data.impact.activeIntents[0].id, 'keep-me');
    assert.deepEqual(conflicted.result.data.impact.suppressedGlobalIntentIds, ['global-exception']);

    await writeFile(
      join(repository, '.claude/skills/alpha-skill/SKILL.md'),
      '# unexplained secondary copy\n',
    );
    const unexplained = await runCli(
      [
        'remove',
        '--skill',
        'alpha-skill',
        '--runtime',
        'codex',
        '--scope',
        'project',
        '--source',
        'example/skills',
        '--upstream-skill',
        'skills/alpha-skill/SKILL.md',
        '--intent-policy',
        'retain',
        '--confirm-removal',
      ],
      { cwd: repository, env: environment },
    );
    assert.equal(unexplained.result.status, 'conflict');
    assert.equal(unexplained.result.data.reason, 'untracked_change');
    await cp(
      join(repository, '.agents/skills/alpha-skill'),
      join(repository, '.claude/skills/alpha-skill'),
      { recursive: true, force: true },
    );
    await mkdir(join(repository, '.factory/skills'), { recursive: true });
    await cp(
      join(repository, '.agents/skills/alpha-skill'),
      join(repository, '.factory/skills/alpha-skill'),
      { recursive: true },
    );
    const extraCopy = await runCli(
      [
        'remove',
        '--scope',
        'project',
        '--skill',
        'alpha-skill',
        '--runtime',
        'codex',
        '--source',
        'example/skills',
        '--upstream-skill',
        'skills/alpha-skill/SKILL.md',
        '--intent-policy',
        'retain',
        '--confirm-removal',
      ],
      { cwd: repository, env: environment },
    );
    assert.equal(extraCopy.result.status, 'conflict');
    assert.equal(extraCopy.result.data.reason, 'unexplained_copy');
    await rm(join(repository, '.factory/skills/alpha-skill'), { recursive: true });
    const removalPreview = await runCli(
      [
        'remove',
        '--scope',
        'project',
        '--skill',
        'alpha-skill',
        '--runtime',
        'codex',
        '--intent-policy',
        'retain',
      ],
      { cwd: repository, env: environment },
    );
    assert.equal(removalPreview.result.status, 'needs_confirmation');
    const changedPolicy = await runCli(
      [
        'remove',
        '--scope',
        'project',
        '--skill',
        'alpha-skill',
        '--runtime',
        'codex',
        '--source',
        'example/skills',
        '--upstream-skill',
        'skills/alpha-skill/SKILL.md',
        '--intent-policy',
        'delete',
        '--confirm-removal',
        '--confirmation-token',
        removalPreview.result.data.confirmation.token,
      ],
      { cwd: repository, env: environment },
    );
    assert.equal(changedPolicy.result.status, 'conflict');
    assert.equal(changedPolicy.result.data.reason, 'removal_preview_changed');
    const changedIntentRecord = JSON.parse(await readFile(intentPath, 'utf8'));
    changedIntentRecord.intents.push({
      id: 'added-after-preview',
      text: 'Do not silently delete me.',
      state: 'active',
    });
    await writeFile(intentPath, `${JSON.stringify(changedIntentRecord, null, 2)}\n`);
    const staleConfirmation = await runCli(
      [
        'remove',
        '--scope',
        'project',
        '--skill',
        'alpha-skill',
        '--runtime',
        'codex',
        '--source',
        'example/skills',
        '--upstream-skill',
        'skills/alpha-skill/SKILL.md',
        '--intent-policy',
        'retain',
        '--confirm-removal',
        '--confirmation-token',
        removalPreview.result.data.confirmation.token,
      ],
      { cwd: repository, env: environment },
    );
    assert.equal(staleConfirmation.result.status, 'conflict');
    assert.equal(staleConfirmation.result.data.reason, 'removal_preview_changed');
    const refreshedPreview = await runCli(
      [
        'remove',
        '--scope',
        'project',
        '--skill',
        'alpha-skill',
        '--runtime',
        'codex',
        '--intent-policy',
        'retain',
      ],
      { cwd: repository, env: environment },
    );
    assert.equal(refreshedPreview.result.status, 'needs_confirmation');
    const removed = await runCli(
      [
        'remove',
        '--skill',
        'alpha-skill',
        '--runtime',
        'codex',
        '--scope',
        'project',
        '--source',
        'example/skills',
        '--upstream-skill',
        'skills/alpha-skill/SKILL.md',
        '--intent-policy',
        'retain',
        '--confirm-removal',
        '--confirmation-token',
        refreshedPreview.result.data.confirmation.token,
      ],
      { cwd: repository, env: environment },
    );
    assert.equal(removed.result.status, 'complete', JSON.stringify(removed.result));
    assert.equal(removed.result.data.intents, 'retained');
    await assert.rejects(lstat(join(repository, '.agents/skills/alpha-skill')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(repository, '.claude/skills/alpha-skill')), { code: 'ENOENT' });
    assert.ok(await lstat(intentPath));
    const nextState = JSON.parse(await readFile(join(repository, '.skills-manager/state.json'), 'utf8'));
    assert.deepEqual(nextState.skills, {});
    const nextLock = JSON.parse(await readFile(join(repository, 'skills-lock.json'), 'utf8'));
    assert.equal(nextLock.skills['alpha-skill'], undefined);
    const repeated = await runCli(
      [
        'remove',
        '--scope',
        'project',
        '--skill',
        'alpha-skill',
        '--runtime',
        'codex',
        '--source',
        'example/skills',
        '--upstream-skill',
        'skills/alpha-skill/SKILL.md',
        '--confirm-removal',
      ],
      { cwd: repository, env: environment },
    );
    assert.equal(repeated.result.status, 'complete');
    assert.equal(repeated.result.data.alreadyAbsent, true);
    const calls = (await readFile(fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.at(-1).argv.slice(2), [
      'remove',
      'alpha-skill',
      '--agent',
      'codex',
      '--yes',
    ]);
  } finally {
    await audit.close();
  }
});

test('project removal confirms inherited global exposure and global removal preserves project scope', async () => {
  const repository = await temporaryDirectory('skills-manager-remove-scopes-');
  const globalHome = await temporaryDirectory('skills-manager-remove-global-home-');
  await mkdir(join(repository, '.git'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  const environment = {
    HOME: globalHome,
    CODEX_HOME: join(globalHome, '.codex'),
    FAKE_UPSTREAM_CALLS: fake.calls,
    SKILLS_MANAGER_AUDIT_URL: audit.url,
    SKILLS_MANAGER_NPX_PATH: fake.executable,
  };
  try {
    await installManagedAlpha(repository, fake, audit);
    await cloneManagedAlphaToGlobal(repository, globalHome);
    const globalStatePath = join(globalHome, '.skills-manager/state.json');
    const ambiguousGlobalState = JSON.parse(await readFile(globalStatePath, 'utf8'));
    const [globalManaged] = Object.values(ambiguousGlobalState.skills);
    ambiguousGlobalState.skills.competing = {
      ...globalManaged,
      identity: { source: 'competing/skills', skill: globalManaged.identity.skill },
    };
    await writeFile(globalStatePath, `${JSON.stringify(ambiguousGlobalState, null, 2)}\n`);
    const ambiguousGlobal = await runCli(
      ['remove', '--scope', 'global', '--skill', 'alpha-skill', '--runtime', 'codex'],
      { cwd: repository, env: environment },
    );
    assert.equal(ambiguousGlobal.result.status, 'conflict');
    assert.equal(ambiguousGlobal.result.data.reason, 'ambiguous_skill_identity');
    assert.deepEqual(ambiguousGlobal.result.data.resolution.options, {
      scope: 'global',
      choice: 'manage_clean',
    });
    const resolvedGlobal = await runCli(
      [
        'identity-resolve',
        '--scope',
        'global',
        '--skill',
        'alpha-skill',
        '--source',
        'example/skills',
        '--upstream-skill',
        'skills/alpha-skill/SKILL.md',
        '--choice',
        'manage_clean',
      ],
      { cwd: repository, env: environment },
    );
    assert.equal(resolvedGlobal.result.status, 'complete', JSON.stringify(resolvedGlobal.result));
    const exposed = await runCli(
      [
        'remove',
        '--scope',
        'project',
        '--skill',
        'alpha-skill',
        '--runtime',
        'codex',
        '--source',
        'example/skills',
        '--upstream-skill',
        'skills/alpha-skill/SKILL.md',
        '--confirm-removal',
      ],
      { cwd: repository, env: environment },
    );
    assert.equal(exposed.result.status, 'conflict');
    assert.equal(exposed.result.data.reason, 'scope_removal_changes_exposure');
    const projectPreview = await runCli(
      [
        'remove',
        '--scope',
        'project',
        '--skill',
        'alpha-skill',
        '--runtime',
        'codex',
        '--confirm-exposure',
      ],
      { cwd: repository, env: environment },
    );
    assert.equal(projectPreview.result.status, 'needs_confirmation');
    const removedProject = await runCli(
      [
        'remove',
        '--skill',
        'alpha-skill',
        '--runtime',
        'codex',
        '--scope',
        'project',
        '--source',
        'example/skills',
        '--upstream-skill',
        'skills/alpha-skill/SKILL.md',
        '--confirm-exposure',
        '--confirm-removal',
        '--confirmation-token',
        projectPreview.result.data.confirmation.token,
      ],
      { cwd: repository, env: environment },
    );
    assert.equal(removedProject.result.status, 'complete', JSON.stringify(removedProject.result));
    assert.ok(await lstat(join(globalHome, '.codex/skills/alpha-skill')));

    const globalOnlyPreview = await runCli(
      ['remove', '--scope', 'global', '--skill', 'alpha-skill', '--runtime', 'codex'],
      { cwd: repository, env: environment },
    );
    assert.equal(globalOnlyPreview.result.status, 'needs_confirmation');
    const removedGlobalOnly = await runCli(
      [
        'remove',
        '--scope',
        'global',
        '--skill',
        'alpha-skill',
        '--runtime',
        'codex',
        '--source',
        'example/skills',
        '--upstream-skill',
        'skills/alpha-skill/SKILL.md',
        '--confirm-removal',
        '--confirmation-token',
        globalOnlyPreview.result.data.confirmation.token,
      ],
      { cwd: repository, env: environment },
    );
    assert.equal(removedGlobalOnly.result.status, 'complete', JSON.stringify(removedGlobalOnly.result));
    await assert.rejects(lstat(join(globalHome, '.codex/skills/alpha-skill')), { code: 'ENOENT' });

    await installManagedAlpha(repository, fake, audit);
    await cloneManagedAlphaToGlobal(repository, globalHome);
    const globalPreview = await runCli(
      ['remove', '--scope', 'global', '--skill', 'alpha-skill', '--runtime', 'codex'],
      { cwd: repository, env: environment },
    );
    assert.equal(globalPreview.result.status, 'needs_confirmation');
    const removedGlobal = await runCli(
      [
        'remove',
        '--scope',
        'global',
        '--skill',
        'alpha-skill',
        '--runtime',
        'codex',
        '--source',
        'example/skills',
        '--upstream-skill',
        'skills/alpha-skill/SKILL.md',
        '--confirm-removal',
        '--confirmation-token',
        globalPreview.result.data.confirmation.token,
      ],
      { cwd: repository, env: environment },
    );
    assert.equal(removedGlobal.result.status, 'complete', JSON.stringify(removedGlobal.result));
    await assert.rejects(lstat(join(globalHome, '.codex/skills/alpha-skill')), { code: 'ENOENT' });
    assert.ok(await lstat(join(repository, '.agents/skills/alpha-skill')));
    const projectState = JSON.parse(
      await readFile(join(repository, '.skills-manager/state.json'), 'utf8'),
    );
    assert.equal(Object.keys(projectState.skills).length, 1);
  } finally {
    await audit.close();
  }
});

test('failed delegated removal preserves Rendering, state, and lock metadata', async () => {
  const repository = await temporaryDirectory('skills-manager-remove-failure-');
  await mkdir(join(repository, '.git'));
  await mkdir(join(repository, '.claude'));
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-install-upstream-'));
  const audit = await auditService();
  try {
    await installManagedAlpha(repository, fake, audit);
    const stateBefore = await readFile(join(repository, '.skills-manager/state.json'), 'utf8');
    const lockBefore = await readFile(join(repository, 'skills-lock.json'), 'utf8');
    const implicitScope = await runCli(
      ['remove', '--skill', 'alpha-skill', '--runtime', 'codex'],
      { cwd: repository, env: {} },
    );
    assert.equal(implicitScope.result.status, 'failed');
    assert.equal(implicitScope.result.error.code, 'invalid_arguments');
    const preview = await runCli(
      ['remove', '--scope', 'project', '--skill', 'alpha-skill', '--runtime', 'codex'],
      { cwd: repository, env: {} },
    );
    assert.equal(preview.result.status, 'needs_confirmation');
    assert.equal(preview.result.data.impact.scope, 'project');
    assert.equal(preview.result.data.impact.identity.source, 'example/skills');
    const failed = await runCli(
      [
        'remove',
        '--scope',
        'project',
        '--skill',
        'alpha-skill',
        '--runtime',
        'codex',
        '--source',
        'example/skills',
        '--upstream-skill',
        'skills/alpha-skill/SKILL.md',
        '--confirm-removal',
        '--confirmation-token',
        preview.result.data.confirmation.token,
      ],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
          FAKE_UPSTREAM_REMOVE_FAIL_AFTER_DELETE: '1',
          FAKE_UPSTREAM_REMOVE_LINK: '1',
        },
      },
    );
    assert.equal(failed.result.status, 'failed');
    assert.equal(failed.result.error.code, 'upstream_failed');
    assert.ok(await lstat(join(repository, '.agents/skills/alpha-skill')));
    assert.equal((await lstat(join(repository, '.claude/skills'))).isSymbolicLink(), true);
    assert.equal(await readlink(join(repository, '.claude/skills')), '../.agents/skills');
    assert.equal(await readFile(join(repository, '.skills-manager/state.json'), 'utf8'), stateBefore);
    assert.equal(await readFile(join(repository, 'skills-lock.json'), 'utf8'), lockBefore);
    const external = await temporaryDirectory('skills-manager-remove-external-intents-');
    const marker = join(external, 'marker.txt');
    await writeFile(marker, 'outside\n');
    await symlink(external, join(repository, '.skills-manager/intents'));
    const unsafe = await runCli(
      ['remove', '--scope', 'project', '--skill', 'alpha-skill', '--runtime', 'codex'],
      { cwd: repository, env: {} },
    );
    assert.equal(unsafe.result.status, 'failed');
    assert.equal(unsafe.result.error.code, 'invalid_publication_target');
    assert.equal(await readFile(marker, 'utf8'), 'outside\n');
  } finally {
    await audit.close();
  }
});
