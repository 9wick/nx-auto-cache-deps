import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fingerprint, toDependencyList } from '../src/dependencies.ts';

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
