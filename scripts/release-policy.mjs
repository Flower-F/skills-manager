export const forbiddenReleasePaths = Object.freeze([
  '.agents',
  '.scratch',
  'skills-lock.json',
  'docs/research/impeccable-source-research.md',
]);

export function isForbiddenReleasePath(path) {
  return forbiddenReleasePaths.some((forbidden) => path === forbidden || path.startsWith(`${forbidden}/`));
}
