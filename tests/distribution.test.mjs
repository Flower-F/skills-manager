import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { isForbiddenReleasePath } from '../scripts/release-policy.mjs';

const skillRoot = resolve('skills/skills-manager');
const execFileAsync = promisify(execFile);

async function markdownFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await markdownFiles(path));
    else if (entry.name.endsWith('.md')) result.push(path);
  }
  return result;
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

test('distributed Skill frontmatter and local Markdown links are valid', async () => {
  const skill = await readFile(join(skillRoot, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: skills-manager\ndescription: .+\ndisable-model-invocation: true\n---\n/);
  for (const path of await markdownFiles(skillRoot)) {
    const content = await readFile(path, 'utf8');
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)#]+\.md)(?:#[^)]+)?\)/g)) {
      await access(resolve(dirname(path), match[1]));
    }
  }
});

test('tracked release exposes exactly one Skill and excludes local development state', async () => {
  const files = await trackedFiles();
  const skillManifests = files.filter((path) => /(?:^|\/)skills\/[^/]+\/SKILL\.md$/.test(path));
  assert.deepEqual(skillManifests, ['skills/skills-manager/SKILL.md']);
  const forbidden = files.filter(isForbiddenReleasePath);
  assert.deepEqual(forbidden, []);
});

test('public policy surface and local Markdown links are complete', async () => {
  const required = [
    'README.md',
    'LICENSE',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'SECURITY.md',
    'SUPPORT.md',
    'CHANGELOG.md',
    'docs/adr/README.md',
    '.github/ISSUE_TEMPLATE/bug_report.yml',
    '.github/ISSUE_TEMPLATE/feature_request.yml',
    '.github/ISSUE_TEMPLATE/config.yml',
    '.github/pull_request_template.md',
    '.github/workflows/ci.yml',
    '.github/workflows/upstream-compatibility.yml',
    '.github/workflows/release-gate.yml',
    'docs/releases/v0.1.0.md',
  ].map((path) => resolve(path));
  await Promise.all(required.map((path) => access(path)));
  const publicMarkdown = (await trackedFiles()).filter((path) => path.endsWith('.md')).map((path) => resolve(path));
  await assertLocalMarkdownLinks(publicMarkdown);

  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.license, 'MIT');
  assert.equal(packageJson.engines.node, '>=22');

  const readme = await readFile(resolve('README.md'), 'utf8');
  assert.match(readme, /Public Preview/);
  assert.match(readme, /npx skills add Flower-F\/skills-manager/);
  assert.match(readme, /Node(?:\.js)? 22 and 24/);
  assert.match(readme, />=1\.5\.19 <2\.0\.0/);
  assert.match(readme, /raw[\s\S]*not automatically redacted/i);
});

