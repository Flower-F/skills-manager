import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const skillRoot = resolve('skills/skills-manager');

async function markdownFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await markdownFiles(path));
    else if (entry.name.endsWith('.md')) result.push(path);
  }
  return result;
}

test('distributed Skill frontmatter and local Markdown links are valid', async () => {
  const skill = await readFile(join(skillRoot, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: skills-manager\ndescription: .+\n---\n/);
  assert.doesNotMatch(skill, /disable-model-invocation/);
  for (const path of await markdownFiles(skillRoot)) {
    const content = await readFile(path, 'utf8');
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)#]+\.md)(?:#[^)]+)?\)/g)) {
      await access(resolve(dirname(path), match[1]));
    }
  }
});

test('package exposes only native Node checks with no runtime dependencies or build layer', async () => {
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  assert.equal(packageJson.type, 'module');
  assert.equal(packageJson.bin, undefined);
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
  assert.equal(packageJson.scripts.build, undefined);
  assert.match(packageJson.scripts.typecheck, /customization-patch\.mjs/);
  assert.doesNotMatch(packageJson.scripts.typecheck, /skills-manager\.mjs|scripts\/lib/);
});

test('maintained product surface uses public upstream commands and the simplified domain model', async () => {
  const files = [resolve('README.md'), ...await markdownFiles(skillRoot)];
  const content = (await Promise.all(files.map((path) => readFile(path, 'utf8')))).join('\n');
  for (const command of ['find', 'add', 'list', 'update', 'remove']) assert.match(content, new RegExp(`npx skills ${command}`));
  for (const term of ['Intent', 'Installation', 'Customization patch', 'Update']) assert.match(content, new RegExp(term));
  for (const obsolete of ['work-order', 'continuation', 'runtime registry', 'work-directory', 'restart_required', 'Archaeology', 'Effective intents', 'structured JSON workflow']) {
    assert.doesNotMatch(content, new RegExp(obsolete, 'i'));
  }
});

test('Agent instructions cover selection, semantic Update, removal, and self-Update branches', async () => {
  const ordinary = await readFile(join(skillRoot, 'references/ordinary-management.md'), 'utf8');
  const intents = await readFile(join(skillRoot, 'references/intents.md'), 'utf8');
  const update = await readFile(join(skillRoot, 'references/update.md'), 'utf8');
  const removal = await readFile(join(skillRoot, 'references/removal.md'), 'utf8');
  assert.match(ordinary, /Agent-native choice interface/);
  assert.match(ordinary, /approval for the exact selection/);
  assert.match(intents, /Save the approved Intent before applying it/);
  assert.match(intents, /No Intent document[\s\S]*Active Intents, empty patch[\s\S]*Non-empty patch/);
  assert.match(update, /main Agent invokes one `npx skills update/);
  assert.match(update, /at most one subagent to each customized Installation/);
  assert.match(update, /partial success/i);
  assert.match(removal, /final target disappeared, delete that scope's Intent document/);
  assert.match(removal, /start a new Agent session/);
});
