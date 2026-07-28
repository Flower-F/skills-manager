import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

async function installManagedAlpha(repository, fake, audit) {
  const assessed = await assessedAttempt(repository, fake, audit);
  await runCli(['validate', '--work-dir', assessed.result.data.workDir], { cwd: repository, env: {} });
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
      createHash('sha256').update(JSON.stringify(intentRecord.intents)).digest('hex'),
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
    const resulted = await runCli(
      ['intent-result', '--work-dir', begun.result.data.workDir, '--result', 'applied'],
      { cwd: repository, env: {} },
    );
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
  await runCli(['work-order', '--work-dir', begun.result.data.workDir], {
    cwd: repository,
    env: {},
  });
  await writeFile(
    join(begun.result.data.candidate.root, 'SKILL.md'),
    `---\nname: alpha-skill\ndescription: Candidate description.\n---\n\n${body}\n`,
  );
  await runCli(
    ['intent-result', '--work-dir', begun.result.data.workDir, '--result', 'applied'],
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
    assert.equal(updated.exitCode, 1);
    assert.equal(updated.result.error.code, 'untracked_change');
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
    assert.equal(obsolete.result.status, 'conflict');
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
