// fspy は cargo の nightly 機能 (bindeps) が必要なため、ツールチェーンは native/rust-toolchain.toml で固定する
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const result = spawnSync('cargo', ['build', '-Z', 'bindeps', '--locked', '--release'], {
  cwd: join(root, 'native'),
  stdio: 'inherit',
  env: { ...process.env, CARGO_TARGET_DIR: join(root, '.tmp', 'native-target'), TMPDIR: join(root, '.tmp') },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
