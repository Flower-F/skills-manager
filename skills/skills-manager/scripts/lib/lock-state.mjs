import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

function lockError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'invalid_lock';
  return error;
}

function validateLock(value) {
  if (
    value?.version !== 1 ||
    value.skills === null ||
    typeof value.skills !== 'object' ||
    Array.isArray(value.skills)
  ) {
    return false;
  }
  return Object.values(value.skills).every(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof entry.source === 'string' &&
      entry.source.length > 0 &&
      typeof entry.sourceType === 'string' &&
      /^[a-f0-9]{64}$/.test(entry.computedHash || '') &&
      (entry.skillPath === undefined || typeof entry.skillPath === 'string'),
  );
}

export async function readUpstreamLock(scopeRoot) {
  const path = join(scopeRoot, 'skills-lock.json');
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { status: 'missing', path };
    }
    throw lockError('skills-lock.json could not be read.', error);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw lockError('skills-lock.json must be a regular file.');
  }
  let snapshot;
  try {
    snapshot = await readFile(path);
  } catch (error) {
    throw lockError('skills-lock.json could not be read.', error);
  }
  try {
    const value = JSON.parse(snapshot.toString('utf8'));
    if (!validateLock(value)) throw new Error();
    return { status: 'present', path, value, snapshot };
  } catch (error) {
    throw lockError('skills-lock.json has an unsupported or malformed schema.', error);
  }
}
