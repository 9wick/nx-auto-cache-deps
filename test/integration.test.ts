// 受け入れ条件 (doc/acceptance.md) を、配布用 tarball を入れた実際の Nx ワークスペースで確かめる。
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { before, describe, test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const sandbox = join(root, '.tmp', 'test');
const template = join(sandbox, 'template');
const home = join(sandbox, 'home');

const run = (command: string, args: readonly string[], cwd: string) =>
  execFileSync(command, args, { cwd, stdio: 'pipe', encoding: 'utf8' });

const prepareTemplate = async () => {
  run('pnpm', ['build'], root);
  run('node', ['scripts/build-native.mjs'], root);
  const { currentPlatform } = (await import(join(root, 'dist/platform.js'))) as typeof import('../src/platform.ts');
  const platform = currentPlatform();
  assert.ok(platform, `${process.platform}-${process.arch} is not a supported platform`);
  run('node', ['scripts/stage-binary.mjs', platform.id], root);
  // 配布時と同じく、npm pack で作った tarball を入れる
  const tarball = join(sandbox, run('npm', ['pack', '--silent', '--pack-destination', sandbox], root).trim());
  mkdirSync(template, { recursive: true });
  writeFileSync(join(template, 'package.json'), JSON.stringify({ name: 'template', private: true, type: 'module' }));
  run('npm', ['install', '--no-audit', '--no-fund', 'nx@24.0.5', '@nx/vite@24.0.5', 'vite@8.3.6', tarball], template);
};

type Files = Record<string, string>;

const writeFiles = (directory: string, files: Files) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
};

const BUILD_SCRIPT = `
import { appendFileSync, existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
appendFileSync(process.env.RUN_LOG, 'a\\n');
if (existsSync('src/fail.txt')) process.exit(1);
const files = globSync('src/*.txt').sort();
const optional = existsSync('optional.txt') ? readFileSync('optional.txt', 'utf8') : '';
mkdirSync('../../dist/a', { recursive: true });
writeFileSync('../../dist/a/out.txt', files.map((f) => readFileSync(f, 'utf8')).join('') + optional);
`;

const workspaceFiles = (plugins: unknown[]): Files => ({
  '.gitignore': 'node_modules\ndist\n.nx\n',
  'nx.json': JSON.stringify({ plugins }),
  'libs/a/project.json': JSON.stringify({
    name: 'a',
    targets: {
      build: {
        executor: 'nx-auto-cache-deps:run',
        original_executor: 'nx:run-commands',
        cache: true,
        outputs: ['{workspaceRoot}/dist/a'],
        options: { command: 'node build.mjs', cwd: 'libs/a' },
      },
    },
  }),
  'libs/a/build.mjs': BUILD_SCRIPT,
  'libs/a/src/1.txt': 'one\n',
  'libs/a/README.md': 'unrelated\n',
  'apps/web/project.json': JSON.stringify({ name: 'web' }),
  'apps/web/vite.config.ts': 'export default {};\n',
  'apps/web/index.html': '<script type="module" src="/src/main.js"></script>\n',
  'apps/web/src/main.js': 'console.log("web");\n',
});

const PLUGINS = [
  'nx-auto-cache-deps',
  { plugin: 'nx-auto-cache-deps', options: { wrap: { plugin: '@nx/vite/plugin', options: {} }, targets: ['build'] } },
];

const createWorkspace = (name: string) => {
  const directory = join(sandbox, name);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  writeFiles(directory, workspaceFiles(PLUGINS));
  // Nx は外部依存のバージョンを package.json とロックファイルから解決する
  for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(template, file), join(directory, file));
  symlinkSync(join(template, 'node_modules'), join(directory, 'node_modules'));
  run('git', ['init', '-q', '-b', 'main'], directory);
  // Nx は remote からワークスペース ID を決め、同じ ID の worktree でキャッシュを共有する
  run('git', ['remote', 'add', 'origin', `https://example.invalid/${name}.git`], directory);
  run('git', ['add', '-A'], directory);
  run('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init'], directory);
  return directory;
};

const runLog = (workspace: string) => join(sandbox, `${workspace.split('/').pop()}.runs`);

const nx = (workspace: string, args: readonly string[], log = runLog(workspace)) => {
  const result = spawnSync(join(template, 'node_modules/.bin/nx'), [...args, '--output-style=static'], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, NX_DAEMON: 'false', NX_NO_CLOUD: 'true', NX_TUI: 'false', RUN_LOG: log },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

const runCount = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);

/** 実行してコマンドが動いたかを返す。 */
const build = (workspace: string, target = 'a:build', log = runLog(workspace)): boolean => {
  const before = runCount(log);
  const result = nx(workspace, ['run', target], log);
  assert.equal(result.status, 0, result.output);
  return runCount(log) > before;
};

before(async () => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  await prepareTemplate();
});

