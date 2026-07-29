import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export async function stageJsonReplacement(path, value, options = {}) {
  await mkdir(dirname(path), { recursive: true });
  const nonce = options.nonce || randomUUID();
  const temporaryPath = join(dirname(path), `.${basename(path)}.${nonce}.tmp`);
  const writeOptions = {
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.exclusive ? { flag: 'wx' } : {}),
  };
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
      Object.keys(writeOptions).length === 0 ? undefined : writeOptions,
    );
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch((cleanupError) => {
      if (error.cause === undefined) error.cause = cleanupError;
    });
    throw error;
  }
  let pending = true;
  return {
    async commit() {
      await rename(temporaryPath, path);
      pending = false;
    },
    async discard() {
      if (!pending) return;
      await rm(temporaryPath, { force: true });
      pending = false;
    },
  };
}

export async function replaceJson(path, value, options) {
  const replacement = await stageJsonReplacement(path, value, options);
  try {
    await replacement.commit();
  } catch (error) {
    await replacement.discard().catch((cleanupError) => {
      if (error.cause === undefined) error.cause = cleanupError;
    });
    throw error;
  }
}
