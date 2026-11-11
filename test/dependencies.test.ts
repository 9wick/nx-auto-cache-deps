import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fingerprint, toDependencyList } from '../src/dependencies.ts';

test('親が通常ファイルのパスへの問い合わせを、欠落として評価する', () => {
  const temporary = resolve(import.meta.dirname, '../.tmp');
  mkdirSync(temporary, { recursive: true });
  const workspace = mkdtempSync(join(temporary, 'not-directory-'));
  try {
    writeFileSync(join(workspace, 'index.html'), 'html');
    const list = toDependencyList([{ kind: 'read', path: join(workspace, 'index.html/tsconfig.json') }], workspace, []);
    const missing = fingerprint(list, workspace);
    rmSync(join(workspace, 'index.html'));
    mkdirSync(join(workspace, 'index.html'));
    assert.equal(fingerprint(list, workspace), missing, '親がディレクトリになってもパスは欠落したまま');
    writeFileSync(join(workspace, 'index.html/tsconfig.json'), '{}');
    assert.notEqual(fingerprint(list, workspace), missing, 'パスが出現したら無効化する');
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('ルートの列挙でも Git・Nx のメタデータを入力に含めない', () => {
  const temporary = resolve(import.meta.dirname, '../.tmp');
  mkdirSync(temporary, { recursive: true });
  const workspace = mkdtempSync(join(temporary, 'metadata-'));
  try {
    writeFileSync(join(workspace, 'input.txt'), 'input');
    mkdirSync(join(workspace, '.git'));
    const list = toDependencyList([{ kind: 'readDir', path: workspace }], workspace, []);
    const original = fingerprint(list, workspace);
    rmSync(join(workspace, '.git'), { recursive: true });
    writeFileSync(join(workspace, '.git'), 'gitdir: elsewhere');
    mkdirSync(join(workspace, '.nx'));
    assert.equal(fingerprint(list, workspace), original);
    writeFileSync(join(workspace, 'new-input.txt'), 'new');
    assert.notEqual(fingerprint(list, workspace), original);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('成果物の親でも、通常の入力を含む列挙が新たに見つかったらハッシュを更新する', () => {
  const temporary = resolve(import.meta.dirname, '../.tmp');
  mkdirSync(temporary, { recursive: true });
  const workspace = mkdtempSync(join(temporary, 'new-query-'));
  try {
    writeFileSync(join(workspace, 'input.txt'), 'input');
    const outputs = ['dist/b'];
    const initial = toDependencyList([], workspace, outputs);
    const expanded = toDependencyList([{ kind: 'readDir', path: workspace }], workspace, outputs);
    assert.notEqual(fingerprint(initial, workspace), fingerprint(expanded, workspace));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('成果物だけを含む親の列挙が後から観測されてもハッシュを変えず、他の入力追加は検出する', () => {
  const temporary = resolve(import.meta.dirname, '../.tmp');
  mkdirSync(temporary, { recursive: true });
  const workspace = mkdtempSync(join(temporary, 'output-parent-'));
  try {
    const outputs = ['dist/b'];
    const unobserved = toDependencyList([], workspace, outputs);
    const observed = toDependencyList([{ kind: 'readDir', path: join(workspace, 'dist') }], workspace, outputs);
    const original = fingerprint(unobserved, workspace);
    assert.equal(fingerprint(observed, workspace), original, '親が存在しない');
    mkdirSync(join(workspace, 'dist'));
    assert.equal(fingerprint(observed, workspace), original, '親が空');
    mkdirSync(join(workspace, 'dist/b'));
    writeFileSync(join(workspace, 'dist/b/out.txt'), 'output');
    assert.equal(fingerprint(observed, workspace), original, '成果物だけが存在する');
    writeFileSync(join(workspace, 'dist/input.txt'), 'input');
    assert.notEqual(fingerprint(observed, workspace), original, '成果物以外の入力が増える');
    rmSync(join(workspace, 'dist'), { recursive: true });
    assert.equal(fingerprint(observed, workspace), original, '成果物と親が削除される');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
