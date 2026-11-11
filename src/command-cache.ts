import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, toDependencyList, type DependencyList } from './dependencies.js';
import { fileHash, outputPaths, restoreOutputs, scanWorkspace, snapshotOutputs, workspacePath, workspaceSymlinks, type Output } from './command-files.js';
import { isDependencyList, writeJsonAtomic } from './store.js';
import { readTraceReport, runTraced, withCommandLock } from './trace.js';

export type CachedCommand = {
  readonly root: string;
  readonly cwd: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
};

type Plan = { readonly version: 1; readonly dependencies: DependencyList; readonly mutable: readonly string[] };
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
const readPlan = (path: string): Plan | undefined => {
  if (!existsSync(path)) return undefined;
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1 ||
      !('dependencies' in value) || !isDependencyList(value.dependencies) || !('mutable' in value) || !isStringArray(value.mutable)) {
    throw new Error(`Invalid command cache plan: ${path}`);
  }
  return { version: 1, dependencies: value.dependencies, mutable: value.mutable };
};

const parseOutput = (value: unknown): Output => {
  if (typeof value !== 'object' || value === null || !('kind' in value) || !('path' in value) || typeof value.path !== 'string') {
    throw new Error('Invalid cached output');
  }
  const { path, kind } = value;
  if (kind === 'missing') return { path, kind };
  if (kind === 'directory' && 'mode' in value && typeof value.mode === 'number' && Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777) return { path, kind, mode: value.mode };
  if (kind === 'symlink' && 'target' in value && typeof value.target === 'string') return { path, kind, target: value.target };
  if (kind === 'file' && 'hash' in value && typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash) &&
      'mode' in value && typeof value.mode === 'number' && Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777) {
    return { path, kind, hash: value.hash, mode: value.mode };
  }
  throw new Error('Invalid cached output type');
};

const readOutputs = (path: string): Output[] => {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`Invalid command cache entry: ${path}`);
  return value.map(parseOutput);
};

/** フレームを全件検査してから再生し、壊れたログを部分的に出力しない。 */
const readLog = (path: string): { readonly stream: 0 | 1; readonly data: Buffer }[] => {
  const log = readFileSync(path);
  const frames: { readonly stream: 0 | 1; readonly data: Buffer }[] = [];
  for (let offset = 0; offset < log.length;) {
    if (offset + 5 > log.length) throw new Error('Truncated cached log');
    const stream = log[offset];
    const length = log.readUInt32BE(offset + 1);
    if ((stream !== 0 && stream !== 1) || offset + 5 + length > log.length) throw new Error('Invalid cached log frame');
    frames.push({ stream, data: log.subarray(offset + 5, offset + 5 + length) });
    offset += 5 + length;
  }
  return frames;
};

const replayLog = async (frames: ReturnType<typeof readLog>): Promise<void> => {
  for (const frame of frames) {
    const destination = frame.stream === 0 ? process.stdout : process.stderr;
    await new Promise<void>((resolve, reject) => destination.write(frame.data, error => error ? reject(error) : resolve()));
  }
};

const cacheKey = (dependencies: DependencyList, root: string): string => digest([dependencies, fingerprint(dependencies, root), workspaceSymlinks(root, dependencies.outputs)]);
const readOnlyFingerprint = (plan: Plan, root: string): string => digest([fingerprint({
  ...plan.dependencies, paths: plan.dependencies.paths.filter(path => !plan.mutable.includes(path)),
  directories: plan.dependencies.directories.filter(path => !plan.mutable.includes(path)),
}, root), workspaceSymlinks(root, [...plan.dependencies.outputs, ...plan.mutable])]);

