import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const PACKAGE_NAME = 'nx-auto-cache-deps';

export type Platform = {
  readonly id: string;
  readonly os: NodeJS.Platform;
  readonly cpu: NodeJS.Architecture;
  readonly libc?: 'glibc';
};

/** トレーサーのバイナリを配布するプラットフォーム。リリース時は各 id ごとに OS 別パッケージを公開する。 */
export const PLATFORMS: readonly Platform[] = [
  { id: 'linux-x64-gnu', os: 'linux', cpu: 'x64', libc: 'glibc' },
  { id: 'linux-arm64-gnu', os: 'linux', cpu: 'arm64', libc: 'glibc' },
  { id: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
];

export const platformPackageName = (platform: Platform): string => `${PACKAGE_NAME}-${platform.id}`;

export const traceBinaryName = (os: NodeJS.Platform): string =>
  `${PACKAGE_NAME}-trace${os === 'win32' ? '.exe' : ''}`;

const isGlibc = (): boolean => {
  const header = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header;
  return header?.glibcVersionRuntime !== undefined;
};

export const currentPlatform = (): Platform | undefined =>
  PLATFORMS.find(
    (platform) =>
      platform.os === process.platform &&
      platform.cpu === process.arch &&
      (platform.libc === undefined || isGlibc()),
  );

/** 実行中の環境に対応する OS 別パッケージから、トレーサーのバイナリを探す。 */
export const resolveTraceBinary = (): string => {
  const platform = currentPlatform();
  if (platform === undefined) {
    throw new Error(`${PACKAGE_NAME}: ${process.platform}-${process.arch} is not supported`);
  }
  const name = platformPackageName(platform);
  let packageJson: string;
  try {
    packageJson = createRequire(import.meta.url).resolve(`${name}/package.json`);
  } catch (error) {
    throw new Error(`${PACKAGE_NAME}: ${name} is not installed. Reinstall ${PACKAGE_NAME} with optional dependencies enabled.`, {
      cause: error,
    });
  }
  return join(dirname(packageJson), 'bin', traceBinaryName(platform.os));
};
