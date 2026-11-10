import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

export type Access = { readonly kind: 'read' | 'readDir' | 'write'; readonly path: string };

export type TraceReport =
  | { readonly status: 'complete'; readonly accesses: readonly Access[] }
  | { readonly status: 'incomplete'; readonly reason: string };

/**
 * パスはワークスペースルートからの相対パス。`paths` は読み取りと存在確認、`directories` は列挙。
 * `outputs` は target の成果物。Nx が保存・復元するものなので、入力として評価しない。
 */
export type DependencyList = {
  readonly version: 2;
  readonly paths: readonly string[];
  readonly directories: readonly string[];
  readonly outputs: readonly string[];
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

const isWithin = (path: string, base: string): boolean => base === '.' || path === base || path.startsWith(`${base}/`);

/** 成果物そのもの・その中・その祖先のパス。成果物の削除や復元で状態が変わるため、入力として評価しない。 */
const touchesOutput = (path: string, outputs: readonly string[]): boolean =>
  outputs.some((output) => isWithin(path, output) || isWithin(output, path));

const GLOB_CHARACTERS = /[*?[\]{}!]/;

/**
 * Nx の outputs（ワークスペースルートからの相対パス。glob を含みうる）を、除外に使うディレクトリまたはファイルのパスにする。
 * glob はその手前のディレクトリまでに広げる。否定 (`!`) は除外を狭めるだけなので使わない。
 */
export const toOutputPaths = (outputs: readonly string[]): string[] =>
  sortedUnique(
    outputs
      .filter((output) => !output.startsWith('!'))
      .map((output) => {
        const segments = output.split('/');
        const index = segments.findIndex((segment) => GLOB_CHARACTERS.test(segment));
        return (index === -1 ? segments : segments.slice(0, index)).join('/');
      })
      // 先頭から glob の outputs はワークスペース全体を除外してしまうため使わない
      .filter((output) => output !== ''),
  );

export const toDependencyList = (
  accesses: readonly Access[],
  workspaceRoot: string,
  outputs: readonly string[],
): DependencyList => {
  const inWorkspace = accesses.flatMap((access) => {
    const path = toWorkspacePath(workspaceRoot, access.path);
    return path === undefined ? [] : [{ kind: access.kind, path }];
  });
  // 自分で書いたパスを入力にすると、成果物の更新だけで毎回ミスするため除く
  const written = new Set(inWorkspace.filter((a) => a.kind === 'write').map((a) => a.path));
  const observed = (kind: Access['kind']) =>
    sortedUnique(inWorkspace.filter((a) => a.kind === kind && !written.has(a.path)).map((a) => a.path));
  return {
    version: 2,
    paths: observed('read').filter((path) => !touchesOutput(path, outputs)),
    // 成果物の祖先の列挙は残し、評価時に成果物へ通じるエントリだけを無視する
    directories: observed('readDir').filter((path) => !outputs.some((output) => isWithin(path, output))),
    outputs: sortedUnique(outputs),
  };
};

export const mergeDependencyLists = (a: DependencyList, b: DependencyList): DependencyList => {
  const outputs = sortedUnique([...a.outputs, ...b.outputs]);
  return {
    version: 2,
    paths: sortedUnique([...a.paths, ...b.paths]).filter((path) => !touchesOutput(path, outputs)),
    directories: sortedUnique([...a.directories, ...b.directories]).filter(
      (path) => !outputs.some((output) => isWithin(path, output)),
    ),
    outputs,
  };
};

const isMissingError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');

const pathState = (absolutePath: string): string => {
  const stats = statSync(absolutePath, { throwIfNoEntry: false });
  if (stats === undefined) return 'missing';
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return `file:${createHash('sha256').update(readFileSync(absolutePath)).digest('hex')}`;
  return 'other';
};

const directoryState = (workspaceRoot: string, path: string, outputs: readonly string[]): string => {
  try {
    return readdirSync(join(workspaceRoot, path), { withFileTypes: true })
      .filter((entry) => path !== '.' || !EXCLUDED_ROOTS.includes(entry.name))
      .filter((entry) => !touchesOutput(path === '.' ? entry.name : `${path}/${entry.name}`, outputs))
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
  for (const path of list.directories) {
    const state = directoryState(workspaceRoot, path, list.outputs);
    // 成果物しか含まない親の列挙は、後の実行で初めて観測されても入力を増やさない。
    const outputParent = list.outputs.some((output) => isWithin(output, path));
    if (outputParent && (state === '' || state === 'missing')) continue;
    hash.update(`dir\0${path}\0${state}\0`);
  }
  return hash.digest('hex');
};
