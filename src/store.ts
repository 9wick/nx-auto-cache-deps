import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DependencyList } from './dependencies.js';

/** タスクは worktree の場所に依存しないよう、ワークスペースルートからの project root と target 名で識別する。 */
export const taskKey = (projectRoot: string, targetName: string): string => `${projectRoot}:${targetName}`;

export const storeDirectory = (cacheDirectory: string): string => join(cacheDirectory, 'nx-auto-cache-deps');

export const dependencyListPath = (cacheDirectory: string, key: string): string =>
  join(storeDirectory(cacheDirectory), 'dependencies', `${encodeURIComponent(key)}.json`);

const isDependencyList = (value: unknown): value is DependencyList =>
  typeof value === 'object' &&
  value !== null &&
  'version' in value &&
  value.version === 2 &&
  'paths' in value &&
  Array.isArray(value.paths) &&
  'directories' in value &&
  Array.isArray(value.directories) &&
  'outputs' in value &&
  Array.isArray(value.outputs);

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
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(list));
  renameSync(temporary, path);
};
