# リリース手順

## 構成

| パッケージ | 中身 |
| --- | --- |
| `nx-auto-cache-deps` | プラグイン本体。OS 別パッケージを `optionalDependencies` に持ち、インストールした環境に合うものだけが入る |
| `nx-auto-cache-deps-<platform>` | その環境用のトレーサー (`bin/nx-auto-cache-deps-trace`) だけ |

配布するプラットフォームは `src/platform.ts` の `PLATFORMS` で決める。`.github/workflows/build.yml` の matrix も同じ id にそろえる。

| ワークフロー | タイミング | 内容 |
| --- | --- | --- |
| `ci.yml` | PR・`main` への push | `build.yml` を実行する |
| `build.yml` | ほかのワークフローから呼ばれる | プラットフォームごとに型検査・統合テストを行い、OS 別パッケージの tarball を作る |
| `release.yml` | `v<version>` タグの push | `build.yml` の後、OS 別パッケージ → 本体の順に npm へ公開する |

npm への認証は Trusted Publishing (OIDC) で行い、provenance は自動で付く。
`repository` は公開を実行したリポジトリ (`GITHUB_REPOSITORY`) から決めるため、リポジトリを移しても書き換えは不要。移した後は、npm 側の Trusted Publishing の設定だけを新しいリポジトリに直す。

## 毎回のリリース

1. `package.json` の `version` を上げてコミットする。
2. `v<version>` のタグを push する。タグとバージョンが一致しなければ、何も公開せずに失敗する。

## 前提

公開する全パッケージ（本体と各 OS 別パッケージ）が npm に存在し、Trusted Publishing にこのリポジトリと workflow `release.yml` が登録されていること。
`PLATFORMS` にプラットフォームを追加したときは、そのパッケージも同じ状態にしておく。
