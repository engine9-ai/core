/*
  Node reader/writer for the superadmins file (@engine9/core/superadmins/node).

  The file is `engine9.superadmins.json` in the site root, or the path in
  E9_SUPERADMINS_FILE:

      { "superadmins": ["chris@example.com"] }

  E9_SUPERADMINS (comma-separated emails) is added to whatever the file
  lists, so a container can run without a file. Both are re-read on every
  call; the file is parsed again only when its modification time changes.
  A missing file is an empty list. A file that exists but is not valid is
  an error, never an empty list.
*/
import fs from 'node:fs';
import path from 'node:path';
import { normalizeSuperadmins, superadminsFromText } from '../auth/superadmins.js';

export const DEFAULT_SUPERADMINS_FILE = 'engine9.superadmins.json';

export function superadminsFilePath({ file, cwd = process.cwd(), env = process.env } = {}) {
  const chosen = file || env.E9_SUPERADMINS_FILE || DEFAULT_SUPERADMINS_FILE;
  return path.resolve(cwd, chosen);
}

/**
 * Returns a synchronous function giving the current list (file plus
 * E9_SUPERADMINS). Pass it as `config.superadmins`.
 */
export function createSuperadminsReader({ file, cwd, env = process.env } = {}) {
  let cached = { file: '', mtimeMs: -1, list: [] };
  return function readSuperadmins() {
    const target = superadminsFilePath({ file, cwd, env });
    let fromFile = [];
    let stat = null;
    try {
      stat = fs.statSync(target);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (stat) {
      if (cached.file === target && cached.mtimeMs === stat.mtimeMs) {
        fromFile = cached.list;
      } else {
        let doc;
        try {
          doc = JSON.parse(fs.readFileSync(target, 'utf8'));
        } catch (err) {
          throw new Error(`superadmins file ${target} is not valid JSON: ${err.message}`);
        }
        fromFile = normalizeSuperadmins(doc);
        cached = { file: target, mtimeMs: stat.mtimeMs, list: fromFile };
      }
    }
    const fromEnv = superadminsFromText(env.E9_SUPERADMINS);
    return normalizeSuperadmins([...fromFile, ...fromEnv]);
  };
}

export function readSuperadminsFile(options = {}) {
  const target = superadminsFilePath(options);
  if (!fs.existsSync(target)) return { file: target, superadmins: [] };
  const doc = JSON.parse(fs.readFileSync(target, 'utf8'));
  return { file: target, superadmins: normalizeSuperadmins(doc) };
}

export function writeSuperadminsFile(superadmins, options = {}) {
  const target = superadminsFilePath(options);
  const list = normalizeSuperadmins(superadmins);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ superadmins: list }, null, 2)}\n`);
  fs.renameSync(tmp, target);
  return { file: target, superadmins: list };
}

export function addSuperadmins(emails, options = {}) {
  const { superadmins } = readSuperadminsFile(options);
  return writeSuperadminsFile([...superadmins, ...normalizeSuperadmins(emails)], options);
}

export function removeSuperadmins(emails, options = {}) {
  const drop = new Set(normalizeSuperadmins(emails));
  const { superadmins } = readSuperadminsFile(options);
  return writeSuperadminsFile(
    superadmins.filter((email) => !drop.has(email)),
    options
  );
}

export default {
  DEFAULT_SUPERADMINS_FILE,
  superadminsFilePath,
  createSuperadminsReader,
  readSuperadminsFile,
  writeSuperadminsFile,
  addSuperadmins,
  removeSuperadmins
};
