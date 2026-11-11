import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { DependencyList } from './dependencies.js';

/** タスクは worktree の場所に依存しないよう、ワークスペースルートからの project root と target 名で識別する。 */
export const taskKey = (projectRoot: string, targetName: string): string => `${projectRoot.split(sep).join('/')}:${targetName}`;

export const storeDirectory = (cacheDirectory: string): string => join(cacheDirectory, 'nx-auto-cache-deps');

export const dependencyListPath = (cacheDirectory: string, key: string): string =>
  join(storeDirectory(cacheDirectory), 'dependencies', `${encodeURIComponent(key)}.json`);

export const isDependencyList = (value: unknown): value is DependencyList =>
  typeof value === 'object' &&
  value !== null &&
  'version' in value &&
  value.version === 2 &&
  'paths' in value &&
  Array.isArray(value.paths) &&
  value.paths.every((path: unknown) => typeof path === 'string') &&
  'directories' in value &&
  Array.isArray(value.directories) &&
  value.directories.every((path: unknown) => typeof path === 'string') &&
  'outputs' in value &&
  Array.isArray(value.outputs) &&
  value.outputs.every((path: unknown) => typeof path === 'string');

export type StoredList =
  | { readonly status: 'found'; readonly list: DependencyList }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable'; readonly reason: string };

export const readDependencyList = (path: string): StoredList => {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { status: 'missing' };
    throw error;
  }
  try {
    const value: unknown = JSON.parse(text);
    return isDependencyList(value) ? { status: 'found', list: value } : { status: 'unreadable', reason: 'unknown format' };
  } catch (error) {
    return { status: 'unreadable', reason: String(error) };
  }
};

/** 別プロセスが書きかけの一覧を読まないよう、一時ファイルから rename で置き換える。 */
export const writeDependencyList = (path: string, list: DependencyList): void => {
  writeJsonAtomic(path, list);
};

export const writeJsonAtomic = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
};
