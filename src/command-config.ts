import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, parse, resolve } from 'node:path';

export const findWorkspaceRoot = (cwd: string): string => {
  let packageRoot: string | undefined;
  for (let directory = cwd; ; directory = dirname(directory)) {
    if (existsSync(join(directory, 'nx.json')) || existsSync(join(directory, '.git')) || existsSync(join(directory, 'pnpm-workspace.yaml')) || existsSync(join(directory, 'pnpm-workspace.yml'))) return directory;
    const packageJson = join(directory, 'package.json');
    if (existsSync(packageJson)) {
      packageRoot ??= directory;
      const value: unknown = JSON.parse(readFileSync(packageJson, 'utf8'));
      if (typeof value === 'object' && value !== null && 'workspaces' in value) return directory;
    }
    if (directory === parse(directory).root) return packageRoot ?? cwd;
  }
};

export const commandEnvironment = (cwd: string, root: string): NodeJS.ProcessEnv => {
  const local: string[] = [];
  for (let directory = cwd; ; directory = dirname(directory)) {
    local.push(join(directory, 'node_modules', '.bin'));
    if (directory === root) break;
  }
  return { ...process.env, PATH: [...local, process.env.PATH ?? ''].join(delimiter) };
};

export type CommandResolution = { readonly status: 'found'; readonly path: string } | { readonly status: 'missing'; readonly command: string };

export const resolveCommand = (command: string, cwd: string, env: NodeJS.ProcessEnv): CommandResolution => {
  const directories = isAbsolute(command) || command.includes('/') || command.includes('\\') ? [''] : (env.PATH ?? '').split(delimiter);
  const extensions = process.platform === 'win32' && extname(command) === '' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = resolve(cwd, directory, command + extension);
      const stats = statSync(candidate, { throwIfNoEntry: false });
      if (stats === undefined || !stats.isFile()) continue;
      try { accessSync(candidate, constants.X_OK); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EACCES') continue;
        throw error;
      }
      return { status: 'found', path: realpathSync(candidate) };
    }
  }
  return { status: 'missing', command };
};

