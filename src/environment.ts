import { createHash } from 'node:crypto';
import { matchesGlob } from 'node:path';

export type EnvironmentOptions = {
  readonly env?: readonly string[];
  readonly untrackedEnv?: readonly string[];
};

// Vite Task の DEFAULT_UNTRACKED_ENV を基準にした、値をハッシュしない受け渡し変数。
// https://github.com/voidzero-dev/vite-task/blob/main/crates/vt_graph/src/config/mod.rs
export const DEFAULT_UNTRACKED_ENV: readonly string[] = [
  'HOME', 'USER', 'TZ', 'LANG', 'SHELL', 'PWD', 'PATH',
  'XDG_RUNTIME_DIR', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'CI',
  'NODE_OPTIONS', 'COREPACK_*', 'NPM_CONFIG_STORE_DIR', 'PNPM_HOME',
  'LD_LIBRARY_PATH', 'LD_PRELOAD', 'DYLD_FALLBACK_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'LIBPATH',
  'DISPLAY', 'TMP', 'TEMP',
  'VERCEL', 'VERCEL_*', 'NEXT_*', 'USE_OUTPUT_FOR_EDGE_FUNCTIONS', 'NOW_BUILDER', 'VC_MICROFRONTENDS_CONFIG_FILE_NAME',
  'GITHUB_*', 'RUNNER_*', 'ACTIONS_ID_TOKEN_REQUEST_URL',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'SYSTEMROOT', 'SYSTEMDRIVE',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'WINDIR', 'PATHEXT', 'ProgramFiles', 'ProgramFiles[(]x86[)]',
  'ELECTRON_RUN_AS_NODE', 'JB_INTERPRETER', '_JETBRAINS_TEST_RUNNER_RUN_SCOPE_TYPE', 'JB_IDE_*',
  'VSCODE_*', 'DOCKER_*', 'BUILDKIT_*', 'COMPOSE_*', 'PLAYWRIGHT_*', 'VP_*', '*_TOKEN',
];

const matches = (name: string, patterns: readonly string[], insensitive: boolean): boolean => {
  const test = (pattern: string) => matchesGlob(insensitive ? name.toUpperCase() : name, insensitive ? pattern.toUpperCase() : pattern);
  return patterns.some(pattern => !pattern.startsWith('!') && test(pattern)) &&
    !patterns.some(pattern => pattern.startsWith('!') && test(pattern.slice(1)));
};

export type SelectedEnvironment = {
  readonly values: NodeJS.ProcessEnv;
  readonly fingerprint: string;
};

/** env は値を追跡し、untrackedEnv は受渡しのみ。それ以外の ambient env は取り除く。 */
export const selectEnvironment = (
  source: NodeJS.ProcessEnv,
  options: EnvironmentOptions,
  platform: NodeJS.Platform = process.platform,
): SelectedEnvironment => {
  const insensitive = platform === 'win32';
  const tracked = [...new Set(options.env ?? [])].sort();
  const untracked = [...new Set([...DEFAULT_UNTRACKED_ENV, ...options.untrackedEnv ?? []])].sort();
  const values: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || !(matches(name, tracked, insensitive) || matches(name, untracked, insensitive))) continue;
    const normalized = insensitive ? name.toUpperCase() : name;
    values[normalized] = value;
  }
  if (values.FORCE_COLOR === undefined) values.FORCE_COLOR = '1';
  const fingerprinted = Object.entries(values)
    .filter(([name]) => matches(name, tracked, insensitive))
    .map(([name, value]) => [insensitive ? name.toUpperCase() : name, value])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
  const fingerprint = createHash('sha256').update(JSON.stringify({ tracked, untracked, values: fingerprinted })).digest('hex');
  return { values, fingerprint };
};
