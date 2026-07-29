import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

export function isPathContained(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

export async function resolveRealPathWithin(parent, child) {
  const resolvedParent = await realpath(parent);
  const resolvedChild = await realpath(child);
  return isPathContained(resolvedParent, resolvedChild) ? resolvedChild : null;
}
