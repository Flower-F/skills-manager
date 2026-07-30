import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { isForbiddenReleasePath } from '../scripts/release-policy.mjs';

const execFileAsync = promisify(execFile);
const dcoScript = resolve('scripts/check-dco.mjs');
const signoff = 'Signed-off-by: Test Contributor <contributor@example.com>';

async function git(cwd, ...args) {
  return execFileAsync('git', args, { cwd });
}

test('release path policy covers local tooling, planning, lock metadata, and superseded research', () => {
  for (const path of [
    '.agents/skills/tdd/SKILL.md',
    '.scratch/feature/spec.md',
    'skills-lock.json',
    'docs/research/impeccable-source-research.md',
  ]) assert.equal(isForbiddenReleasePath(path), true, path);
  assert.equal(isForbiddenReleasePath('skills/skills-manager/SKILL.md'), false);
});

test('DCO gate checks merge commits as well as ordinary commits', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'skills-manager-dco-'));
  try {
    await git(repository, 'init', '--quiet', '-b', 'main');
    await git(repository, 'config', 'user.name', 'Test Contributor');
    await git(repository, 'config', 'user.email', 'contributor@example.com');
    await git(repository, 'commit', '--allow-empty', '-m', `base\n\n${signoff}`);
    const { stdout: baseOutput } = await git(repository, 'rev-parse', 'HEAD');
    const base = baseOutput.trim();

    await git(repository, 'switch', '-c', 'feature');
    await git(repository, 'commit', '--allow-empty', '-m', `feature\n\n${signoff}`);
    await git(repository, 'switch', 'main');
    await git(repository, 'commit', '--allow-empty', '-m', `main work\n\n${signoff}`);
    await git(repository, 'merge', '--no-ff', 'feature', '-m', 'unsigned merge');
    const { stdout: unsignedHeadOutput } = await git(repository, 'rev-parse', 'HEAD');
    const unsignedHead = unsignedHeadOutput.trim();

    await assert.rejects(
      execFileAsync(process.execPath, [dcoScript, base, unsignedHead], { cwd: repository }),
      (error) => error.code === 1 && error.stderr.includes(unsignedHead),
    );

    await git(repository, 'commit', '--amend', '-m', `signed merge\n\n${signoff}`);
    const { stdout: signedHeadOutput } = await git(repository, 'rev-parse', 'HEAD');
    const { stdout } = await execFileAsync(process.execPath, [dcoScript, base, signedHeadOutput.trim()], { cwd: repository });
    assert.match(stdout, /verified for 3 commit\(s\)/);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
