import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readlink, readdir, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const cli = resolve('skills/skills-manager/scripts/skills-manager.mjs');

async function temporaryDirectory(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function runCli(args, options = {}) {
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
  return { exitCode, stdout, stderr, result: JSON.parse(stdout) };
}

async function tree(root) {
  const entries = [];
  async function walk(relative = '.') {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isSymbolicLink()) {
        entries.push([path, 'symbolic_link', await readlink(join(root, path))]);
      } else if (entry.isDirectory()) {
        entries.push([path, 'directory']);
        await walk(path);
      } else {
        entries.push([path, 'file']);
      }
    }
  }
  await walk();
  return entries;
}

test('inspect defaults to project scope and falls back only to the current runtime', async () => {
  const repository = await temporaryDirectory('skills-manager-empty-');
  const before = await tree(repository);

  const invocation = await runCli(['inspect', '--runtime', 'codex'], { cwd: repository });

  assert.equal(invocation.exitCode, 0);
  assert.equal(invocation.stderr, '');
  assert.deepEqual(invocation.result, {
    version: 1,
    status: 'ready',
    command: 'inspect',
    data: {
      repositoryRoot: repository,
      scope: 'project',
      currentRuntime: 'codex',
      compatibility: {
        node: { minimumMajor: 22, current: process.versions.node },
        skillsCli: { version: '1.5.20', telemetryDisabled: true },
        runtimeRegistry: 1,
      },
      topology: 'empty',
      runtimes: [
        {
          id: 'codex',
          skillsDirectory: join(repository, '.agents/skills'),
          relativeSkillsDirectory: '.agents/skills',
          evidence: ['current_runtime'],
          target: 0,
        },
      ],
      targets: [
        {
          path: join(repository, '.agents/skills'),
          relativePath: '.agents/skills',
          kind: 'missing',
          role: 'planned',
          runtimes: ['codex'],
        },
      ],
    },
  });
  assert.deepEqual(await tree(repository), before);
});

test('inspect reports canonical directories, copies, and symbolic links from observed state', async () => {
  const repository = await temporaryDirectory('skills-manager-topology-');
  await mkdir(join(repository, '.agents/skills'), { recursive: true });
  await mkdir(join(repository, '.claude'), { recursive: true });
  await symlink('../.agents/skills', join(repository, '.claude/skills'));
  await mkdir(join(repository, '.factory/skills'), { recursive: true });
  const before = await tree(repository);

  const { exitCode, result } = await runCli(['inspect', '--runtime', 'codex'], { cwd: repository });

  assert.equal(exitCode, 0);
  assert.equal(result.data.topology, 'mixed');
  assert.deepEqual(result.data.runtimes.map(({ id }) => id), ['claude-code', 'codex', 'droid']);
  assert.deepEqual(
    result.data.targets.map(({ relativePath, kind, role, runtimes }) => ({
      relativePath,
      kind,
      role,
      runtimes,
    })),
    [
      {
        relativePath: '.agents/skills',
        kind: 'directory',
        role: 'canonical',
        runtimes: ['codex'],
      },
      {
        relativePath: '.claude/skills',
        kind: 'symbolic_link',
        role: 'link',
        runtimes: ['claude-code'],
      },
      {
        relativePath: '.factory/skills',
        kind: 'directory',
        role: 'copy',
        runtimes: ['droid'],
      },
    ],
  );
  assert.equal(result.data.targets[1].linkTarget, '../.agents/skills');
  assert.equal(result.data.targets[1].resolvedPath, join(repository, '.agents/skills'));
  assert.deepEqual(await tree(repository), before);
});

