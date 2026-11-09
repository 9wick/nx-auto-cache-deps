// 本体の package.json に、同じバージョンの OS 別パッケージを optionalDependencies として書き込む。
// 使い方: node scripts/prepare-release.mjs <tag>   (tag は v<version>)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLATFORMS, platformPackageName } from '../dist/platform.js';
import { repository, root, rootPackageJson } from './release-metadata.mjs';

const packageJson = rootPackageJson();
const tag = process.argv[2];
if (tag !== `v${packageJson.version}`) {
  throw new Error(`tag ${tag} does not match package.json version ${packageJson.version}`);
}
const updated = {
  ...packageJson,
  repository: repository(),
  optionalDependencies: Object.fromEntries(PLATFORMS.map((platform) => [platformPackageName(platform), packageJson.version])),
};
writeFileSync(join(root, 'package.json'), `${JSON.stringify(updated, null, 2)}\n`);
