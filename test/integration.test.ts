// 受け入れ条件 (doc/acceptance.md) を、配布用 tarball を入れた実際の Nx ワークスペースで確かめる。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, globSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { before, describe, test } from 'node:test';
import { fingerprint } from '../src/dependencies.ts';
import { readDependencyList } from '../src/store.ts';

const root = resolve(import.meta.dirname, '..');
const sandbox = join(root, '.tmp', 'test');
const template = join(sandbox, 'template');
const home = join(sandbox, 'home');

const run = (command: string, args: readonly string[], cwd: string) => {
  // npm/pnpm は Windows では .cmd。固定したコマンドとテスト用パスだけをシェルに渡す。
  const batch = process.platform === 'win32' && (command === 'npm' || command === 'pnpm');
  return execFileSync(batch ? `${command}.cmd` : command, batch ? args.map((arg) => `"${arg}"`) : args, {
    cwd, stdio: 'pipe', encoding: 'utf8', shell: batch,
  });
};

const prepareTemplate = async () => {
  run('pnpm', ['build'], root);
  run('node', ['scripts/build-native.mjs'], root);
  const { currentPlatform } = (await import(pathToFileURL(join(root, 'dist/platform.js')).href)) as typeof import('../src/platform.ts');
  const platform = currentPlatform();
  assert.ok(platform, `${process.platform}-${process.arch} is not a supported platform`);
  run('node', ['scripts/stage-binary.mjs', platform.id], root);
  // 配布時と同じく、npm pack で作った tarball を入れる
  const tarball = join(sandbox, run('npm', ['pack', '--silent', '--pack-destination', sandbox], root).trim());
  rmSync(template, { recursive: true, force: true });
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
  'libs/b/project.json': JSON.stringify({
    name: 'b',
    targets: {
      build: {
        executor: 'nx-auto-cache-deps:run',
        original_executor: 'nx:run-commands',
        cache: true,
        outputs: ['{workspaceRoot}/dist/b'],
        options: {
          command: process.platform === 'win32'
            ? 'echo b >> "%RUN_LOG%" && (if not exist "../../dist/b" mkdir "../../dist/b") && type src\\*.txt > "../../dist/b/out.txt"'
            : 'echo b >> "$RUN_LOG" && mkdir -p ../../dist/b && cat src/*.txt > ../../dist/b/out.txt',
          cwd: 'libs/b',
        },
      },
    },
  }),
  'libs/b/src/1.txt': 'b\n',
  'libs/c/project.json': JSON.stringify({
    name: 'c',
    targets: {
      build: {
        executor: 'nx-auto-cache-deps:run',
        original_executor: 'nx:run-commands',
        cache: true,
        inputs: ['autoCacheDeps-build', { env: 'MODE' }],
        outputs: ['{workspaceRoot}/dist/c'],
        options: { command: 'node build.mjs', cwd: 'libs/c' },
      },
    },
  }),
  'libs/c/src/1.txt': 'c\n',
  'libs/c/build.mjs': BUILD_SCRIPT.replaceAll('dist/a', 'dist/c'),
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
  symlinkSync(join(template, 'node_modules'), join(directory, 'node_modules'), 'junction');
  run('git', ['init', '-q', '-b', 'main'], directory);
  run('git', ['config', 'core.autocrlf', 'false'], directory);
  // Nx は remote からワークスペース ID を決め、同じ ID の worktree でキャッシュを共有する
  run('git', ['remote', 'add', 'origin', `https://example.invalid/${name}.git`], directory);
  run('git', ['add', '-A'], directory);
  run('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init'], directory);
  return directory;
};

const runLog = (workspace: string) => join(sandbox, `${basename(workspace)}.runs`);

