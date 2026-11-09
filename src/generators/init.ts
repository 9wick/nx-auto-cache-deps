import { formatFiles, readNxJson, updateNxJson, type Tree } from '@nx/devkit';

const PLUGIN = 'nx-auto-cache-deps';

/**
 * `nx add nx-auto-cache-deps` から呼ばれ、nx.json の plugins に本プラグインを登録する。
 * project.json で executor を差し替えた target は wrap なしの登録が扱うため、wrap 付きの登録だけでは登録済みとしない。
 */
export default async function init(tree: Tree): Promise<void> {
  const nxJson = readNxJson(tree) ?? {};
  const plugins = nxJson.plugins ?? [];
  const registered = plugins.some((entry) =>
    typeof entry === 'string'
      ? entry === PLUGIN
      : entry.plugin === PLUGIN && (entry.options as { wrap?: unknown } | undefined)?.wrap === undefined,
  );
  if (registered) return;
  updateNxJson(tree, { ...nxJson, plugins: [...plugins, PLUGIN] });
  await formatFiles(tree);
}
