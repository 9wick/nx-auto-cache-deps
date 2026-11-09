import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = 'nx-auto-cache-deps';

export type Platform = {
  readonly id: string;
  readonly os: NodeJS.Platform;
  readonly cpu: NodeJS.Architecture;
  readonly libc?: 'glibc';
};

/** トレーサーのバイナリを同梱するプラットフォーム。パッケージには bin/<id>/ として全プラットフォーム分を入れる。 */
export const PLATFORMS: readonly Platform[] = [
  { id: 'linux-x64-gnu', os: 'linux', cpu: 'x64', libc: 'glibc' },
  { id: 'linux-arm64-gnu', os: 'linux', cpu: 'arm64', libc: 'glibc' },
  { id: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
];

export const traceBinaryName = (os: NodeJS.Platform): string =>
  `${PACKAGE_NAME}-trace${os === 'win32' ? '.exe' : ''}`;

/** パッケージ内でのバイナリの位置。パッケージのルートからの相対パス。 */
export const traceBinaryPath = (platform: Platform): string => `bin/${platform.id}/${traceBinaryName(platform.os)}`;

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

/** 実行中の環境に対応する、同梱のトレーサーのバイナリを返す。 */
export const resolveTraceBinary = (): string => {
  const platform = currentPlatform();
  if (platform === undefined) {
    throw new Error(`${PACKAGE_NAME}: ${process.platform}-${process.arch} is not supported`);
  }
  const binary = fileURLToPath(new URL(`../${traceBinaryPath(platform)}`, import.meta.url));
  if (!existsSync(binary)) throw new Error(`${PACKAGE_NAME}: tracer binary is missing: ${binary}`);
  return binary;
};
