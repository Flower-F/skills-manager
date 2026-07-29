import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { TEST_RUNTIME } from './constants.mjs';

const cli = resolve('skills/skills-manager/scripts/skills-manager.mjs');

async function temporaryDirectory(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function fakeUpstream(workspace) {
  const executable = join(workspace, 'fake-npx.mjs');
  const calls = join(workspace, 'calls.jsonl');
  const listOutput = `│
◇  Available Skills
│
│    alpha-skill
│
│      Alpha must remain private before assessment.
│
│    beta-skill
│
│      Beta must remain private before assessment.
│
└  Use --skill <name> to install specific skills
`;
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { appendFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await appendFile(process.env.FAKE_UPSTREAM_CALLS, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  telemetry: process.env.DISABLE_TELEMETRY ?? null,
}) + '\\n');
if (process.argv.includes('--list')) process.stdout.write(process.env.FAKE_UPSTREAM_LIST_OUTPUT ?? ${JSON.stringify(listOutput)});
else {
  if (process.env.FAKE_UPSTREAM_FAIL === '1') process.exit(7);
  const skill = process.argv[process.argv.indexOf('--skill') + 1];
  const runtime = process.argv[process.argv.indexOf('--agent') + 1];
  const directory = runtime === 'claude-code' ? '.claude/skills/' : '.agents/skills/';
  const skillRoot = new URL('./' + directory + skill, 'file://' + process.cwd() + '/');
  await mkdir(new URL('.', skillRoot), { recursive: true });
  if (process.env.FAKE_UPSTREAM_SYMLINK_TARGET) {
    await symlink(process.env.FAKE_UPSTREAM_SYMLINK_TARGET, skillRoot, 'dir');
  } else {
    await mkdir(skillRoot, { recursive: true });
    const content = process.env.FAKE_UPSTREAM_SKILL_CONTENT ?? '---\\nname: ' + skill + '\\ndescription: Candidate description.\\n---\\n';
    await writeFile(new URL('./SKILL.md', skillRoot.href + '/'), content);
    const source = process.argv[process.argv.indexOf('add') + 1];
    const computedHash = createHash('sha256').update('SKILL.md').update(content).digest('hex');
    await writeFile(new URL('./skills-lock.json', 'file://' + process.cwd() + '/'), JSON.stringify({
      version: 1,
      skills: {
        [skill]: {
          source,
          sourceType: 'github',
          skillPath: 'skills/' + skill + '/SKILL.md',
          computedHash,
        },
      },
    }, null, 2) + '\\n');
  }
}
`,
  );
  await chmod(executable, 0o755);
  return { executable, calls };
}

async function auditService(responseBody, options = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    setTimeout(() => {
      response.statusCode = options.status || 200;
      response.setHeader('content-type', 'application/json');
      response.end(options.rawBody ?? JSON.stringify(responseBody));
    }, options.delayMilliseconds || 0);
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  return {
    requests,
    url: `http://127.0.0.1:${address.port}/audit`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function unavailableAuditUrl() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return `http://127.0.0.1:${port}/audit`;
}

test('assess classifies malformed, timed-out, and failed audit responses for confirmation', async (t) => {
  const scenarios = [
    {
      name: 'malformed response',
      auditOptions: { rawBody: '{' },
      expectedCode: 'malformed_response',
    },
    {
      name: 'timeout',
      auditOptions: { delayMilliseconds: 80 },
      timeoutMilliseconds: '10',
      expectedCode: 'timeout',
    },
    {
      name: 'request failure',
      auditOptions: { status: 503 },
      expectedCode: 'request_failed',
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const repository = await temporaryDirectory('skills-manager-audit-failure-repository-');
      const fake = await fakeUpstream(await temporaryDirectory('skills-manager-fake-upstream-'));
      const audit = await auditService({}, scenario.auditOptions);
      try {
        const invocation = await runCli(
          [
            'assess',
            '--source',
            'example/skills',
            '--skill',
            'alpha-skill',
            '--runtime',
            TEST_RUNTIME,
          ],
          {
            cwd: repository,
            env: {
              FAKE_UPSTREAM_CALLS: fake.calls,
              SKILLS_MANAGER_AUDIT_TIMEOUT_MS: scenario.timeoutMilliseconds,
              SKILLS_MANAGER_AUDIT_URL: audit.url,
              SKILLS_MANAGER_NPX_PATH: fake.executable,
            },
          },
        );
        assert.equal(invocation.exitCode, 0);
        assert.equal(invocation.result.status, 'needs_confirmation');
        assert.deepEqual(invocation.result.data.security.reasons, [
          { provider: 'audit', code: scenario.expectedCode },
        ]);
      } finally {
        await audit.close();
      }
    });
  }
});