describe('2段階キャッシュ', () => {
  test('A1-A3: 一覧なしは実行し、一覧のキーで保存した結果を復元する', () => {
    const ws = createWorkspace('two-stage');
    assert.equal(build(ws), true, 'A1: 一覧なしで実行');
    assert.equal(build(ws), true, 'A2: 一覧なしの結果は使わず実行');
    assert.equal(build(ws), false, 'A3: 一覧のキーで復元');
    rmSync(join(ws, 'dist'), { recursive: true });
    assert.equal(build(ws), false, 'A3: 成果物を消しても復元');
    assert.equal(readFileSync(join(ws, 'dist/a/out.txt'), 'utf8'), 'one\n');
  });

  test('A4-A7: 依存の変化だけを検出する', () => {
    const ws = createWorkspace('changes');
    build(ws);
    build(ws);
    writeFileSync(join(ws, 'libs/a/README.md'), 'edited\n');
    assert.equal(build(ws), false, 'A5: 読んでいないファイル');
    writeFileSync(join(ws, 'libs/a/src/1.txt'), 'ONE\n');
    assert.equal(build(ws), true, 'A4: 読んだファイル');
    writeFileSync(join(ws, 'libs/a/src/2.txt'), 'two\n');
    assert.equal(build(ws), true, 'A6: 列挙したディレクトリへの追加');
    writeFileSync(join(ws, 'libs/a/optional.txt'), 'opt\n');
    assert.equal(build(ws), true, 'A7: 存在しなかったファイルの作成');
    assert.equal(readFileSync(join(ws, 'dist/a/out.txt'), 'utf8'), 'ONE\ntwo\nopt\n');
    assert.equal(build(ws), false);
  });

  test('A8: 失敗した実行では依存一覧を作らない', () => {
    const ws = createWorkspace('failure');
    writeFileSync(join(ws, 'libs/a/src/fail.txt'), '');
    assert.notEqual(nx(ws, ['run', 'a:build']).status, 0);
    rmSync(join(ws, 'libs/a/src/fail.txt'));
    assert.equal(build(ws), true);
    assert.equal(build(ws), true, '失敗時に一覧が作られていれば、ここで復元される');
  });
});

describe('Nx との接続', () => {
  test('A9: 推論プラグインを包み、選んだ target だけ組み替える', () => {
    const ws = createWorkspace('wrap');
    const targets = JSON.parse(nx(ws, ['show', 'project', 'web', '--json']).output.split('\n').find((l) => l.startsWith('{')) ?? '{}').targets;
    assert.equal(targets.build.executor, 'nx-auto-cache-deps:run');
    assert.equal(targets.build.original_executor, 'nx:run-commands');
    assert.deepEqual(targets.build.options, { command: 'vite build', cwd: 'apps/web' });
    assert.deepEqual(targets.build.outputs, ['{projectRoot}/dist']);
    assert.deepEqual(targets.build.dependsOn, ['^build']);
    assert.notEqual(targets.serve.executor, 'nx-auto-cache-deps:run');

    const viteBuilt = () => {
      const result = nx(ws, ['run', 'web:build']);
      assert.equal(result.status, 0, result.output);
      return !result.output.includes('[local cache]');
    };
    assert.equal(viteBuilt(), true);
    assert.equal(viteBuilt(), true);
    assert.equal(viteBuilt(), false, 'Vite のビルドも3回目で復元');
    writeFileSync(join(ws, 'apps/web/src/main.js'), 'console.log("changed");\n');
    assert.equal(viteBuilt(), true, 'Vite が読んだソースの変更');
    assert.match(readFileSync(join(ws, 'apps/web/dist/index.html'), 'utf8'), /script/);
  });

  test('A10: project.json で差し替えた executor は元の executor を元の options で動かす', () => {
    const ws = createWorkspace('explicit');
    build(ws);
    assert.equal(readFileSync(join(ws, 'dist/a/out.txt'), 'utf8'), 'one\n');
  });

  test('A11: worktree 間で依存一覧と実行結果を共有する', () => {
    const a = createWorkspace('worktree-a');
    const log = runLog(a);
    build(a, 'a:build', log);
    build(a, 'a:build', log);
    const b = join(sandbox, 'worktree-b');
    rmSync(b, { recursive: true, force: true });
    run('git', ['worktree', 'prune'], a);
    run('git', ['worktree', 'add', '-q', b], a);
    symlinkSync(join(template, 'node_modules'), join(b, 'node_modules'));
    assert.equal(build(b, 'a:build', log), false, 'B は A の一覧と結果を使う');
    assert.equal(readFileSync(join(b, 'dist/a/out.txt'), 'utf8'), 'one\n');
    writeFileSync(join(b, 'libs/a/src/1.txt'), 'changed in b\n');
    assert.equal(build(b, 'a:build', log), true, 'B だけの変更は A の結果を使わない');
  });

  test('A12: init は wrap なしの登録を1つだけにする', () => {
    const ws = createWorkspace('init');
    const wrapOnly = PLUGINS.filter((entry) => typeof entry !== 'string');
    writeFileSync(join(ws, 'nx.json'), JSON.stringify({ plugins: wrapOnly }));
    for (let i = 0; i < 2; i++) assert.equal(nx(ws, ['g', 'nx-auto-cache-deps:init']).status, 0);
    const plugins = JSON.parse(readFileSync(join(ws, 'nx.json'), 'utf8')).plugins;
    assert.deepEqual(plugins, [...wrapOnly, 'nx-auto-cache-deps']);
  });
});
