import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import type { EnvironmentOptions } from './environment.js';

const readSettings = (path: string): { readonly plugins: unknown; readonly base: string | undefined } => {
  const errors: ParseError[] = [];
  const value: unknown = parse(readFileSync(path, 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error(`Invalid ${path}: ${errors.map(error => printParseErrorCode(error.error)).join(', ')}`);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Invalid settings object: ${path}`);
  const base = 'extends' in value ? value.extends : undefined;
  if (base !== undefined && typeof base !== 'string') throw new Error(`Invalid extends in ${path}`);
  return { plugins: 'plugins' in value ? value.plugins : undefined, base };
};

const patterns = (value: unknown, key: 'env' | 'untrackedEnv'): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'string' && item.length > 0 && item !== '!')) {
    throw new Error(`nx-auto-cache-deps: ${key} must be an array of non-empty glob patterns`);
  }
  return value;
};

/** CLI と Nx の runtime input / executor が、同じ設定を読む。Nx と同様に extends を浅くマージする。 */
export const readEnvironmentOptions = (root: string): EnvironmentOptions => {
  const path = join(root, 'nx.json');
  if (!existsSync(path)) return {};
  const settings = readSettings(path);
  const base = settings.base === undefined ? undefined : readSettings(createRequire(path).resolve(settings.base, { paths: [dirname(path)] }));
  const plugins = settings.plugins === undefined ? base?.plugins : settings.plugins;
  if (plugins === undefined) return {};
  if (!Array.isArray(plugins)) throw new Error('nx-auto-cache-deps: nx.json plugins must be an array');
  let configured: EnvironmentOptions | undefined;
  for (const entry of plugins) {
    if (typeof entry !== 'object' || entry === null || !('plugin' in entry) || entry.plugin !== 'nx-auto-cache-deps') continue;
    const options: unknown = 'options' in entry ? entry.options : undefined;
    if (options === undefined) continue;
    if (typeof options !== 'object' || options === null || Array.isArray(options)) throw new Error('nx-auto-cache-deps: plugin options must be an object');
    if (!('env' in options) && !('untrackedEnv' in options)) continue;
    if (configured !== undefined) throw new Error('nx-auto-cache-deps: define shared env / untrackedEnv in only one plugin registration');
    configured = { env: patterns('env' in options ? options.env : undefined, 'env'), untrackedEnv: patterns('untrackedEnv' in options ? options.untrackedEnv : undefined, 'untrackedEnv') };
  }
  return configured ?? {};
};
