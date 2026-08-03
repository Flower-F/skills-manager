#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const source = resolve(process.argv[2] ?? '.');
const version = process.env.SKILLS_CLI_VERSION ?? '1.5.19';
const localCli = process.env.SKILLS_CLI_PATH;
const temporaryRoot = await mkdtemp(join(tmpdir(), 'skills-manager-smoke-'));
const project = join(temporaryRoot, 'project');

function plain(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, '');
}

function contentLine(value) {
  return value.replace(/^[\s│●◇└├─╭╮╯╰]+/u, '').trim();
}

async function runSkills(args, cwd) {
  try {
    const executable = localCli ? process.execPath : 'npx';
    const commandArgs = localCli ? [resolve(localCli), ...args] : ['--yes', `skills@${version}`, ...args];
    return await execFileAsync(executable, commandArgs, {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    process.stderr.write(error.stdout ?? '');
    process.stderr.write(error.stderr ?? '');
    throw error;
  }
}

try {
  await execFileAsync('git', ['init', '--quiet', project]);
  const discovery = await runSkills(['add', source, '--list'], project);
  const lines = plain(`${discovery.stdout}\n${discovery.stderr}`).split('\n').map(contentLine);
  const found = lines.filter((line) => line === 'skills-manager');
  if (found.length !== 1 || !lines.some((line) => /Found 1 skill$/u.test(line))) {
    throw new Error(`expected discovery to expose exactly skills-manager\n${plain(discovery.stdout)}`);
  }

  const installation = await runSkills([
    'add', source, '--skill', 'skills-manager', '--agent', 'codex', '--copy', '--yes',
  ], project);
  const output = plain(`${installation.stdout}\n${installation.stderr}`);
  if (!/Installed 1 skill/u.test(output) || !/skills-manager \(copied\)/u.test(output)) {
    throw new Error(`installation did not report one copied Skill\n${output}`);
  }

  const installedRoot = join(project, '.agents', 'skills', 'skills-manager');
  const installedSkill = await readFile(join(installedRoot, 'SKILL.md'), 'utf8');
  if (!/^---\nname: skills-manager\n/u.test(installedSkill)) throw new Error('installed Skill has unexpected identity');
  if (!/install and update Agent Skills without losing the changes they want to keep/iu.test(installedSkill)) {
    throw new Error('installed Skill does not publish the Patch-only promise');
  }
  if (/\bIntents?\b|intent-application|Baseline handle|application[- ]review/iu.test(installedSkill)) {
    throw new Error('installed Skill contains legacy customization guidance');
  }

  const installedEntries = (await readdir(installedRoot, { withFileTypes: true })).map((entry) => entry.name).sort();
  if (installedEntries.join(',') !== 'SKILL.md,agents,references') {
    throw new Error(`unexpected installed bundle shape: ${installedEntries.join(', ')}`);
  }
  const installedReferences = (await readdir(join(installedRoot, 'references'), { withFileTypes: true }))
    .filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  if (installedReferences.join(',') !== 'installation.md,patches.md,removal.md,update.md') {
    throw new Error(`unexpected installed references: ${installedReferences.join(', ')}`);
  }
  const referenceContent = await Promise.all(installedReferences.map((name) => readFile(join(installedRoot, 'references', name), 'utf8')));
  const bundle = `${installedSkill}\n${referenceContent.join('\n')}`;
  for (const term of ['# Active Patches', 'user-approved result', 'Conflict', 'Local Skills', 'self-Update', '.skills-manager/patches/']) {
    if (!bundle.includes(term)) throw new Error(`installed bundle is missing ${term}`);
  }
  if (/\bIntents?\b|intent-application|Baseline handle|clean upstream|Upstream-fulfilled|application[- ]review/iu.test(bundle)) {
    throw new Error('installed bundle contains removed customization machinery');
  }

  const installedNames = (await readdir(join(project, '.agents', 'skills'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => basename(entry.name));
  if (installedNames.length !== 1 || installedNames[0] !== 'skills-manager') {
    throw new Error(`unexpected installed Skills: ${installedNames.join(', ')}`);
  }

  console.log(`clean-checkout smoke passed with skills@${version}`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