const nx = (workspace: string, args: readonly string[], log = runLog(workspace), env: Record<string, string> = {}) => {
  const result = spawnSync(process.execPath, [join(template, 'node_modules/nx/dist/bin/nx.js'), ...args, '--output-style=static'], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, NX_DAEMON: 'false', NX_NO_CLOUD: 'true', NX_TUI: 'false', RUN_LOG: log, ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

const runCount = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);

// キャッシュ復元に失敗したとき、依存一覧と実際に評価した入力の差を CI ログに残す。
const cacheSnapshot = (workspace: string): string => {
  const cacheHome = join(home, '.nx');
  return JSON.stringify(globSync('*/cache/nx-auto-cache-deps/dependencies/*.json', { cwd: cacheHome }).map((file) => {
    const stored = readDependencyList(join(cacheHome, file));
    if (stored.status !== 'found') return { file, stored };
    const { list } = stored;
    return {
      file, list, hash: fingerprint(list, workspace),
      paths: list.paths.map((path) => {
        const absolute = join(workspace, path);
        const stats = statSync(absolute, { throwIfNoEntry: false });
        return [path, stats === undefined ? 'missing' : stats.isFile()
          ? createHash('sha256').update(readFileSync(absolute)).digest('hex') : 'directory'];
      }),
      directories: list.directories.map((path) => [path, existsSync(join(workspace, path))
        ? readdirSync(join(workspace, path), { withFileTypes: true }).map((entry) => [entry.name, entry.isDirectory() ? 'd' : entry.isFile() ? 'f' : 'other'])
        : 'missing']),
    };
  }), null, 2);
};

/** 実行してコマンドが動いたかを返す。 */
const build = (workspace: string, target = 'a:build', log = runLog(workspace), env: Record<string, string> = {}): boolean => {
  const before = runCount(log);
  const result = nx(workspace, ['run', target], log, env);
  assert.equal(result.status, 0, result.output);
  return runCount(log) > before;
};

before(async () => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  for (const variable of ['TMPDIR', 'TMP', 'TEMP']) process.env[variable] = sandbox;
  await prepareTemplate();
});