test('community policies express the accepted contribution, support, and release contracts', async () => {
  const contributing = await readFile(resolve('CONTRIBUTING.md'), 'utf8');
  assert.match(contributing, /maintainer-led/);
  assert.match(contributing, /new feature, domain-model change, or breaking behavior/i);
  assert.match(contributing, /Developer Certificate of Origin 1\.1/);
  assert.match(contributing, /does not require a CLA, copyright assignment/i);
  assert.match(contributing, /\.agents\/[\s\S]*skills-lock\.json[\s\S]*\.scratch\//);

  const conduct = await readFile(resolve('CODE_OF_CONDUCT.md'), 'utf8');
  assert.match(conduct, /Contributor Covenant 3\.0/);
  assert.match(conduct, /Flower-F GitHub profile/);
  assert.doesNotMatch(conduct, /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);

  const security = await readFile(resolve('SECURITY.md'), 'utf8');
  assert.match(security, /Private Vulnerability Reporting/);
  assert.match(security, /within 7 calendar days/);
  assert.match(security, /within 14 calendar days/);
  assert.match(security, /at least every 30 calendar days/);
  assert.match(security, /not a promise of a fixed remediation date/);

  const support = await readFile(resolve('SUPPORT.md'), 'utf8');
  assert.match(support, /best effort/);
  assert.match(support, /no response-time or resolution SLA/);
  assert.match(support, /upstream skills project/);

  const changelog = await readFile(resolve('CHANGELOG.md'), 'utf8');
  assert.match(changelog, /Public Preview/);
  assert.match(changelog, /initial public release/i);
});

test('CI separates deterministic, fixed-baseline, moving compatibility, DCO, and release gates', async () => {
  const ci = await readFile(resolve('.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /node: \[22, 24\]/);
  assert.match(ci, /SKILLS_CLI_VERSION: 1\.5\.19/);
  assert.match(ci, /DCO 1\.1 sign-off/);

  const scheduled = await readFile(resolve('.github/workflows/upstream-compatibility.yml'), 'utf8');
  assert.match(scheduled, /schedule:/);
  assert.match(scheduled, /SKILLS_CLI_VERSION: \^1\.5\.19/);

  const release = await readFile(resolve('.github/workflows/release-gate.yml'), 'utf8');
  assert.match(release, /fetch-depth: 0/);
  assert.match(release, /gitleaks\/gitleaks-action@v2/);
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

test('package exposes only native Node checks with no runtime dependencies or build layer', async () => {
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  assert.equal(packageJson.type, 'module');
  assert.match(packageJson.description, /npx skills.*semantic customization Intents/i);
  assert.equal(packageJson.bin, undefined);
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
  assert.equal(packageJson.scripts.build, undefined);
  assert.match(packageJson.scripts.typecheck, /intent-application\.mjs/);
  assert.doesNotMatch(packageJson.scripts.typecheck, /customization-patch\.mjs/);
  assert.doesNotMatch(packageJson.scripts.typecheck, /skills-manager\.mjs|scripts\/lib/);
});

test('maintained product surface uses public upstream commands and the simplified domain model', async () => {
  const files = [resolve('README.md'), resolve('SECURITY.md'), ...await markdownFiles(skillRoot)];
  const content = (await Promise.all(files.map((path) => readFile(path, 'utf8')))).join('\n');
  for (const command of ['find', 'add', 'list', 'update', 'remove']) assert.match(content, new RegExp(`npx skills ${command}`));
  for (const term of ['Intent', 'Installation', 'Intent application baseline', 'Baseline handle', 'Intent application evidence', 'Update']) assert.match(content, new RegExp(term));
  assert.doesNotMatch(content, /Customization[- ]patch|customization-patch\.mjs/i);
  for (const obsolete of ['work-order', 'continuation', 'runtime registry', 'work-directory', 'restart_required', 'Archaeology', 'Effective intents', 'structured JSON workflow']) {
    assert.doesNotMatch(content, new RegExp(obsolete, 'i'));
  }
});

test('Agent instructions cover selection, semantic Update, removal, and self-Update branches', async () => {
  const installation = await readFile(join(skillRoot, 'references/installation.md'), 'utf8');
  const intents = await readFile(join(skillRoot, 'references/intents.md'), 'utf8');
  const update = await readFile(join(skillRoot, 'references/update.md'), 'utf8');
  const removal = await readFile(join(skillRoot, 'references/removal.md'), 'utf8');
  assert.match(installation, /Agent-native choice interface/);
  assert.match(installation, /approval for the exact selection/);
  assert.match(intents, /approval[\s\S]*capture[\s\S]*save the approved Intent[\s\S]*modify the Installation[\s\S]*review/si);
  assert.match(intents, /review is repeatable/i);
  assert.match(intents, /close[\s\S]*(?:success|completion)[\s\S]*Conflict[\s\S]*cancell/si);
  assert.match(intents, /current Managed workflow attempt/i);
  assert.match(update, /main Agent invokes one `npx skills update/);
  assert.match(update, /at most one subagent to each customized Installation/);
  assert.match(update, /partial success/i);
  assert.match(removal, /final target disappeared, delete that scope's Intent document/);
  assert.match(removal, /start a new Agent session/);
});

test('single-Skill Update contract preflights before direct mutation and closes every semantic branch', async () => {
  const update = await readFile(join(skillRoot, 'references/update.md'), 'utf8');
  assert.match(update, /intent-application\.mjs preflight[\s\S]*npx skills update <skill-name> --(?:project|global)/i);
  assert.match(update, /No active Intent[\s\S]*do not capture[\s\S]*do not.*verify-fulfillment/i);
  assert.match(update, /active Intent[\s\S]*upstream success[\s\S]*capture[\s\S]*apply[\s\S]*review[\s\S]*classif[\s\S]*close/i);
  assert.match(update, /no_application_change[\s\S]*Baseline-satisfied Intent[\s\S]*remain active/i);
  assert.match(update, /verify-fulfillment[\s\S]*only[\s\S]*Upstream-fulfilled[\s\S]*user confirmation/i);
  assert.match(update, /verification fail[\s\S]*retain[\s\S]*warning[\s\S]*complete/i);
  assert.match(update, /exit code zero[\s\S]*warnings[\s\S]*Unknown mutation outcome[\s\S]*new preflight[\s\S]*never automatically retry/i);
  assert.match(update, /at most four ordinary `npx skills` invocations/i);
  assert.doesNotMatch(update, /intent-application\.mjs update|run.*npx skills update/i);
});
