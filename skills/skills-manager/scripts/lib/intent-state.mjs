import { createHash } from 'node:crypto';
import { join } from 'node:path';

export function normalizeSkillSource(source) {
  return source.trim().replace(/\/+$/, '').toLowerCase();
}

export function normalizeSkillIdentifier(skill) {
  return skill.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function normalizeSkillIdentity(identity) {
  return {
    source: normalizeSkillSource(identity.source),
    skill: normalizeSkillIdentifier(identity.skill),
  };
}

export function sameSkillIdentity(left, right) {
  try {
    return JSON.stringify(normalizeSkillIdentity(left)) === JSON.stringify(normalizeSkillIdentity(right));
  } catch {
    return false;
  }
}

export function skillIdentityHash(identity) {
  const normalized = normalizeSkillIdentity(identity);
  return createHash('sha256')
    .update(normalized.source)
    .update('\0')
    .update(normalized.skill)
    .digest('hex');
}

export function intentRecordLocation(scopeRoot, { installName, identity }) {
  if (
    typeof installName !== 'string' ||
    !installName ||
    installName === '.' ||
    installName === '..' ||
    /[/\\\0]/.test(installName)
  ) {
    const error = new Error('Intent record install name is not a safe state filename.');
    error.code = 'invalid_intent_state';
    throw error;
  }
  if (typeof identity?.source !== 'string' || typeof identity.skill !== 'string') {
    const error = new Error('Intent record identity is invalid.');
    error.code = 'invalid_intent_state';
    throw error;
  }
  const directory = join(scopeRoot, '.skills-manager/intents');
  const relativePath = `.skills-manager/intents/${installName}__${skillIdentityHash(identity).slice(0, 8)}.json`;
  return {
    directory,
    path: join(scopeRoot, relativePath),
    relativePath,
  };
}
