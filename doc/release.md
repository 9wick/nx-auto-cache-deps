# リリース手順

## 構成

npm に公開するのは `nx-auto-cache-deps` の1パッケージだけ。全プラットフォームのトレーサーを `bin/<platform>/nx-auto-cache-deps-trace` として同梱し、実行時に環境に合うものを使う。
同梱するプラットフォームは `src/platform.ts` の `PLATFORMS` で決める。`.github/workflows/build.yml` の matrix と `build-musl` も同じ id にそろえる。
Windows x64 は `bin/win32-x64-msvc/nx-auto-cache-deps-trace.exe` に同梱する。Windows でのビルドには MSVC の C++ ビルドツールが必要（CI の Windows runner には導入済み）。
macOS x64 は Intel runner、Linux x64 musl は Ubuntu runner 上の Alpine コンテナでビルド・統合テストする。musl の検証は `scripts/ci-musl.sh` を使い、fspy の seccomp による追跡を許可するためコンテナに `--security-opt seccomp=unconfined` を指定する。

`package.json` の `preferUnplugged` は、Yarn の PnP でもバイナリを zip から展開して実行できるようにするため。

| ワークフロー | タイミング | 内容 |
| --- | --- | --- |
| `ci.yml` | PR・`main` への push | `build.yml` を実行する |
| `build.yml` | ほかのワークフローから呼ばれる | プラットフォームごとに型検査・統合テストを行い、トレーサーを artifact にする |
| `release.yml` | `v<version>` タグの push | `build.yml` の後、全トレーサーを同梱して npm へ公開する |

npm への認証は Trusted Publishing (OIDC) で行い、provenance は自動で付く。
`repository` は公開を実行したリポジトリ (`GITHUB_REPOSITORY`) から決める。

## 前提

`nx-auto-cache-deps` が npm に存在し、Trusted Publishing にこのリポジトリと workflow `release.yml` が登録されていること。

## 毎回のリリース

1. `package.json` の `version` を上げてコミットする。
2. `v<version>` のタグを push する。タグとバージョンが一致しないか、同梱するバイナリが欠けていれば、公開せずに失敗する。

## サードパーティのライセンス

トレーサーには Rust の crate が静的にリンクされ、macOS 用には fspy が uutils coreutils と oils-for-unix を埋め込む。
それらのライセンスを `THIRD_PARTY_LICENSES` にまとめ、パッケージに同梱している。
配布する通知には開発者向けの再生成手順を入れない。ライセンス本文はプレーンテキストとして出力し、HTML エスケープしない（`about.hbs` の `{{{text}}}` を使う）。

`native/Cargo.toml`・`native/Cargo.lock` や fspy の rev を変えたときは作り直す。

1. Rust crate の部分は、`native/` で cargo-about を実行して生成する（fspy の取得に cargo の nightly 機能が要るため `CARGO_UNSTABLE_BINDEPS=true` を付ける）。

   ```sh
   cd native && CARGO_UNSTABLE_BINDEPS=true cargo about generate about.hbs
   ```

2. fspy の `build.rs` が埋め込むツール（現在は uutils coreutils 0.4.0 と oils-for-unix 0.38.0）のバージョンを確かめ、変わっていればライセンス文を差し替える。
