import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { isForbiddenReleasePath } from '../scripts/release-policy.mjs';

const skillRoot = resolve('skills/skills-manager');
const execFileAsync = promisify(execFile);
const legacyProductTerms = /\bIntents?\b|intent-application|application[- ]review|Baseline handle|clean upstream|Upstream-fulfilled|Baseline-satisfied|targeted.review|\.skills-manager\/intents/iu;

async function filesBelow(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(path));
    else result.push(path);
  }
  return result.sort();
}

async function markdownFiles(directory) {
  return (await filesBelow(directory)).filter((path) => path.endsWith('.md'));
}

async function trackedFiles() {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z']);
  const files = stdout.split('\0').filter(Boolean);
  const present = await Promise.all(files.map(async (path) => {
    try {
      await access(resolve(path));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }));
  return files.filter((_, index) => present[index]);
}

async function assertLocalMarkdownLinks(paths) {
  for (const path of paths) {
    const content = await readFile(path, 'utf8');
    for (const match of content.matchAll(/\[[^\]]+\]\((?!https?:|mailto:|#)([^)#]+)(?:#[^)]+)?\)/g)) {
      await access(resolve(dirname(path), decodeURIComponent(match[1])));
    }
  }
}

async function readBundle(root) {
  const paths = await filesBelow(root);
  const relative = paths.map((path) => path.slice(root.length + 1));
  const markdown = await Promise.all(paths.filter((path) => path.endsWith('.md')).map((path) => readFile(path, 'utf8')));
  return { relative, content: markdown.join('\n'), skill: await readFile(join(root, 'SKILL.md'), 'utf8') };
}

function assertPatchBundle({ relative, content, skill }) {
  assert.deepEqual(relative, [
    'SKILL.md',
    'agents/openai.yaml',
    'references/installation.md',
    'references/patches.md',
    'references/removal.md',
    'references/update.md',
  ]);
  assert.match(skill, /^---\nname: skills-manager\ndescription: .+\ndisable-model-invocation: true\n---\n/);
  assert.match(skill, /install and update Agent Skills without losing the changes they want to keep/i);
  assert.match(skill, /Patch[\s\S]*user-approved result[\s\S]*not a textual diff/i);
  for (const capability of ['Discovery', 'installation', 'listing', 'customization', 'one-off edits', 'Update', 'removal', 'Local Skills', 'batch Update', 'self-Update']) {
    assert.match(content, new RegExp(capability, 'i'), capability);
  }
  assert.doesNotMatch(content, legacyProductTerms);
}

test('source bundle exposes the complete Patch-only Interface', async () => {
  assertPatchBundle(await readBundle(skillRoot));
  await assertLocalMarkdownLinks(await markdownFiles(skillRoot));
});

test('clean temporary project exercises the same complete installed-bundle Interface', async () => {
  const project = await mkdtemp(join(tmpdir(), 'skills-manager-bundle-'));
  try {
    const installed = join(project, '.agents/skills/skills-manager');
    await cp(skillRoot, installed, { recursive: true });
    assertPatchBundle(await readBundle(installed));
    await assertLocalMarkdownLinks(await markdownFiles(installed));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('Patch document contract is semantic, readable, identity-bound, and active-only', async () => {
  const patches = await readFile(join(skillRoot, 'references/patches.md'), 'utf8');
  assert.match(patches, /\.skills-manager\/patches\//);
  assert.match(patches, /XDG_CONFIG_HOME[\s\S]*skills-manager\/patches/);
  assert.match(patches, /source: owner\/repository\nskill: release-notes\nscope: project/);
  assert.match(patches, /# Active Patches[\s\S]*## Check migration notes[\s\S]*### Outcome/);
  assert.match(patches, /document-local unique readable title/);
  assert.match(patches, /Rationale[\s\S]*Constraints[\s\S]*only when needed/i);
  assert.match(patches, /upstream source[\s\S]*upstream Skill identifier[\s\S]*Installation scope/i);
  assert.match(patches, /display name[\s\S]*target-Agent label[\s\S]*physical path is not identity/i);
  assert.match(patches, /Do not store opaque IDs, paths, diffs, hashes, statuses, ordering rules, retired entries, history, transcripts, or execution state/);
});

test('customization contract covers approval, adaptation, unmanaged edits, and Conflict', async () => {
  const patches = await readFile(join(skillRoot, 'references/patches.md'), 'utf8');
  assert.match(patches, /ordinary customization request[\s\S]*propose a Patch/i);
  assert.match(patches, /Obtain approval[\s\S]*before writing/i);
  assert.match(patches, /every Active Patch is satisfied together[\s\S]*no Patch precedence/i);
  assert.match(patches, /Implementation details may change freely[\s\S]*outcome, rationale, and constraints remain intact/i);
  assert.match(patches, /already satisfied[\s\S]*leave it active/i);
  assert.match(patches, /explicitly asks for a one-off edit[\s\S]*Update may overwrite it/i);
  assert.match(patches, /ambiguous[\s\S]*contradicts[\s\S]*Conflict[\s\S]*wait for the user/i);
  assert.match(patches, /change to a Patch title, outcome, rationale, or constraints[\s\S]*approval/i);
  assert.match(patches, /For removal[\s\S]*Patch title[\s\S]*obtain approval/i);
});

test('Update contract fails closed and keeps Installation outcomes independent', async () => {
  const update = await readFile(join(skillRoot, 'references/update.md'), 'utf8');
  assert.match(update, /Before upstream mutation[\s\S]*project and global[\s\S]*exact Skill identity[\s\S]*readable, valid, and identity-consistent/i);
  assert.match(update, /npx skills update <skill-name> --project[\s\S]*--global/i);
  assert.match(update, /fails, times out, or is interrupted[\s\S]*do not retry automatically[\s\S]*do not continue Patch work/i);
  assert.match(update, /no Patch document exists[\s\S]*without inventing protection for manual edits/i);
  assert.match(update, /Active Patches[\s\S]*simultaneously[\s\S]*already-satisfied Patch remains active/i);
  assert.match(update, /outdated, ambiguous, incompatible[\s\S]*Conflict[\s\S]*Leave every approved Patch intact/i);
  assert.match(update, /Multiple Installations[\s\S]*main Agent coordinate[\s\S]*independently[\s\S]*never rolls back/i);
  assert.doesNotMatch(update, /baseline capture|Baseline handle|application evidence|fulfillment|raw application diff/i);
});

test('removal, Local Skill, and self-Update boundaries are explicit', async () => {
  const installation = await readFile(join(skillRoot, 'references/installation.md'), 'utf8');
  const removal = await readFile(join(skillRoot, 'references/removal.md'), 'utf8');
  assert.match(installation, /approval for the exact selection/i);
  assert.match(installation, /Local sources[\s\S]*change them there[\s\S]*Do not create Patch documents/i);
  assert.match(removal, /removal selection for approval[\s\S]*Active Patches[\s\S]*final target/i);
  assert.match(removal, /still has a target Agent, retain[\s\S]*final target disappeared, delete/i);
  assert.match(removal, /self-Update[\s\S]*any Active Patch[\s\S]*reject[\s\S]*before running/i);
  assert.match(removal, /no Patch document[\s\S]*start a new Agent session/i);
});

test('public English and Chinese surfaces publish the same plain-language Patch experience', async () => {
  const readme = await readFile(resolve('README.md'), 'utf8');
  const translated = await readFile(resolve('README.zh-CN.md'), 'utf8');
  for (const content of [readme, translated]) {
    assert.match(content, /Patch/);
    assert.match(content, /Active Patch/);
    assert.match(content, /Conflict/);
    assert.match(content, /Local Skill/);
    assert.match(content, /self-Update/);
    assert.match(content, /one-off|一次性/i);
    assert.doesNotMatch(content, legacyProductTerms);
  }
  assert.match(readme, /install and update Agent Skills without losing the changes you want to keep/i);
  assert.match(translated, /安装和更新 Agent Skills[\s\S]*不丢失你想保留的改动/);
  assert.match(readme, /npx skills add Flower-F\/skills-manager/);
  assert.match(translated, /npx skills add Flower-F\/skills-manager/);
  assert.match(readme, /Node(?:\.js)? 22 and 24/);
  assert.match(readme, />=1\.5\.19 <2\.0\.0/);
});

test('current product surfaces contain no legacy protocol or removed runtime implementation', async () => {
  const current = [
    'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'SUPPORT.md',
    'docs/releases/v0.1.0.md', 'docs/adr/0015-use-native-node-esm.md',
    'docs/adr/0017-delegate-package-management-to-npx-skills.md',
    'docs/adr/0018-resolve-update-before-mutation.md', 'package.json',
    '.github/pull_request_template.md', '.github/ISSUE_TEMPLATE/feature_request.yml',
    ...await filesBelow(skillRoot),
  ];
  for (const path of current) {
    const content = await readFile(resolve(path), 'utf8');
    assert.doesNotMatch(content, legacyProductTerms, path);
  }
  assert.equal((await trackedFiles()).some((path) => /^(?:skills\/skills-manager|tests)\/(?:.*intent-application|.*references\/intents\.md)/.test(path)), false);
});

test('tracked release exposes exactly one Skill and excludes local development state', async () => {
  const files = await trackedFiles();
  assert.deepEqual(files.filter((path) => /(?:^|\/)skills\/[^/]+\/SKILL\.md$/.test(path)), ['skills/skills-manager/SKILL.md']);
  assert.deepEqual(files.filter(isForbiddenReleasePath), []);
});

test('public policy surface, metadata, and local Markdown links are complete', async () => {
  const required = [
    'README.md', 'README.zh-CN.md', 'LICENSE', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md',
    'SUPPORT.md', 'CHANGELOG.md', 'docs/adr/README.md', '.github/ISSUE_TEMPLATE/bug_report.yml',
    '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/ISSUE_TEMPLATE/config.yml',
    '.github/pull_request_template.md', '.github/workflows/ci.yml',
    '.github/workflows/upstream-compatibility.yml', '.github/workflows/release-gate.yml',
    'docs/releases/v0.1.0.md',
  ].map((path) => resolve(path));
  await Promise.all(required.map((path) => access(path)));
  await assertLocalMarkdownLinks((await trackedFiles()).filter((path) => path.endsWith('.md')).map((path) => resolve(path)));

  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.license, 'MIT');
  assert.equal(packageJson.type, 'module');
  assert.equal(packageJson.engines.node, '>=22');
  assert.match(packageJson.description, /semantic Patches/i);
  assert.equal(packageJson.bin, undefined);
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
  assert.equal(packageJson.scripts.build, undefined);
  assert.doesNotMatch(packageJson.scripts.typecheck, /skills\/skills-manager\/scripts|intent/i);
});

test('community and release gates retain compatibility, DCO, security, and support policy', async () => {
  const contributing = await readFile(resolve('CONTRIBUTING.md'), 'utf8');
  assert.match(contributing, /maintainer-led/);
  assert.match(contributing, /Developer Certificate of Origin 1\.1/);
  assert.match(contributing, /does not require a CLA, copyright assignment/i);
  assert.match(contributing, /\.agents\/[\s\S]*skills-lock\.json[\s\S]*\.scratch\//);

  const security = await readFile(resolve('SECURITY.md'), 'utf8');
  assert.match(security, /Private Vulnerability Reporting/);
  assert.match(security, /within 7 calendar days/);
  assert.match(security, /within 14 calendar days/);
  assert.match(security, /at least every 30 calendar days/);
  assert.match(security, /third-party Skill content remains untrusted data/i);
  assert.doesNotMatch(security, /raw[\s\S]*diff|redact/i);

  const support = await readFile(resolve('SUPPORT.md'), 'utf8');
  assert.match(support, /best effort/);
  assert.match(support, /no response-time or resolution SLA/);
  assert.match(support, /upstream skills project/);

  const ci = await readFile(resolve('.github/workflows/ci.yml'), 'utf8');
  const scheduled = await readFile(resolve('.github/workflows/upstream-compatibility.yml'), 'utf8');
  const release = await readFile(resolve('.github/workflows/release-gate.yml'), 'utf8');
  assert.match(ci, /node: \[22, 24\]/);
  assert.match(ci, /SKILLS_CLI_VERSION: 1\.5\.19/);
  assert.match(ci, /DCO 1\.1 sign-off/);
  assert.match(scheduled, /schedule:[\s\S]*SKILLS_CLI_VERSION: \^1\.5\.19/);
  assert.match(release, /fetch-depth: 0[\s\S]*gitleaks\/gitleaks-action@v2/);
  assert.match(release, /matrix:[\s\S]*skills: \['1\.5\.19', '\^1\.5\.19'\]/);
  for (const workflow of [ci, scheduled, release]) {
    assert.match(workflow, /permissions:\n  contents: read/);
    assert.doesNotMatch(workflow, /pull_request_target|secrets\./);
  }
});

test('tracked release contains no machine-local absolute paths', async () => {
  const machineRoot = Buffer.from(['', 'Users', ''].join('/'));
  for (const path of await trackedFiles()) {
    const content = await readFile(resolve(path));
    assert.equal(content.includes(machineRoot), false, `machine-local path in ${path}`);
  }
});
