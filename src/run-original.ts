// 追跡下の子プロセスで、元の executor を Nx の executors.json の規約どおりに解決して実行する。
import type { ExecutorContext } from '@nx/devkit';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export type OriginalExecution = {
  readonly executor: string;
  readonly options: Record<string, unknown>;
  readonly context: ExecutorContext;
};

type ExecutorResult = { readonly success: boolean };
type ExecutorImplementation = (
  options: Record<string, unknown>,
  context: ExecutorContext,
) => Promise<ExecutorResult> | AsyncIterable<ExecutorResult>;

type ExecutorsJson = {
  readonly executors?: Record<string, { readonly implementation: string; readonly schema: string }>;
};
type Schema = { readonly properties?: Record<string, { readonly default?: unknown }> };

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

const resolveExecutor = (workspaceRoot: string, name: string) => {
  const separator = name.lastIndexOf(':');
  const packageName = name.slice(0, separator);
  const executorName = name.slice(separator + 1);
  const packageJsonPath = createRequire(join(workspaceRoot, 'package.json')).resolve(`${packageName}/package.json`);
  const packageJson = readJson<{ executors?: string; builders?: string }>(packageJsonPath);
  const executorsFile = packageJson.executors ?? packageJson.builders;
  if (executorsFile === undefined) throw new Error(`${packageName} does not declare executors`);
  const executorsJsonPath = join(dirname(packageJsonPath), executorsFile);
  const entry = readJson<ExecutorsJson>(executorsJsonPath).executors?.[executorName];
  if (entry === undefined) throw new Error(`executor ${name} not found`);
  const base = dirname(executorsJsonPath);
  const [modulePath = '', exportName = 'default'] = entry.implementation.split('#');
  const module = createRequire(executorsJsonPath)(join(base, modulePath)) as Record<string, unknown> | ExecutorImplementation;
  const implementation = typeof module === 'function' ? module : module[exportName];
  if (typeof implementation !== 'function') throw new Error(`executor ${name} has no implementation`);
  return { implementation: implementation as ExecutorImplementation, schema: readJson<Schema>(join(base, entry.schema)) };
};

// Nx は executor の schema の既定値を補ってから呼ぶ。外側の executor はそれを内側の schema で行えないため、ここで補う
const withDefaults = (schema: Schema, options: Record<string, unknown>): Record<string, unknown> => ({
  ...Object.fromEntries(
    Object.entries(schema.properties ?? {}).flatMap(([key, property]) =>
      property.default === undefined ? [] : [[key, property.default]],
    ),
  ),
  ...options,
});

const lastResult = async (output: Promise<ExecutorResult> | AsyncIterable<ExecutorResult>): Promise<ExecutorResult> => {
  if (!(Symbol.asyncIterator in output)) return output;
  let last: ExecutorResult = { success: false };
  for await (const result of output) last = result;
  return last;
};

const path = process.argv[2];
if (path === undefined) throw new Error('nx-auto-cache-deps: missing execution file');
const { executor, options, context } = readJson<OriginalExecution>(path);
const { implementation, schema } = resolveExecutor(context.root, executor);
const result = await lastResult(implementation(withDefaults(schema, options), context));
process.exitCode = result.success ? 0 : 1;
