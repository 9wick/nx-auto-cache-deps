import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { Access } from './dependencies.js';

export const workspacePath = (root: string, absolute: string): string | undefined => {
  const path = relative(root, absolute).split(sep).join('/');
  if (path === '' || isAbsolute(path) || path === '..' || path.startsWith('../')) return undefined;
  return ['.git', '.nx'].some(base => path === base || path.startsWith(`${base}/`)) ? undefined : path;
};

/** 削除されたファイルも成果物として復元するため、実行前の名前と種類を記録する。 */
export type WorkspaceSnapshot = ReadonlyMap<string, { readonly kind: 'directory' | 'file' | 'symlink'; readonly stamp: string; readonly identity: string }>;

export const scanWorkspace = (root: string): WorkspaceSnapshot => {
  const entries = new Map<string, { readonly kind: 'directory' | 'file' | 'symlink'; readonly stamp: string; readonly identity: string }>();
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = workspacePath(root, absolute);
      if (path === undefined) continue;
      const stats = lstatSync(absolute, { bigint: true });
      const kind = entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file';
      const stamp = [stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs, stats.mode, kind === 'symlink' ? readlinkSync(absolute) : ''].join(':');
      entries.set(path, { kind, stamp, identity: String(stats.ino) });
      if (entry.isDirectory()) visit(absolute);
    }
  };
  visit(root);
  return entries;
};

export type Output = { readonly path: string } & (
  | { readonly kind: 'file'; readonly hash: string; readonly mode: number }
  | { readonly kind: 'directory'; readonly mode: number }
  | { readonly kind: 'symlink'; readonly target: string }
  | { readonly kind: 'missing' }
);

export const fileHash = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

export type ObservedOutputs =
  | { readonly status: 'complete'; readonly paths: readonly string[] }
  | { readonly status: 'untracked'; readonly paths: readonly string[] };

export const outputPaths = (root: string, accesses: readonly Access[], before: WorkspaceSnapshot): ObservedOutputs => {
  const written = new Set(accesses.filter(access => access.kind === 'write').flatMap(access => {
    const path = workspacePath(root, access.path);
    return path === undefined ? [] : [path];
  }));
  const after = scanWorkspace(root);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path)?.stamp !== after.get(path)?.stamp);
  const replacedDirectories = [...written].filter(path => after.get(path)?.kind === 'directory' && before.get(path)?.identity !== after.get(path)?.identity);
  const generated = changed.filter(path => replacedDirectories.some(directory => path.startsWith(`${directory}/`)));
  const unexplained = changed.filter(path => !written.has(path) && !generated.includes(path) &&
    !(before.get(path)?.kind === 'directory' && after.get(path)?.kind === 'directory' && [...written].some(output => output.startsWith(`${path}/`))));
  if (unexplained.length > 0) return { status: 'untracked', paths: unexplained };
  return { status: 'complete', paths: [...new Set([...written, ...generated])].sort() };
};

/** 復元先の親 symlink をたどって workspace の外へ書かない。 */
const checkedPath = (root: string, path: string): string => {
  if (workspacePath(root, join(root, path)) !== path) throw new Error(`Invalid cached output path: ${path}`);
  let parent = dirname(join(root, path));
  while (parent !== root) {
    if (existsSync(parent)) {
      const real = realpathSync(parent);
      const rel = relative(root, real);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Output leaves workspace through a symlink: ${path}`);
    }
    const next = dirname(parent);
    if (next === parent) throw new Error(`Invalid output parent: ${path}`);
    parent = next;
  }
  return join(root, path);
};

export const snapshotOutputs = (root: string, paths: readonly string[], destination: string): Output[] => {
  mkdirSync(destination, { recursive: true });
  return paths.map((path, index) => {
    const absolute = checkedPath(root, path);
    const stats = lstatSync(absolute, { throwIfNoEntry: false });
    if (stats === undefined) return { path, kind: 'missing' };
    if (stats.isSymbolicLink()) return { path, kind: 'symlink', target: readlinkSync(absolute) };
    if (stats.isDirectory()) return { path, kind: 'directory', mode: stats.mode & 0o777 };
    if (!stats.isFile()) throw new Error(`Cannot cache output type: ${path}`);
    copyFileSync(absolute, join(destination, String(index)));
    return { path, kind: 'file', hash: fileHash(join(destination, String(index))), mode: stats.mode & 0o777 };
  });
};

const removeEntry = (path: string): void => {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats === undefined) return;
  if (stats.isDirectory()) rmdirSync(path);
  else unlinkSync(path);
};

export const restoreOutputs = (root: string, outputs: readonly Output[], source: string): void => {
  // キャッシュの欠損は workspace を変更する前に報告する。
  for (const [index, output] of outputs.entries()) {
    checkedPath(root, output.path);
    if (output.kind === 'file' && fileHash(join(source, String(index))) !== output.hash) {
      throw new Error(`Cached output is corrupt: ${output.path}`);
    }
  }
  const directories = outputs.filter(output => output.kind === 'directory').sort((a, b) => a.path.length - b.path.length);
  for (const output of directories) {
    const destination = checkedPath(root, output.path);
    const stats = lstatSync(destination, { throwIfNoEntry: false });
    if (stats !== undefined && !stats.isDirectory()) removeEntry(destination);
    mkdirSync(destination, { recursive: true });
  }
  for (const [index, output] of outputs.entries()) {
    if (output.kind === 'directory' || output.kind === 'missing') continue;
    const destination = checkedPath(root, output.path);
    mkdirSync(dirname(destination), { recursive: true });
    const temporary = join(dirname(destination), `.nx-auto-cache-deps-${randomUUID()}`);
    try {
      if (output.kind === 'symlink') symlinkSync(output.target, temporary);
      else {
        copyFileSync(join(source, String(index)), temporary);
        chmodSync(temporary, output.mode);
      }
      removeEntry(destination);
      renameSync(temporary, destination);
    } finally {
      if (lstatSync(temporary, { throwIfNoEntry: false }) !== undefined) removeEntry(temporary);
    }
  }
  for (const output of [...directories].reverse()) {
    if (output.kind === 'directory') chmodSync(checkedPath(root, output.path), output.mode);
  }
  for (const output of outputs.filter(output => output.kind === 'missing').sort((a, b) => b.path.length - a.path.length)) {
    removeEntry(checkedPath(root, output.path));
  }
};

/** fspy が直接記録しない readlink も、リンク先文字列と一覧の変化から検出する。 */
export const workspaceSymlinks = (root: string, outputs: readonly string[]): string[] => {
  const links: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = workspacePath(root, absolute);
      if (path === undefined || outputs.some(output => path === output || path.startsWith(`${output}/`))) continue;
      if (entry.isSymbolicLink()) links.push(JSON.stringify([path, readlinkSync(absolute)]));
      else if (entry.isDirectory()) visit(absolute);
    }
  };
  visit(root);
  return links.sort();
};
