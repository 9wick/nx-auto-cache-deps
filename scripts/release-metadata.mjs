import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');
export const rootPackageJson = () => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// provenance は package.json の repository と公開元のリポジトリの一致を検証するため、実行中のリポジトリから決める
export const repository = () => {
  const name = process.env.GITHUB_REPOSITORY;
  return name === undefined ? undefined : { type: 'git', url: `git+https://github.com/${name}.git` };
};
