import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

export type Access = { readonly kind: 'read' | 'readDir' | 'write'; readonly path: string };

export type TraceReport =
  | { readonly status: 'complete'; readonly accesses: readonly Access[] }
  | { readonly status: 'incomplete'; readonly reason: string };

/** パスはワークスペースルートからの相対パス。`paths` は読み取りと存在確認、`directories` は列挙。 */
export type DependencyList = {
  readonly version: 1;
  readonly paths: readonly string[];
  readonly directories: readonly string[];
};

// Nx のワークスペースデータと Git のメタデータは、Nx 自身もタスクハッシュに含めない
const EXCLUDED_ROOTS = ['.nx', '.git'];

const toWorkspacePath = (workspaceRoot: string, absolutePath: string): string | undefined => {
  const path = relative(workspaceRoot, absolutePath);
  if (path === '') return '.';
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) return undefined;
  if (EXCLUDED_ROOTS.some((root) => path === root || path.startsWith(`${root}${sep}`))) return undefined;
  return path.split(sep).join('/');
};

const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort();

export const toDependencyList = (accesses: readonly Access[], workspaceRoot: string): DependencyList => {
  const inWorkspace = accesses.flatMap((access) => {
    const path = toWorkspacePath(workspaceRoot, access.path);
    return path === undefined ? [] : [{ kind: access.kind, path }];
  });
  // 自分で書いたパスを入力にすると、成果物の更新だけで毎回ミスするため除く
  const written = new Set(inWorkspace.filter((a) => a.kind === 'write').map((a) => a.path));
  const observed = (kind: Access['kind']) =>
    sortedUnique(inWorkspace.filter((a) => a.kind === kind && !written.has(a.path)).map((a) => a.path));
  return { version: 1, paths: observed('read'), directories: observed('readDir') };
};

export const mergeDependencyLists = (a: DependencyList, b: DependencyList): DependencyList => ({
  version: 1,
  paths: sortedUnique([...a.paths, ...b.paths]),
  directories: sortedUnique([...a.directories, ...b.directories]),
});

const isMissingError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');

const pathState = (absolutePath: string): string => {
  const stats = statSync(absolutePath, { throwIfNoEntry: false });
  if (stats === undefined) return 'missing';
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return `file:${createHash('sha256').update(readFileSync(absolutePath)).digest('hex')}`;
  return 'other';
};

const directoryState = (absolutePath: string): string => {
  try {
    return readdirSync(absolutePath, { withFileTypes: true })
      .map((entry) => `${entry.name}:${entry.isDirectory() ? 'd' : entry.isFile() ? 'f' : entry.isSymbolicLink() ? 'l' : 'o'}`)
      .sort()
      .join('\n');
  } catch (error) {
    if (isMissingError(error)) return 'missing';
    throw error;
  }
};

/** 依存一覧の各依存を現在のファイルシステムで評価したハッシュ。 */
export const fingerprint = (list: DependencyList, workspaceRoot: string): string => {
  const hash = createHash('sha256');
  for (const path of list.paths) hash.update(`path\0${path}\0${pathState(join(workspaceRoot, path))}\0`);
  for (const path of list.directories) hash.update(`dir\0${path}\0${directoryState(join(workspaceRoot, path))}\0`);
  return hash.digest('hex');
};
