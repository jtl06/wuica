// A new folder in the OS temp directory (prefix: "wuica-cli-", ...), removed when the test file's process ends, failed
// tests included (node --test runs each file in a process of its own).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

export function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  made.push(dir);
  return dir;
}
