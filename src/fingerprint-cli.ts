// Nx の runtime input から呼ばれ、標準出力がタスクハッシュに入る。
import { cacheDir, workspaceRoot } from '@nx/devkit';
import { randomUUID } from 'node:crypto';
import { fingerprint } from './dependencies.js';
import { dependencyListPath, readDependencyList } from './store.js';

const key = process.argv[2];
if (key === undefined) throw new Error('nx-auto-cache-deps: fingerprint requires a task key');

const stored = readDependencyList(dependencyListPath(cacheDir, key));
if (stored.status === 'unreadable') {
  process.stderr.write(`nx-auto-cache-deps: ignoring unreadable dependency list for ${key}: ${stored.reason}\n`);
}
// 依存一覧がなければ毎回違う値を返し、実行結果のキャッシュに必ずミスさせる
process.stdout.write(stored.status === 'found' ? fingerprint(stored.list, workspaceRoot) : `no-dependency-list:${randomUUID()}`);
