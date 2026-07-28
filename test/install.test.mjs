import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const cli = resolve('skills/skills-manager/scripts/skills-manager.mjs');

async function temporaryDirectory(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function fakeUpstream(workspace) {
  const executable = join(workspace, 'fake-npx.mjs');
  const calls = join(workspace, 'calls.jsonl');
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
await appendFile(process.env.FAKE_UPSTREAM_CALLS, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  telemetry: process.env.DISABLE_TELEMETRY ?? null,
}) + '\\n');
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