test('assess reports structured reasons for unknown and missing security results', async () => {
  const repository = await temporaryDirectory('skills-manager-unknown-audit-repository-');
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-fake-upstream-'));
  const audit = await auditService({
    'alpha-skill': {
      ath: { risk: 'mystery' },
    },
  });

  try {
    const invocation = await runCli(
      [
        'assess',
        '--source',
        'example/skills',
        '--skill',
        'alpha-skill',
        '--runtime',
        TEST_RUNTIME,
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

    assert.equal(invocation.exitCode, 0);
    assert.equal(invocation.result.status, 'needs_confirmation');
    assert.deepEqual(invocation.result.data.security.reasons, [
      { provider: 'gen', code: 'unknown_rating', value: 'mystery' },
      { provider: 'socket', code: 'missing_or_invalid' },
      { provider: 'snyk', code: 'missing' },
    ]);
  } finally {
    await audit.close();
  }
});

test('assess treats a connection failure as confirmation without exposing the candidate', async () => {
  const repository = await temporaryDirectory('skills-manager-connection-failure-repository-');
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-fake-upstream-'));
  const invocation = await runCli(
    ['assess', '--source', 'example/skills', '--skill', 'alpha-skill', '--runtime', TEST_RUNTIME],
    {
      cwd: repository,
      env: {
        FAKE_UPSTREAM_CALLS: fake.calls,
        SKILLS_MANAGER_AUDIT_URL: await unavailableAuditUrl(),
        SKILLS_MANAGER_NPX_PATH: fake.executable,
      },
    },
  );

  assert.equal(invocation.exitCode, 0);
  assert.equal(invocation.result.status, 'needs_confirmation');
  assert.equal(invocation.result.data.candidate, undefined);
  assert.deepEqual(invocation.result.data.security.reasons, [
    { provider: 'audit', code: 'request_failed' },
  ]);
});

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

test('discover returns candidate identifiers through the JSON protocol using the pinned upstream CLI', async () => {
  const repository = await temporaryDirectory('skills-manager-discover-repository-');
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-fake-upstream-'));

  const invocation = await runCli(
    ['discover', '--source', 'example/skills', '--runtime', TEST_RUNTIME],
    {
      cwd: repository,
      env: {
        FAKE_UPSTREAM_CALLS: fake.calls,
        SKILLS_MANAGER_NPX_PATH: fake.executable,
      },
    },
  );

  assert.equal(invocation.exitCode, 0);
  assert.equal(invocation.stderr, '');
  assert.deepEqual(invocation.result, {
    version: 1,
    status: 'ready',
    command: 'discover',
    data: {
      source: 'example/skills',
      candidates: [{ id: 'alpha-skill' }, { id: 'beta-skill' }],
      compatibility: { skillsCli: '1.5.20' },
    },
  });
  assert.doesNotMatch(JSON.stringify(invocation.result), /must remain private/);

  const calls = (await readFile(fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [
    {
      argv: ['-y', 'skills@1.5.20', 'add', 'example/skills', '--list'],
      cwd: calls[0].cwd,
      telemetry: '1',
    },
  ]);
  assert.notEqual(calls[0].cwd, repository);
});

test('discover fails closed when the pinned upstream list format drifts', async () => {
  const repository = await temporaryDirectory('skills-manager-drift-repository-');
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-fake-upstream-'));

  const invocation = await runCli(
    ['discover', '--source', 'example/skills', '--runtime', TEST_RUNTIME],
    {
      cwd: repository,
      env: {
        FAKE_UPSTREAM_CALLS: fake.calls,
        FAKE_UPSTREAM_LIST_OUTPUT: 'A changed format containing a private description.',
        SKILLS_MANAGER_NPX_PATH: fake.executable,
      },
    },
  );

  assert.equal(invocation.exitCode, 1);
  assert.equal(invocation.result.status, 'failed');
  assert.equal(invocation.result.error.code, 'upstream_failed');
  assert.doesNotMatch(JSON.stringify(invocation.result), /private description/);
  assert.deepEqual(await readdir(repository), []);
});

test('commands reject options that do not apply to their protocol', async () => {
  const repository = await temporaryDirectory('skills-manager-invalid-options-repository-');
  const invocation = await runCli(
    ['discover', '--source', 'example/skills', '--runtime', TEST_RUNTIME, '--accept-risk'],
    { cwd: repository, env: {} },
  );

  assert.equal(invocation.exitCode, 1);
  assert.equal(invocation.result.status, 'failed');
  assert.equal(invocation.result.error.code, 'invalid_arguments');
});

test('assess acquires a safe candidate outside the workspace and returns a normalized decision', async () => {
  const repository = await temporaryDirectory('skills-manager-assess-repository-');
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-fake-upstream-'));
  const audit = await auditService({
    'alpha-skill': {
      ath: { risk: 'safe' },
      socket: { alerts: 0 },
      snyk: { risk: 'low' },
    },
  });
  const before = await readdir(repository);

  try {
    const invocation = await runCli(
      [
        'assess',
        '--source',
        'example/skills',
        '--skill',
        'alpha-skill',
        '--runtime',
        TEST_RUNTIME,
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

    assert.equal(invocation.exitCode, 0);
    assert.equal(invocation.result.status, 'ready');
    assert.equal(invocation.result.command, 'assess');
    assert.deepEqual(invocation.result.data.operation, {
      type: 'install',
      source: 'example/skills',
      skill: 'alpha-skill',
      runtime: TEST_RUNTIME,
      scope: 'project',
    });
    assert.deepEqual(invocation.result.data.security, {
      decision: 'approved',
      assessments: {
        gen: { rating: 'safe' },
        socket: { alerts: 0 },
        snyk: { rating: 'low' },
      },
      detailsUrl: 'https://skills.sh/example/skills',
    });
    assert.equal(
      invocation.result.data.candidate.root,
      join(invocation.result.data.workDir, '.agents/skills/alpha-skill'),
    );
    assert.equal(
      await readFile(join(invocation.result.data.candidate.root, 'SKILL.md'), 'utf8'),
      '---\nname: alpha-skill\ndescription: Candidate description.\n---\n',
    );
    assert.deepEqual(audit.requests, ['/audit?source=example%2Fskills&skills=alpha-skill']);
    assert.deepEqual(await readdir(repository), before);

    const calls = (await readFile(fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls[0].argv, [
      '-y',
      'skills@1.5.20',
      'add',
      'example/skills',
      '--skill',
      'alpha-skill',
      '--agent',
      TEST_RUNTIME,
      '--yes',
    ]);
    assert.equal(calls[0].telemetry, '1');
    assert.equal(calls[0].cwd, await realpath(invocation.result.data.workDir));
  } finally {
    await audit.close();
  }
});

test('assess locates candidates in the selected runtime project directory', async () => {
  const repository = await temporaryDirectory('skills-manager-runtime-candidate-repository-');
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-fake-upstream-'));
  const audit = await auditService({
    'alpha-skill': {
      ath: { risk: 'safe' },
      socket: { alerts: 0 },
      snyk: { risk: 'safe' },
    },
  });

  try {
    const invocation = await runCli(
      ['assess', '--source', 'example/skills', '--skill', 'alpha-skill', '--runtime', 'claude-code'],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
        },
      },
    );

    assert.equal(invocation.exitCode, 0);
    assert.equal(invocation.result.status, 'ready');
    assert.equal(
      invocation.result.data.candidate.root,
      join(invocation.result.data.workDir, '.claude/skills/alpha-skill'),
    );
  } finally {
    await audit.close();
  }
});

test('assess rejects and cleans up a candidate root that escapes through a symbolic link', async () => {
  const repository = await temporaryDirectory('skills-manager-symlink-repository-');
  const outside = await temporaryDirectory('skills-manager-outside-candidate-');
  await writeFile(join(outside, 'SKILL.md'), 'untrusted outside candidate');
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-fake-upstream-'));

  const invocation = await runCli(
    ['assess', '--source', 'example/skills', '--skill', 'alpha-skill', '--runtime', TEST_RUNTIME],
    {
      cwd: repository,
      env: {
        FAKE_UPSTREAM_CALLS: fake.calls,
        FAKE_UPSTREAM_SYMLINK_TARGET: outside,
        SKILLS_MANAGER_NPX_PATH: fake.executable,
      },
    },
  );

  assert.equal(invocation.exitCode, 1);
  assert.equal(invocation.result.status, 'failed');
  assert.equal(invocation.result.error.code, 'invalid_candidate');
  const [{ cwd }] = (await readFile(fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  await assert.rejects(lstat(cwd), { code: 'ENOENT' });
  assert.deepEqual(await readdir(repository), []);
});

test('assess cleans up its unreferenced Update attempt when upstream acquisition fails', async () => {
  const repository = await temporaryDirectory('skills-manager-upstream-failure-repository-');
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-fake-upstream-'));

  const invocation = await runCli(
    ['assess', '--source', 'example/skills', '--skill', 'alpha-skill', '--runtime', TEST_RUNTIME],
    {
      cwd: repository,
      env: {
        FAKE_UPSTREAM_CALLS: fake.calls,
        FAKE_UPSTREAM_FAIL: '1',
        SKILLS_MANAGER_NPX_PATH: fake.executable,
      },
    },
  );

  assert.equal(invocation.exitCode, 1);
  assert.equal(invocation.result.error.code, 'upstream_failed');
  const [{ cwd }] = (await readFile(fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  await assert.rejects(lstat(cwd), { code: 'ENOENT' });
});

test('assess returns needs_confirmation for a medium security rating without exposing the candidate', async () => {
  const repository = await temporaryDirectory('skills-manager-medium-repository-');
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-fake-upstream-'));
  const audit = await auditService({
    'alpha-skill': {
      ath: { risk: 'medium' },
      socket: { alerts: 0 },
      snyk: { risk: 'safe' },
    },
  });

  try {
    const invocation = await runCli(
      [
        'assess',
        '--source',
        'example/skills',
        '--skill',
        'alpha-skill',
        '--runtime',
        TEST_RUNTIME,
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

    assert.equal(invocation.exitCode, 0);
    assert.equal(invocation.result.status, 'needs_confirmation');
    assert.equal(invocation.result.command, 'assess');
    assert.equal(invocation.result.data.candidate, undefined);
    assert.deepEqual(invocation.result.data.security.assessments, {
      gen: { rating: 'medium' },
      socket: { alerts: 0 },
      snyk: { rating: 'safe' },
    });
    assert.equal(
      invocation.result.data.security.explanation,
      'Security confirmation required: Gen rating is medium.',
    );
    assert.doesNotMatch(JSON.stringify(invocation.result), /Candidate description/);
    assert.deepEqual(await readdir(repository), []);
  } finally {
    await audit.close();
  }
});

test('continue accepts risk only for the exact proposed operation in its disposable work directory', async () => {
  const repository = await temporaryDirectory('skills-manager-continue-repository-');
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-fake-upstream-'));
  const audit = await auditService({
    'alpha-skill': {
      ath: { risk: 'high' },
      socket: { alerts: 1 },
      snyk: { risk: 'safe' },
    },
  });

  try {
    const assessed = await runCli(
      [
        'assess',
        '--source',
        'example/skills',
        '--skill',
        'alpha-skill',
        '--runtime',
        TEST_RUNTIME,
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
    assert.equal(assessed.result.status, 'needs_confirmation');

    const continued = await runCli(
      ['continue', '--work-dir', assessed.result.data.workDir, '--accept-risk'],
      { cwd: repository, env: { FAKE_UPSTREAM_CALLS: fake.calls } },
    );

    assert.equal(continued.exitCode, 0);
    assert.equal(continued.result.status, 'ready');
    assert.equal(continued.result.command, 'continue');
    assert.equal(continued.result.data.workDir, assessed.result.data.workDir);
    assert.deepEqual(continued.result.data.operation, assessed.result.data.operation);
    assert.deepEqual(continued.result.data.security.assessments, {
      gen: { rating: 'high' },
      socket: { alerts: 1 },
      snyk: { rating: 'safe' },
    });
    assert.equal(continued.result.data.security.decision, 'accepted');
    assert.equal(continued.result.data.security.riskAccepted, true);
    assert.equal(
      continued.result.data.candidate.root,
      join(assessed.result.data.workDir, '.agents/skills/alpha-skill'),
    );

    const calls = (await readFile(fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 1);
    assert.deepEqual(await readdir(repository), []);
  } finally {
    await audit.close();
  }
});

test('abort removes a rejected candidate attempt without changing the workspace', async () => {
  const repository = await temporaryDirectory('skills-manager-abort-repository-');
  const fake = await fakeUpstream(await temporaryDirectory('skills-manager-fake-upstream-'));
  const audit = await auditService({
    'alpha-skill': {
      ath: { risk: 'critical' },
      socket: { alerts: 0 },
      snyk: { risk: 'safe' },
    },
  });

  try {
    const assessed = await runCli(
      ['assess', '--source', 'example/skills', '--skill', 'alpha-skill', '--runtime', TEST_RUNTIME],
      {
        cwd: repository,
        env: {
          FAKE_UPSTREAM_CALLS: fake.calls,
          SKILLS_MANAGER_AUDIT_URL: audit.url,
          SKILLS_MANAGER_NPX_PATH: fake.executable,
        },
      },
    );
    assert.equal(assessed.result.status, 'needs_confirmation');

    const aborted = await runCli(
      ['abort', '--work-dir', assessed.result.data.workDir],
      { cwd: repository, env: {} },
    );

    assert.equal(aborted.exitCode, 0);
    assert.deepEqual(aborted.result, {
      version: 1,
      status: 'complete',
      command: 'abort',
      data: { operation: assessed.result.data.operation },
    });
    await assert.rejects(lstat(assessed.result.data.workDir), { code: 'ENOENT' });
    assert.deepEqual(await readdir(repository), []);
  } finally {
    await audit.close();
  }
});