test('a shared canonical directory is observed without inventing runtimes that might use it', async () => {
  const repository = await temporaryDirectory('skills-manager-shared-');
  await mkdir(join(repository, '.agents/skills'), { recursive: true });

  const { exitCode, result } = await runCli(['inspect', '--runtime', 'claude-code'], {
    cwd: repository,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(result.data.runtimes.map(({ id }) => id), ['claude-code']);
  assert.deepEqual(
    result.data.targets.map(({ relativePath, kind, role, runtimes }) => ({
      relativePath,
      kind,
      role,
      runtimes,
    })),
    [
      {
        relativePath: '.agents/skills',
        kind: 'directory',
        role: 'canonical',
        runtimes: [],
      },
      {
        relativePath: '.claude/skills',
        kind: 'missing',
        role: 'planned',
        runtimes: ['claude-code'],
      },
    ],
  );
});

test('an existing Agent directory is runtime evidence before its skills directory exists', async () => {
  const repository = await temporaryDirectory('skills-manager-agent-evidence-');
  await mkdir(join(repository, '.claude'));

  const { exitCode, result } = await runCli(['inspect', '--runtime', 'codex'], { cwd: repository });

  assert.equal(exitCode, 0);
  assert.deepEqual(
    result.data.runtimes.map(({ id, evidence }) => ({ id, evidence })),
    [
      { id: 'claude-code', evidence: ['agent_directory'] },
      { id: 'codex', evidence: ['current_runtime'] },
    ],
  );
  assert.deepEqual(
    result.data.targets.map(({ relativePath, kind, runtimes }) => ({ relativePath, kind, runtimes })),
    [
      { relativePath: '.agents/skills', kind: 'missing', runtimes: ['codex'] },
      { relativePath: '.claude/skills', kind: 'missing', runtimes: ['claude-code'] },
    ],
  );
});

test('ordinary GitHub repository metadata is not mistaken for a Copilot runtime', async () => {
  const repository = await temporaryDirectory('skills-manager-github-metadata-');
  await mkdir(join(repository, '.github/workflows'), { recursive: true });

  const { exitCode, result } = await runCli(['inspect', '--runtime', 'codex'], { cwd: repository });

  assert.equal(exitCode, 0);
  assert.deepEqual(result.data.runtimes.map(({ id }) => id), ['codex']);
  assert.deepEqual(result.data.targets.map(({ relativePath }) => relativePath), ['.agents/skills']);
});

test('inspect supports explicitly selected global scope without changing it', async () => {
  const workspace = await temporaryDirectory('skills-manager-global-');
  const repository = join(workspace, 'repository');
  const codexHome = join(workspace, 'codex-home');
  await mkdir(repository);
  await mkdir(join(codexHome, 'skills'), { recursive: true });
  const before = await tree(workspace);

  const { exitCode, result } = await runCli(
    ['inspect', '--runtime', 'codex', '--scope', 'global'],
    { cwd: repository, env: { CODEX_HOME: codexHome } },
  );

  assert.equal(exitCode, 0);
  assert.equal(result.data.scope, 'global');
  assert.equal(result.data.targets[0].path, join(codexHome, 'skills'));
  assert.equal(result.data.targets[0].kind, 'directory');
  assert.deepEqual(await tree(workspace), before);
});

test('unsupported runtimes fail through the JSON protocol before changing the repository', async () => {
  const repository = await temporaryDirectory('skills-manager-runtime-failure-');
  const before = await tree(repository);

  const invocation = await runCli(['inspect', '--runtime', 'not-an-agent'], { cwd: repository });

  assert.equal(invocation.exitCode, 1);
  assert.equal(invocation.stderr, '');
  assert.equal(invocation.result.version, 1);
  assert.equal(invocation.result.status, 'failed');
  assert.equal(invocation.result.command, 'inspect');
  assert.equal(invocation.result.error.code, 'unsupported_runtime');
  assert.match(invocation.result.error.message, /not-an-agent/);
  assert.deepEqual(await tree(repository), before);
});

test('unsupported Node versions fail before command dispatch or filesystem inspection', async () => {
  const repository = await temporaryDirectory('skills-manager-node-failure-');
  const before = await tree(repository);
  const script = [
    "Object.defineProperty(process, 'version', { value: 'v20.19.0' });",
    `process.argv = [process.execPath, ${JSON.stringify(cli)}, 'inspect', '--runtime', 'codex'];`,
    `await import(${JSON.stringify(`file://${cli}`)});`,
  ].join('');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repository,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  const exitCode = await new Promise((done) => child.on('close', done));
  const result = JSON.parse(stdout);

  assert.equal(exitCode, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'unsupported_node_version');
  assert.match(result.error.message, /Node 22 or newer/);
  assert.deepEqual(await tree(repository), before);
});
