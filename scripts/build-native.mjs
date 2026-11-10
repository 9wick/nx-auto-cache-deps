// fspy は cargo の nightly 機能 (bindeps) が必要なため、ツールチェーンは native/rust-toolchain.toml で固定する
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const temporary = join(root, '.tmp');
mkdirSync(temporary, { recursive: true });
const result = spawnSync('cargo', ['build', '-Z', 'bindeps', '--locked', '--release'], {
  cwd: join(root, 'native'),
  stdio: 'inherit',
  env: { ...process.env, CARGO_TARGET_DIR: join(temporary, 'native-target'), TMPDIR: temporary, TMP: temporary, TEMP: temporary },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
