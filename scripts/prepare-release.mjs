// 公開前に、タグとバージョンの一致と、全プラットフォームのバイナリの同梱を確かめ、repository を書き込む。
// 使い方: node scripts/prepare-release.mjs <tag>   (tag は v<version>)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PLATFORMS, traceBinaryPath } from '../dist/platform.js';

const root = resolve(import.meta.dirname, '..');
const packageJsonPath = join(root, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const tag = process.argv[2];
if (tag !== `v${packageJson.version}`) {
  throw new Error(`tag ${tag} does not match package.json version ${packageJson.version}`);
}
const missing = PLATFORMS.map(traceBinaryPath).filter((path) => !existsSync(join(root, path)));
if (missing.length > 0) throw new Error(`missing tracer binaries: ${missing.join(', ')}`);

const repository = process.env.GITHUB_REPOSITORY;
if (repository === undefined) throw new Error('GITHUB_REPOSITORY is not set');
// provenance は package.json の repository と公開元のリポジトリの一致を検証するため、実行中のリポジトリから決める
packageJson.repository = { type: 'git', url: `git+https://github.com/${repository}.git` };
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