describe('2段階キャッシュ', () => {
  test('A14: 空白・日本語を含むパスでも入力変更を検出し、成果物を復元する', () => {
    const ws = createWorkspace('workspace 日本語 space');
    const input = join(ws, 'libs/a/src/日本語 file.txt');
    writeFileSync(input, '日本語\n');
    assert.equal(build(ws), true);
    assert.equal(build(ws), true);
    assert.equal(build(ws), false);
    writeFileSync(input, '変更\n');
    assert.equal(build(ws), true);
    rmSync(join(ws, 'dist'), { recursive: true });
    assert.equal(build(ws), false);
    assert.equal(readFileSync(join(ws, 'dist/a/out.txt'), 'utf8'), 'one\n変更\n');
  });

  test('A1-A3: 一覧なしは実行し、一覧のキーで保存した結果を復元する', () => {
    const ws = createWorkspace('two-stage');
    assert.equal(build(ws), true, 'A1: 一覧なしで実行');
    assert.equal(build(ws), true, 'A2: 一覧なしの結果は使わず実行');
    assert.equal(build(ws), false, 'A3: 一覧のキーで復元');
    rmSync(join(ws, 'dist'), { recursive: true });
    assert.equal(build(ws), false, 'A3: 成果物を消しても復元');
    assert.equal(readFileSync(join(ws, 'dist/a/out.txt'), 'utf8'), 'one\n');
  });

  test('A3: 成果物の親ディレクトリを確認するコマンドでも、成果物を入力にしない', () => {
    const ws = createWorkspace('outputs');
    assert.equal(build(ws, 'b:build'), true);
    const first = cacheSnapshot(ws);
    assert.equal(build(ws, 'b:build'), true);
    // cmd は成果物が存在すると root の列挙も行う。2回目で依存一覧が拡張され、そのキーでの実行が必要。
    if (process.platform === 'win32') assert.equal(build(ws, 'b:build'), true, '拡張した依存一覧のキーで結果を保存');
    const before = cacheSnapshot(ws);
    const executed = build(ws, 'b:build');
    assert.equal(executed, false, `依存一覧が安定したキーで復元\nFirst: ${first}\nBefore: ${before}\nAfter: ${cacheSnapshot(ws)}`);
    rmSync(join(ws, 'dist'), { recursive: true });
    assert.equal(build(ws, 'b:build'), false, '成果物と親ディレクトリを消しても復元');
    assert.equal(readFileSync(join(ws, 'dist/b/out.txt'), 'utf8'), 'b\n');
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

  test('A13: project.json の inputs から依存一覧のハッシュを named input で参照し、ファイル以外の入力と併用する', () => {
    const ws = createWorkspace('named-input');
    const log = runLog(ws);
    const mode = (value: string) => ({ MODE: value });
    assert.equal(build(ws, 'c:build', log, mode('a')), true);
    assert.equal(build(ws, 'c:build', log, mode('a')), true);
    assert.equal(build(ws, 'c:build', log, mode('a')), false, '依存一覧と環境変数が同じなら復元');
    assert.equal(build(ws, 'c:build', log, mode('b')), true, '宣言した環境変数の変更');
    writeFileSync(join(ws, 'libs/c/src/2.txt'), 'two\n');
    assert.equal(build(ws, 'c:build', log, mode('b')), true, '依存の変化');
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
    symlinkSync(join(template, 'node_modules'), join(b, 'node_modules'), 'junction');
    const aSnapshot = cacheSnapshot(a);
    const bSnapshot = cacheSnapshot(b);
    const executed = build(b, 'a:build', log);
    assert.equal(executed, false, `B は A の一覧と結果を使う\nA: ${aSnapshot}\nB: ${bSnapshot}\nAfter: ${cacheSnapshot(b)}`);
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

// Nx の設定を持たない workspace で、配布物の CLI をそのまま実行する。
const createCommandWorkspace = (name: string, script: string) => {
  const directory = join(sandbox, `cli-${name}`);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(join(directory, '.git'), { recursive: true });
  mkdirSync(join(directory, '.nx'), { recursive: true });
  writeFiles(directory, {
    'package.json': JSON.stringify({ name, private: true }),
    'command.cjs': script,
    'src/a.txt': 'a\n',
    'README.md': 'unrelated\n',
  });
  return directory;
};

const COMMAND_SCRIPT = `
const fs = require('node:fs');
fs.appendFileSync(process.env.CLI_RUN_LOG, (process.argv[2] || 'run') + '\\n');
if (fs.existsSync('fail')) { console.error('failed'); process.exit(3); }
const text = fs.readdirSync('src').sort().map(f => fs.readFileSync('src/' + f, 'utf8')).join('');
const optional = fs.existsSync('optional.txt') ? fs.readFileSync('optional.txt','utf8') : '';
fs.mkdirSync('dist', {recursive:true});
fs.writeFileSync('dist/out.txt', text + optional + (process.env.MODE || ''));
process.stdout.write(Buffer.from([0, 255, 10]));
console.error('stderr');
`;

const commandCli = () => join(template, 'node_modules/nx-auto-cache-deps/dist/cli.js');
const commandEnv = (workspace: string, extra: Record<string, string> = {}) => ({
  ...process.env, CLI_RUN_LOG: join(workspace, '.nx', 'executions'), ...extra,
});
const commandRun = (workspace: string, args: string[] = [process.execPath, 'command.cjs'], extra: Record<string, string> = {}) =>
  spawnSync(process.execPath, [commandCli(), ...args], { cwd: workspace, env: commandEnv(workspace, extra), timeout: 30000 });
const commandCount = (workspace: string) => runCount(join(workspace, '.nx', 'executions'));
const commandSuccess = (workspace: string, args?: string[], extra?: Record<string, string>) => {
  const result = commandRun(workspace, args, extra);
  assert.equal(result.status, 0, result.stderr.toString());
  return result;
};

describe('単独 CLI', () => {
  test('読み取り・列挙・欠落ファイルを入力にし、ログと成果物を2回目から復元する', () => {
    const ws = createCommandWorkspace('日本語 space', COMMAND_SCRIPT);
    const first = commandSuccess(ws);
    const hit = commandSuccess(ws);
    assert.equal(commandCount(ws), 1);
    assert.deepEqual(hit.stdout, first.stdout, 'バイナリstdoutを再生');
    assert.deepEqual(hit.stderr, first.stderr, 'stderrを再生');
    writeFileSync(join(ws, 'README.md'), 'edited\n');
    commandSuccess(ws);
    assert.equal(commandCount(ws), 1);
    writeFileSync(join(ws, 'src/a.txt'), 'A\n');
    commandSuccess(ws);
    assert.equal(commandCount(ws), 2);
    writeFileSync(join(ws, 'src/b.txt'), 'b\n');
    commandSuccess(ws);
    assert.equal(commandCount(ws), 3, '列挙先への追加');
    writeFileSync(join(ws, 'optional.txt'), 'optional\n');
    commandSuccess(ws);
    assert.equal(commandCount(ws), 4, '欠落パスの出現');
    rmSync(join(ws, 'dist'), { recursive: true });
    commandSuccess(ws);
    assert.equal(commandCount(ws), 4);
    assert.equal(readFileSync(join(ws, 'dist/out.txt'), 'utf8'), 'A\nb\noptional\n');
    assert.equal(existsSync(join(ws, 'nx.json')), false);
  });

  test('引数・環境変数・作業ディレクトリをコマンドの識別に含める', () => {
    const ws = createCommandWorkspace('identity', COMMAND_SCRIPT);
    commandSuccess(ws, [process.execPath, 'command.cjs', 'one'], { MODE: 'a' });
    commandSuccess(ws, [process.execPath, 'command.cjs', 'one'], { MODE: 'a' });
    assert.equal(commandCount(ws), 1);
    commandSuccess(ws, [process.execPath, 'command.cjs', 'two'], { MODE: 'a' });
    commandSuccess(ws, [process.execPath, 'command.cjs', 'two'], { MODE: 'b' });
    assert.equal(commandCount(ws), 3);
    const sub = join(ws, 'sub');
    mkdirSync(join(sub, '.nx'), { recursive: true });
    writeFiles(sub, { 'command.cjs': COMMAND_SCRIPT, 'src/a.txt': 'sub\n' });
    commandSuccess(sub, [process.execPath, 'command.cjs', 'two'], { MODE: 'b' });
    assert.equal(commandCount(sub), 1);
  });

  test('失敗は終了コードを保ち、成功キャッシュや依存一覧を置き換えない', () => {
    const ws = createCommandWorkspace('failure', COMMAND_SCRIPT);
    commandSuccess(ws);
    writeFileSync(join(ws, 'fail'), '');
    assert.equal(commandRun(ws).status, 3);
    assert.equal(commandRun(ws).status, 3);
    assert.equal(commandCount(ws), 3);
    rmSync(join(ws, 'fail'));
    commandSuccess(ws);
    assert.equal(commandCount(ws), 3, '元の入力の成功結果を使う');
  });

  test('入力をその場で書き換えるコマンドは、実行前の内容で照合する', () => {
    const ws = createCommandWorkspace('in-place', `
      const fs=require('node:fs');
      fs.appendFileSync(process.env.CLI_RUN_LOG, 'run\\n');
      fs.writeFileSync('value.txt', String(Number(fs.readFileSync('value.txt','utf8')) + 1));
    `);
    writeFileSync(join(ws, 'value.txt'), '1');
    commandSuccess(ws);
    assert.equal(readFileSync(join(ws, 'value.txt'), 'utf8'), '2');
    commandSuccess(ws);
    assert.equal(readFileSync(join(ws, 'value.txt'), 'utf8'), '3');
    writeFileSync(join(ws, 'value.txt'), '2');
    commandSuccess(ws);
    assert.equal(commandCount(ws), 2);
    assert.equal(readFileSync(join(ws, 'value.txt'), 'utf8'), '3');
    commandSuccess(ws);
    assert.equal(commandCount(ws), 3, '異なる実行前入力はスキップしない');
    assert.equal(readFileSync(join(ws, 'value.txt'), 'utf8'), '4');
  });

  test('同じコマンドの同時起動は一度だけ実行し、完成した結果を使う', async () => {
    const ws = createCommandWorkspace('concurrent', `setTimeout(() => { ${COMMAND_SCRIPT} }, 150);`);
    const launch = () => new Promise<void>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [commandCli(), process.execPath, 'command.cjs'], { cwd: ws, env: commandEnv(ws), stdio: 'pipe' });
      let error = '';
      child.stderr.on('data', data => { error += data.toString(); });
      child.stdout.resume();
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(error)));
    });
    await Promise.all([launch(), launch()]);
    assert.equal(commandCount(ws), 1);
    assert.equal(readFileSync(join(ws, 'dist/out.txt'), 'utf8'), 'a\n');
  });

  test('&& で連結したコマンドを個別にキャッシュし、前半の失敗で後半を止める', () => {
    const ws = createCommandWorkspace('chain', `
      const fs=require('node:fs'), name=process.argv[2];
      fs.appendFileSync(process.env.CLI_RUN_LOG,name+'\\n');
      if(fs.existsSync(name+'.fail')) process.exit(3);
      console.log(fs.readFileSync('src/'+name+'.txt','utf8'));
    `);
    writeFileSync(join(ws, 'src/b.txt'), 'b\n');
    const quote = (arg: string) => process.platform === 'win32' ? `"${arg}"` : `'${arg.replaceAll("'", "'\\''")}'`;
    const part = (name: string) => [process.execPath, commandCli(), process.execPath, 'command.cjs', name].map(quote).join(' ');
    const chain = `${part('a')} && ${part('b')}`;
    const runChain = () => spawnSync(chain, { cwd: ws, env: commandEnv(ws), shell: true });
    assert.equal(runChain().status, 0);
    assert.equal(runChain().status, 0);
    assert.equal(commandCount(ws), 2);
    writeFileSync(join(ws, 'src/a.txt'), 'changed\n');
    assert.equal(runChain().status, 0);
    assert.equal(commandCount(ws), 3, 'aだけ再実行');
    writeFileSync(join(ws, 'a.fail'), '');
    assert.equal(runChain().status, 3);
    assert.equal(commandCount(ws), 4, 'bへ進まない');
  });

  test('ローカルのnode_modules/.binからコマンドを解決する', () => {
    const ws = createCommandWorkspace('local-bin', '');
    const bin = join(ws, 'node_modules/.bin');
    mkdirSync(bin, { recursive: true });
    if (process.platform === 'win32') {
      writeFileSync(join(bin, 'fixture.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0..\\tool.cjs" %*\r\n`);
    } else {
      writeFileSync(join(bin, 'fixture'), `#!/usr/bin/env node\nrequire('../tool.cjs');\n`, { mode: 0o755 });
    }
    writeFileSync(join(ws, 'node_modules/tool.cjs'), `console.log(process.argv.slice(2).join('|'));`);
    const first = commandSuccess(ws, ['fixture', 'space 日本語', 'amp&value']);
    const hit = commandSuccess(ws, ['fixture', 'space 日本語', 'amp&value']);
    assert.equal(first.stdout.toString().trim(), 'space 日本語|amp&value');
    assert.deepEqual(hit.stdout, first.stdout);
  });

  test('ヘルプと見つからないコマンドを明示する', () => {
    const ws = createCommandWorkspace('usage', '');
    assert.match(commandRun(ws, ['--help']).stdout.toString(), /Usage:/);
    assert.equal(commandRun(ws, []).status, 2);
    const missing = commandRun(ws, ['nx-auto-cache-deps-command-does-not-exist']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr.toString(), /Command not found/);
  });
});

describe('CLI キャッシュの整合性', () => {
  test('既存ディレクトリへの mkdir で、その下の入力を除外しない', () => {
    const ws = createCommandWorkspace('existing-directory', `
      const fs=require('node:fs');
      fs.appendFileSync(process.env.CLI_RUN_LOG,'run\\n');
      fs.mkdirSync('src',{recursive:true});
      fs.mkdirSync('dist',{recursive:true});
      fs.writeFileSync('dist/out.txt',fs.readFileSync('src/a.txt'));
    `);
    commandSuccess(ws);
    commandSuccess(ws);
    assert.equal(commandCount(ws), 1);
    writeFileSync(join(ws, 'src/a.txt'), 'changed\n');
    commandSuccess(ws);
    assert.equal(commandCount(ws), 2);
    assert.equal(readFileSync(join(ws, 'dist/out.txt'), 'utf8'), 'changed\n');
  });

  test('ログが壊れていたら成果物を変更する前にエラーにする', () => {
    const ws = createCommandWorkspace('corrupt-log', COMMAND_SCRIPT);
    commandSuccess(ws);
    const cache = join(ws, '.nx/nx-auto-cache-deps/commands');
    const logs = globSync('*/entries/*/log', { cwd: cache });
    assert.equal(logs.length, 1);
    const log = logs[0];
    assert.ok(log);
    writeFileSync(join(cache, log), Buffer.from([0]));
    writeFileSync(join(ws, 'dist/out.txt'), 'user content');
    const result = commandRun(ws);
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /cached log/);
    assert.equal(readFileSync(join(ws, 'dist/out.txt'), 'utf8'), 'user content');
    assert.equal(commandCount(ws), 1);
  });

  test('成果物が壊れていたら再実行で隠さずエラーにする', () => {
    const ws = createCommandWorkspace('corrupt-output', COMMAND_SCRIPT);
    commandSuccess(ws);
    const cache = join(ws, '.nx/nx-auto-cache-deps/commands');
    const files = globSync('*/entries/*/files/*', { cwd: cache });
    const file = files[0];
    assert.ok(file);
    writeFileSync(join(cache, file), 'corrupt');
    const result = commandRun(ws);
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /corrupt/);
    assert.equal(commandCount(ws), 1);
  });

  test('追跡されなかった削除を検出した場合はキャッシュしない', () => {
    const ws = createCommandWorkspace('untracked-delete', `
      const fs=require('node:fs');
      fs.appendFileSync(process.env.CLI_RUN_LOG,'run\\n');
      fs.unlinkSync('erase.txt');
    `);
    for (const value of ['one','two']) {
      writeFileSync(join(ws, 'erase.txt'), value);
      const result = commandSuccess(ws);
      assert.equal(existsSync(join(ws, 'erase.txt')), false);
      assert.match(result.stderr.toString(), /untracked filesystem changes/);
    }
    assert.equal(commandCount(ws), 2);
  });

  test('symlink と実行権限を成果物として復元する', { skip: process.platform === 'win32' ? 'Windowsのsymlink作成には追加権限が必要' : false }, () => {
    const ws = createCommandWorkspace('output-types', `
      const fs=require('node:fs');
      fs.appendFileSync(process.env.CLI_RUN_LOG,'run\\n');
      fs.mkdirSync('dist',{recursive:true});
      fs.writeFileSync('dist/tool','hello');
      fs.chmodSync('dist/tool',0o755);
      fs.symlinkSync('tool','dist/link');
    `);
    commandSuccess(ws);
    rmSync(join(ws, 'dist'), { recursive: true });
    commandSuccess(ws);
    assert.equal(commandCount(ws), 1);
    assert.equal(readFileSync(join(ws, 'dist/link'), 'utf8'), 'hello');
    assert.equal(statSync(join(ws, 'dist/tool')).mode & 0o777, 0o755);
  });
});

describe('CLI の起動と中断', () => {
  test('インストールした bin から起動できる', () => {
    const ws = createCommandWorkspace('installed-bin', '');
    const binary = join(template, 'node_modules/.bin', process.platform === 'win32' ? 'nx-auto-cache-deps.cmd' : 'nx-auto-cache-deps');
    const result = spawnSync(process.platform === 'win32' ? `"${binary}"` : binary, ['--help'], {
      cwd: ws, env: commandEnv(ws), shell: process.platform === 'win32', encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
  });

  test('同じ内容のファイルを指す symlink の変更も入力変更として扱う', { skip: process.platform === 'win32' ? 'Windowsのsymlink作成には追加権限が必要' : false }, () => {
    const ws = createCommandWorkspace('link-input', `
      const fs=require('node:fs');
      fs.appendFileSync(process.env.CLI_RUN_LOG,'run\\n');
      console.log(fs.readlinkSync('link'));
    `);
    writeFileSync(join(ws, 'first'), 'same');
    writeFileSync(join(ws, 'second'), 'same');
    symlinkSync('first', join(ws, 'link'));
    commandSuccess(ws);
    commandSuccess(ws);
    assert.equal(commandCount(ws), 1);
    rmSync(join(ws, 'link'));
    symlinkSync('second', join(ws, 'link'));
    const result = commandSuccess(ws);
    assert.equal(commandCount(ws), 2);
    assert.equal(result.stdout.toString().trim(), 'second');
  });

  test('SIGTERM で子プロセスを停止し、ロックを解放する', { skip: process.platform === 'win32' ? 'POSIXプロセスグループの中断を検証する' : false }, async () => {
    const ws = createCommandWorkspace('signal', `
      const fs=require('node:fs');
      if(fs.existsSync('.nx/release')) { console.log('finished'); }
      else {
        fs.writeFileSync('.nx/started','');
        setTimeout(() => fs.writeFileSync('.nx/late-write',''), 1000);
      }
    `);
    const child = spawn(process.execPath, [commandCli(), process.execPath, 'command.cjs'], { cwd: ws, env: commandEnv(ws), stdio: 'pipe' });
    child.stdout.resume();
    child.stderr.resume();
    const closed = new Promise<number | null>((resolvePromise, reject) => {
      child.once('error', reject);
      child.once('exit', resolvePromise);
    });
    try {
      const deadline = Date.now() + 10000;
      while (!existsSync(join(ws, '.nx/started'))) {
        assert.ok(Date.now() < deadline, '子プロセスが起動する');
        await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
      }
      child.kill('SIGTERM');
      assert.equal(await closed, 143);
      writeFileSync(join(ws, '.nx/release'), '');
      commandSuccess(ws);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1100));
      assert.equal(existsSync(join(ws, '.nx/late-write')), false, '中断した子が書き込み続けない');
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
  });
});
