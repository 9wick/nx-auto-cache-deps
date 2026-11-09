// ビルドしたトレーサーを、パッケージに同梱する位置 bin/<platform-id>/ に置く。
// 使い方: node scripts/stage-binary.mjs <platform-id>
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PLATFORMS, traceBinaryName, traceBinaryPath } from '../dist/platform.js';

const root = resolve(import.meta.dirname, '..');
const platform = PLATFORMS.find((candidate) => candidate.id === process.argv[2]);
if (platform === undefined) throw new Error(`unknown platform: ${process.argv[2]}`);
const destination = join(root, traceBinaryPath(platform));
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(join(root, '.tmp', 'native-target', 'release', traceBinaryName(platform.os)), destination);
chmodSync(destination, 0o755);
