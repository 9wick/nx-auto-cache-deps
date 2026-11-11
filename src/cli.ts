#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { findWorkspaceRoot, commandEnvironment, resolveCommand } from './command-config.js';
import { runCachedCommand } from './command-cache.js';

const main = async (): Promise<number> => {
  const args = process.argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write('Usage: nx-auto-cache-deps [--] <command> [args...]\n\nRuns a command with file-access tracking and local caching.\nSuccessful results, stdout/stderr and workspace outputs are cached under\n<workspace>/.nx/nx-auto-cache-deps/commands. Remove that directory to clear it.\n');
    return 0;
  }
  if (args[0] === '--') args.shift();
  const executable = args.shift();
  if (executable === undefined) {
    process.stderr.write('Usage: nx-auto-cache-deps [--] <command> [args...]\n');
    return 2;
  }
  const cwd = realpathSync(process.cwd());
  const root = findWorkspaceRoot(cwd);
  const env = commandEnvironment(cwd, root);
  const resolved = resolveCommand(executable, cwd, env);
  if (resolved.status === 'missing') {
    process.stderr.write(`nx-auto-cache-deps: Command not found: ${resolved.command}\n`);
    return 1;
  }
  return runCachedCommand({ root, cwd, executable: resolved.path, args, env });
};

try { process.exitCode = await main(); }
catch (error) {
  process.stderr.write(`nx-auto-cache-deps: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
