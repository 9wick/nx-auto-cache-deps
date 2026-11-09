import type {
  CreateDependencies,
  CreateMetadata,
  CreateNodes,
  CreateNodesContext,
  CreateNodesResult,
  TargetConfiguration,
} from '@nx/devkit';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, matchesGlob, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskKey } from './store.js';

export const RUN_EXECUTOR = 'nx-auto-cache-deps:run';

type Input = NonNullable<TargetConfiguration['inputs']>[number];

export type PluginOptions = {
  /** 包む推論プラグイン。指定がなければ project.json で executor を差し替えた target を扱う。 */
  readonly wrap?: { readonly plugin: string; readonly options?: unknown };
  /** wrap したプラグインが推論する target のうち、対象にする target 名。 */
  readonly targets?: readonly string[];
};

type WrappedPlugin = {
  readonly createNodes?: CreateNodes<unknown>;
  readonly createNodesV2?: CreateNodes<unknown>;
  readonly createDependencies?: CreateDependencies<unknown>;
  readonly createMetadata?: CreateMetadata<unknown>;
};

const loadWrappedPlugin = (workspaceRoot: string, name: string): WrappedPlugin => {
  const require = createRequire(join(workspaceRoot, 'package.json'));
  return require(require.resolve(name, { paths: [workspaceRoot] })) as WrappedPlugin;
};

const fingerprintCommand = (workspaceRoot: string, key: string): Input => {
  // worktree ごとにタスクハッシュが変わらないよう、スクリプトはワークスペースからの相対パスで指す
  const script = relative(workspaceRoot, fileURLToPath(new URL('./fingerprint-cli.js', import.meta.url)));
  return { runtime: `node ${JSON.stringify(script)} ${JSON.stringify(key)}` };
};

const isFileInput = (input: Input): boolean =>
  typeof input === 'string' || 'fileset' in input || 'input' in input || 'dependentTasksOutputFiles' in input;

export const wrapTarget = (
  target: TargetConfiguration,
  fingerprintInput: Input,
): TargetConfiguration & { original_executor: string } => {
  const { executor, command, inputs, options, ...rest } = target;
  return {
    ...rest,
    executor: RUN_EXECUTOR,
    original_executor: executor ?? 'nx:run-commands',
    options: command === undefined ? options : { command, ...options },
    // ファイル入力は依存一覧で置き換え、環境変数・外部依存・runtime input は残す
    inputs: [fingerprintInput, ...(inputs ?? []).filter((input) => !isFileInput(input))],
  };
};

const wrapResult = (
  result: CreateNodesResult,
  targetNames: ReadonlySet<string>,
  workspaceRoot: string,
): CreateNodesResult => ({
  ...result,
  projects: Object.fromEntries(
    Object.entries(result.projects ?? {}).map(([projectRoot, project]) => [
      projectRoot,
      {
        ...project,
        targets: Object.fromEntries(
          Object.entries(project.targets ?? {}).map(([name, target]) => [
            name,
            targetNames.has(name) ? wrapTarget(target, fingerprintCommand(workspaceRoot, taskKey(projectRoot, name))) : target,
          ]),
        ),
      },
    ]),
  ),
});

const createWrappedNodes = async (
  files: readonly string[],
  options: PluginOptions & { wrap: NonNullable<PluginOptions['wrap']> },
  context: CreateNodesContext,
) => {
  const wrapped = loadWrappedPlugin(context.workspaceRoot, options.wrap.plugin);
  const createNodes = wrapped.createNodes ?? wrapped.createNodesV2;
  if (createNodes === undefined) throw new Error(`nx-auto-cache-deps: ${options.wrap.plugin} does not export createNodes`);
  const [pattern, create] = createNodes;
  const matched = files.filter((file) => matchesGlob(file, pattern));
  if (matched.length === 0) return [];
  const targetNames = new Set(options.targets ?? []);
  const results = await create(matched, options.wrap.options, context);
  return results.map(([file, result]) => [file, wrapResult(result, targetNames, context.workspaceRoot)] as const);
};

type ProjectJson = { readonly targets?: Record<string, { readonly executor?: string }> };

const createExplicitNodes = (files: readonly string[], context: CreateNodesContext) =>
  files
    .filter((file) => basename(file) === 'project.json')
    .flatMap((file) => {
      const projectRoot = dirname(file);
      const projectJson = JSON.parse(readFileSync(join(context.workspaceRoot, file), 'utf8')) as ProjectJson;
      const targets = Object.entries(projectJson.targets ?? {})
        .filter(([, target]) => target.executor === RUN_EXECUTOR)
        .map(([name]) => [name, { inputs: [fingerprintCommand(context.workspaceRoot, taskKey(projectRoot, name))] }]);
      return targets.length === 0
        ? []
        : [[file, { projects: { [projectRoot]: { targets: Object.fromEntries(targets) } } }] as const];
    });

// 包むプラグインの glob は登録ごとに違うため、全ファイルを受け取り内側で絞り込む
export const createNodes: CreateNodes<PluginOptions> = [
  '**/*',
  async (files, options, context) => {
    const wrap = options?.wrap;
    return wrap === undefined
      ? createExplicitNodes(files, context)
      : createWrappedNodes(files, { ...options, wrap }, context);
  },
];

export const createDependencies: CreateDependencies<PluginOptions> = (options, context) => {
  const wrap = options?.wrap;
  if (wrap === undefined) return [];
  return loadWrappedPlugin(context.workspaceRoot, wrap.plugin).createDependencies?.(wrap.options, context) ?? [];
};

export const createMetadata: CreateMetadata<PluginOptions> = (graph, options, context) => {
  const wrap = options?.wrap;
  if (wrap === undefined) return {};
  return loadWrappedPlugin(context.workspaceRoot, wrap.plugin).createMetadata?.(graph, wrap.options, context) ?? {};
};
