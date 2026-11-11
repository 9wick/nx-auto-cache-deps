import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { selectEnvironment } from '../src/environment.ts';
import { readEnvironmentOptions } from '../src/environment-config.ts';

test('既定ではシステム変数を受け渡し、独自変数とNxのPIDは除く', () => {
  const source = { HOME: '/home/test', PATH: '/bin', CI: 'true', NODE_ENV: 'production', CUSTOM: 'value', NX_INVOCATION_ANCESTOR_PIDS: '123' };
  const selected = selectEnvironment(source, {}, 'linux');
  assert.deepEqual(selected.values, { HOME: '/home/test', PATH: '/bin', CI: 'true', FORCE_COLOR: '1' });
  assert.equal(selectEnvironment({ ...source, CI: 'false', NX_INVOCATION_ANCESTOR_PIDS: '456' }, {}, 'linux').fingerprint, selected.fingerprint);
});

test('envの一致・否定パターンで受渡しとハッシュを選ぶ', () => {
  const options = { env: ['APP_*', '!APP_SECRET'], untrackedEnv: ['NX_*'] };
  const selected = selectEnvironment({ APP_MODE: 'a', APP_SECRET: 'secret', NX_INVOCATION_ANCESTOR_PIDS: '1' }, options, 'linux');
  assert.equal(selected.values.APP_MODE, 'a');
  assert.equal(selected.values.APP_SECRET, undefined);
  assert.equal(selected.values.NX_INVOCATION_ANCESTOR_PIDS, '1');
  assert.equal(selectEnvironment({ APP_MODE: 'a', NX_INVOCATION_ANCESTOR_PIDS: '2' }, options, 'linux').fingerprint, selected.fingerprint);
  assert.notEqual(selectEnvironment({ APP_MODE: 'b' }, options, 'linux').fingerprint, selected.fingerprint);
  assert.notEqual(selectEnvironment({}, options, 'linux').fingerprint, selectEnvironment({ APP_MODE: '' }, options, 'linux').fingerprint);
});

test('envは既定と利用者指定のuntrackedEnvよりも優先する', () => {
  const options = { env: ['CI'], untrackedEnv: ['CI'] };
  assert.notEqual(selectEnvironment({ CI: 'a' }, options).fingerprint, selectEnvironment({ CI: 'b' }, options).fingerprint);
  assert.equal(selectEnvironment({ HOME: '/home/a' }, { untrackedEnv: ['!HOME'] }).values.HOME, undefined);
  assert.equal(selectEnvironment({ HOME: '/home/a' }, { env: ['HOME'], untrackedEnv: ['!HOME'] }).values.HOME, '/home/a');
});

test('Windowsでは変数名を大文字小文字に依存せず選び、同じキーにする', () => {
  const options = { env: ['APP_*'], untrackedEnv: ['NX_*'] };
  const a = selectEnvironment({ Path: '/bin', App_Mode: 'a', nx_pid: '1', 'ProgramFiles(x86)': 'programs' }, options, 'win32');
  const b = selectEnvironment({ PATH: '/bin', APP_MODE: 'a', NX_PID: '2', 'PROGRAMFILES(X86)': 'programs' }, options, 'win32');
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.values.PATH, '/bin');
  assert.equal(a.values.APP_MODE, 'a');
  assert.equal(a.values['PROGRAMFILES(X86)'], 'programs');
});

test('設定変更と明示された色設定をfingerprintへ反映する', () => {
  assert.notEqual(selectEnvironment({}, {}).fingerprint, selectEnvironment({}, { env: ['NEW_VAR'] }).fingerprint);
  const tracked = selectEnvironment({ FORCE_COLOR: '0' }, { env: ['FORCE_COLOR'] });
  assert.equal(tracked.values.FORCE_COLOR, '0');
  assert.notEqual(tracked.fingerprint, selectEnvironment({ FORCE_COLOR: '1' }, { env: ['FORCE_COLOR'] }).fingerprint);
});

const withSettings = (operation: (root: string) => void) => {
  const temporary = resolve(import.meta.dirname, '../.tmp');
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, 'env-config-'));
  try { operation(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
};

test('NxなしでJSONCの共有設定とextendsを読む', () => withSettings(root => {
  assert.deepEqual(readEnvironmentOptions(root), {});
  writeFileSync(join(root, 'base.json'), JSON.stringify({ plugins: [{ plugin: 'nx-auto-cache-deps', options: { env: ['MODE'], untrackedEnv: ['NX_*'] } }] }));
  writeFileSync(join(root, 'nx.json'), '{ // comment\n "extends": "./base.json",\n}');
  assert.deepEqual(readEnvironmentOptions(root), { env: ['MODE'], untrackedEnv: ['NX_*'] });
  writeFileSync(join(root, 'nx.json'), JSON.stringify({ extends: './base.json', plugins: ['nx-auto-cache-deps'] }));
  assert.deepEqual(readEnvironmentOptions(root), {}, 'Nxと同じくplugins配列は置き換える');
}));

test('不正な設定や共有設定の重複をエラーにする', () => withSettings(root => {
  const save = (plugins: unknown) => writeFileSync(join(root, 'nx.json'), JSON.stringify({ plugins }));
  save([{ plugin: 'nx-auto-cache-deps', options: { env: ['MODE', 1] } }]);
  assert.throws(() => readEnvironmentOptions(root), /env must be/);
  save([{ plugin: 'nx-auto-cache-deps', options: { untrackedEnv: ['!'] } }]);
  assert.throws(() => readEnvironmentOptions(root), /untrackedEnv must be/);
  save([{ plugin: 'nx-auto-cache-deps', options: { env: [] } }, { plugin: 'nx-auto-cache-deps', options: { env: ['MODE'] } }]);
  assert.throws(() => readEnvironmentOptions(root), /only one/);
  writeFileSync(join(root, 'nx.json'), '{ bad');
  assert.throws(() => readEnvironmentOptions(root), /Invalid/);
}));
