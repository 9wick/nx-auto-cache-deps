import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { constants } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import type { Access, TraceReport } from './dependencies.js';
import { resolveTraceBinary } from './platform.js';

/** stdout/stderr の順番とバイト列を、再生用ログにも同時に書く。 */
export const writeLogFrame = (fd: number, stream: number, data: Buffer): void => {
  const header = Buffer.alloc(5);
  header[0] = stream;
  header.writeUInt32BE(data.length, 1);
  for (const buffer of [header, data]) {
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
  }
};

export const readTraceReport = (path: string): TraceReport => {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value !== 'object' || value === null || !('status' in value)) throw new Error('Invalid trace report');
  if (value.status === 'incomplete' && 'reason' in value && typeof value.reason === 'string') {
    return { status: 'incomplete', reason: value.reason };
  }
  if (value.status !== 'complete' || !('accesses' in value) || !Array.isArray(value.accesses)) throw new Error('Invalid trace report');
  const accesses = value.accesses.map((access: unknown): Access => {
    if (typeof access !== 'object' || access === null || !('kind' in access) || !('path' in access) || typeof access.path !== 'string') {
      throw new Error('Invalid trace access');
    }
    const { kind, path } = access;
    if (kind !== 'read' && kind !== 'readDir' && kind !== 'write') throw new Error('Invalid trace access kind');
    return { kind, path };
  });
  return { status: 'complete', accesses };
};

export const runTraced = async (args: {
  readonly report: string;
  readonly root: string;
  readonly command: readonly [string, ...string[]];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: number;
}): Promise<number> => {
  const binary = resolveTraceBinary();
  const environmentFile = args.env === undefined ? undefined : `${args.report}.environment.json`;
  if (environmentFile !== undefined) writeFileSync(environmentFile, JSON.stringify(args.env), { mode: 0o600 });
  const child = spawn(binary, [args.report, args.root, ...args.command], {
    cwd: args.cwd,
    ...(environmentFile === undefined ? {} : { env: { ...process.env, NX_AUTO_CACHE_DEPS_COMMAND_ENV_FILE: environmentFile } }),
    stdio: args.log === undefined ? 'inherit' : ['inherit', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const forward = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      killer.once('error', error => {
        process.stderr.write(`nx-auto-cache-deps: could not terminate process tree: ${error.message}\n`);
        child.kill(signal);
      });
    } else {
      try { process.kill(-child.pid, signal); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
    }
  };
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const done = once(child, 'close');
  try {
    const streams = args.log === undefined ? [] : [child.stdout, child.stderr].map((source, index) => {
      if (source === null) throw new Error('Missing trace output stream');
      const fd = args.log;
      if (fd === undefined) throw new Error('Missing trace log');
      const destination = index === 0 ? process.stdout : process.stderr;
      return pipeline(source, new Writable({ write(chunk: Buffer, _encoding, callback) {
        try {
          writeLogFrame(fd, index, chunk);
          destination.write(chunk, callback);
        } catch (error) { callback(error instanceof Error ? error : new Error(String(error))); }
      } }));
    });
    const [exit] = await Promise.all([done, ...streams]);
    const [code, signal] = exit;
    return typeof code === 'number' ? code : 128 + (Object.entries(constants.signals).find(([name]) => name === signal)?.[1] ?? 1);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) forward('SIGTERM');
    await Promise.allSettled([done]);
    throw error;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    if (environmentFile !== undefined) rmSync(environmentFile, { force: true });
  }
};

/** ファイルロックを保持する子は親の stdin pipe が閉じると終了する。 */
export const withCommandLock = async <T>(path: string, operation: () => Promise<T>): Promise<T> => {
  const child = spawn(resolveTraceBinary(), ['--lock', path], { stdio: ['pipe', 'pipe', 'inherit'] });
  const closed = once(child, 'close');
  // ロックを待っている間の spawn 失敗も、未処理の rejection にしない。
  const ready = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    let response = '';
    child.stdout.on('data', (data: Buffer) => {
      response += data.toString();
      if (response === 'locked\n') resolve();
      else if (response.includes('\n')) reject(new Error('Invalid cache lock response'));
    });
    child.once('close', () => reject(new Error('Cache lock process ended before acquiring the lock')));
  });
  try {
    await Promise.race([ready, closed.then(() => { throw new Error('Cache lock process ended'); })]);
    return await operation();
  } finally {
    child.stdin.end();
    await closed;
  }
};
