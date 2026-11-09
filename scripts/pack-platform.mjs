// 現在のプラットフォーム用の OS 別パッケージを .tmp/platform/<id>/ に組み立てる。
// 使い方: node scripts/pack-platform.mjs <platform-id>
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLATFORMS, platformPackageName, traceBinaryName } from '../dist/platform.js';
import { repository, root, rootPackageJson } from './release-metadata.mjs';

const id = process.argv[2];
const platform = PLATFORMS.find((candidate) => candidate.id === id);
if (platform === undefined) throw new Error(`unknown platform: ${id}`);

const { version, license } = rootPackageJson();
const binary = traceBinaryName(platform.os);
const directory = join(root, '.tmp', 'platform', platform.id);
rmSync(directory, { recursive: true, force: true });
mkdirSync(join(directory, 'bin'), { recursive: true });
copyFileSync(join(root, '.tmp', 'native-target', 'release', binary), join(directory, 'bin', binary));
chmodSync(join(directory, 'bin', binary), 0o755);
writeFileSync(
  join(directory, 'package.json'),
  `${JSON.stringify(
    {
      name: platformPackageName(platform),
      version,
      description: `File access tracer of nx-auto-cache-deps for ${platform.id}`,
      license,
      repository: repository(),
      os: [platform.os],
      cpu: [platform.cpu],
      ...(platform.libc === undefined ? {} : { libc: [platform.libc] }),
      files: ['bin'],
      // npm は bin に登録したファイルにだけ実行権限を付けてインストールする
      bin: { [binary.replace(/\.exe$/, '')]: `bin/${binary}` },
    },
    null,
    2,
  )}\n`,
);
console.log(directory);
