import { cacheDir, getOutputsForTargetAndConfiguration, logger, type ExecutorContext } from '@nx/devkit';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeDependencyLists, toDependencyList, toOutputPaths, type TraceReport } from './dependencies.js';
import { resolveTraceBinary } from './platform.js';
import type { OriginalExecution } from './run-original.js';
import { dependencyListPath, readDependencyList, storeDirectory, taskKey, writeDependencyList } from './store.js';

const runOriginalScript = fileURLToPath(new URL('./run-original.js', import.meta.url));

const runTraced = (args: readonly string[], cwd: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(resolveTraceBinary(), args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });

export default async function run(options: Record<string, unknown>, context: ExecutorContext): Promise<{ success: boolean }> {
  const { projectName, targetName } = context;
  if (projectName === undefined || targetName === undefined) throw new Error('nx-auto-cache-deps: missing task target');
  const project = context.projectsConfigurations.projects[projectName];
  const target = project?.targets?.[targetName] as { original_executor?: unknown } | undefined;
  if (project === undefined || typeof target?.original_executor !== 'string') {
    throw new Error(`nx-auto-cache-deps: ${projectName}:${targetName} needs "original_executor"`);
  }

  const runs = join(storeDirectory(cacheDir), 'runs');
  mkdirSync(runs, { recursive: true });
  const work = mkdtempSync(join(runs, 'run-'));
  try {
    const payload = join(work, 'execution.json');
    const reportPath = join(work, 'report.json');
    const execution: OriginalExecution = { executor: target.original_executor, options, context };
    writeFileSync(payload, JSON.stringify(execution));

    const code = await runTraced([reportPath, process.execPath, runOriginalScript, payload], process.cwd());
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as TraceReport;
    if (report.status === 'incomplete') {
      logger.warn(`nx-auto-cache-deps: tracing of ${projectName}:${targetName} was incomplete, dependency list not updated: ${report.reason}`);
    } else if (code === 0) {
      const listPath = dependencyListPath(cacheDir, taskKey(project.root, targetName));
      const node = context.projectGraph.nodes[projectName];
      if (node === undefined) throw new Error(`nx-auto-cache-deps: ${projectName} is not in the project graph`);
      const outputs = getOutputsForTargetAndConfiguration(
        { project: projectName, target: targetName, ...(context.configurationName === undefined ? {} : { configuration: context.configurationName }) },
        options,
        node,
      );
      const observed = toDependencyList(report.accesses, context.root, toOutputPaths(outputs));
      const stored = readDependencyList(listPath);
      writeDependencyList(listPath, stored.status === 'found' ? mergeDependencyLists(stored.list, observed) : observed);
    }
    return { success: code === 0 };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