export const runCachedCommand = async (command: CachedCommand): Promise<number> => {
  const version: unknown = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  const identity = digest({
    format: 1, version, platform: process.platform, arch: process.arch, node: process.version,
    root: command.root, cwd: relative(command.root, command.cwd), executable: command.executable,
    executableHash: fileHash(command.executable), args: command.args,
    env: Object.entries(command.env).filter((entry): entry is [string, string] => entry[1] !== undefined).sort(([a], [b]) => a.localeCompare(b)),
    stdinTTY: process.stdin.isTTY === true, stdoutTTY: process.stdout.isTTY === true, stderrTTY: process.stderr.isTTY === true,
  });
  const directory = join(command.root, '.nx', 'nx-auto-cache-deps', 'commands', identity);
  mkdirSync(directory, { recursive: true });
  return withCommandLock(join(directory, 'lock'), async () => {
    const index = join(directory, 'plan.json');
    const previous = readPlan(index);
    const beforeKey = previous === undefined ? undefined : cacheKey(previous.dependencies, command.root);
    const beforeReadOnly = previous === undefined ? undefined : readOnlyFingerprint(previous, command.root);
    if (beforeKey !== undefined && existsSync(join(directory, 'entries', beforeKey))) {
      const entry = join(directory, 'entries', beforeKey);
      const outputs = readOutputs(join(entry, 'outputs.json'));
      const frames = readLog(join(entry, 'log'));
      restoreOutputs(command.root, outputs, join(entry, 'files'));
      await replayLog(frames);
      return 0;
    }
    const before = scanWorkspace(command.root);
    const work = mkdtempSync(join(directory, 'pending-'));
    try {
      const reportPath = join(work, 'report.json');
      const log = openSync(join(work, 'log'), 'wx');
      let code: number;
      try {
        code = await runTraced({
          report: reportPath, root: command.root, command: [process.execPath, fileURLToPath(new URL('./run-command.js', import.meta.url)), command.executable, ...command.args],
          cwd: command.cwd, env: command.env, log,
        });
      } finally { closeSync(log); }
      if (code !== 0) return code;
      const report = readTraceReport(reportPath);
      if (report.status === 'incomplete') {
        process.stderr.write(`nx-auto-cache-deps: tracing incomplete, result not cached: ${report.reason}\n`);
        return 0;
      }
      const outputsObserved = outputPaths(command.root, report.accesses, before);
      if (outputsObserved.status === 'untracked') {
        process.stderr.write(`nx-auto-cache-deps: untracked filesystem changes, result not cached: ${outputsObserved.paths.join(', ')}\n`);
        return 0;
      }
      const paths = outputsObserved.paths;
      const read = new Set(report.accesses.filter(access => access.kind === 'read').map(access => workspacePath(command.root, access.path)));
      const mutable = paths.filter(path => before.has(path) && before.get(path)?.kind !== 'directory' && (before.get(path)?.kind === 'symlink' || read.has(path) || lstatSync(join(command.root, path), { throwIfNoEntry: false }) === undefined));
      const excluded = paths.filter(path => !mutable.includes(path) && (before.get(path)?.kind !== 'directory'));
      const observed = toDependencyList(report.accesses, command.root, excluded);
      const dependencies: DependencyList = {
        ...observed, paths: [...new Set([...observed.paths, ...mutable])].sort(),
      };
      const plan: Plan = { version: 1, dependencies, mutable };
      const samePlan = previous !== undefined && JSON.stringify(previous) === JSON.stringify(plan);
      const stableReads = previous === undefined || beforeReadOnly === readOnlyFingerprint(previous, command.root);
      // その場で変更した入力の実行前の値は、前回から依存一覧が既知の場合だけ使える。
      const key = mutable.length === 0 ? cacheKey(dependencies, command.root) : samePlan ? beforeKey : undefined;
      if (key !== undefined && stableReads) {
        const outputs = snapshotOutputs(command.root, paths, join(work, 'files'));
        writeFileSync(join(work, 'outputs.json'), JSON.stringify(outputs));
        rmSync(reportPath);
        const entries = join(directory, 'entries');
        mkdirSync(entries, { recursive: true });
        if (!existsSync(join(entries, key))) renameSync(work, join(entries, key));
      }
      writeJsonAtomic(index, plan);
      return 0;
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
};
