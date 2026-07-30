#!/usr/bin/env node

import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';
import { isForbiddenReleasePath } from './release-policy.mjs';

const execFileAsync = promisify(execFile);
const machineRoot = ['', 'Users', ''].join('/');

const { stdout } = await execFileAsync('git', ['rev-list', '--all']);
const revisions = stdout.trim().split('\n').filter(Boolean);
const violations = [];

for (const revision of revisions) {
  const { stdout: tree } = await execFileAsync('git', ['ls-tree', '-r', '--name-only', revision], {
    maxBuffer: 50 * 1024 * 1024,
  });
  for (const path of tree.trim().split('\n').filter(Boolean)) {
    if (isForbiddenReleasePath(path)) {
      violations.push(`${revision}: forbidden path ${path}`);
    }
  }

  try {
    const { stdout: matches } = await execFileAsync('git', ['grep', '-I', '-n', '-F', machineRoot, revision, '--'], {
      maxBuffer: 50 * 1024 * 1024,
    });
    for (const match of matches.trim().split('\n').filter(Boolean)) violations.push(`${revision}: ${match}`);
  } catch (error) {
    if (error.code !== 1) throw error;
  }
}

if (violations.length > 0) {
  console.error(`history verification found ${violations.length} violation(s):`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`verified ${revisions.length} reachable revision(s): public paths and machine roots are clean`);
