#!/usr/bin/env node

import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const [base = process.env.DCO_BASE_SHA, head = process.env.DCO_HEAD_SHA] = process.argv.slice(2);

if (!base || !head) {
  console.error('Usage: node scripts/check-dco.mjs <base-sha> <head-sha>');
  process.exit(2);
}

const { stdout } = await execFileAsync('git', ['rev-list', '--no-merges', `${base}..${head}`]);
const commits = stdout.trim().split('\n').filter(Boolean);
const missing = [];

for (const commit of commits) {
  const { stdout: message } = await execFileAsync('git', ['show', '-s', '--format=%B', commit]);
  if (!/^Signed-off-by: .+ <[^<>\s]+@[^<>\s]+>\s*$/imu.test(message)) missing.push(commit);
}

if (missing.length > 0) {
  console.error(`DCO 1.1 sign-off missing from ${missing.length} commit(s):`);
  for (const commit of missing) console.error(`- ${commit}`);
  console.error('Amend each commit with: git commit --amend --signoff');
  process.exit(1);
}

console.log(`DCO 1.1 sign-off verified for ${commits.length} commit(s).`);
