# 利用手順

## コマンド単位でキャッシュする

```sh
npm install --save-dev nx-auto-cache-deps
```

```json
{
  "scripts": {
    "check": "nx-auto-cache-deps eslint . && nx-auto-cache-deps prettier ."
  }
}
```

`pnpm check` のように実行すると、それぞれのコマンドを独立に追跡・キャッシュする。
ヒット時は stdout / stderr と書き込まれたファイルを復元して成功終了し、失敗時は元の終了コードを返す。
`&&` の制御は shell が行う。Nx の設定や起動は不要。

CLI はローカルの `node_modules/.bin` を検索する。キャッシュの識別には実行ファイル・引数・作業ディレクトリ・選択した環境変数・ランタイム・プラットフォームを含める。
環境変数の識別には値のハッシュを使う。
symlink のリンク先を直接読む操作も検出するため、workspace 内の symlink 一覧とリンク先を追加で照合する。無関係な symlink の変更でもキャッシュが外れる場合がある。

追跡範囲は Git / workspace のルート内。ルートがなければ最寄りの package.json、さらにそれがなければ作業ディレクトリを使う。
キャッシュは `<workspace>/.nx/nx-auto-cache-deps/commands` に置く。このディレクトリを削除するとクリアできる。
`.git` と `.nx` は追跡から除く。

workspace 内のファイル、引数、環境変数で結果が決まるコマンドに使う。
workspace 外のファイル、標準入力、ネットワーク、時刻に依存する処理や対話コマンドは直接実行する。
既存の入力を読み書きするコマンドでは、実行前の状態を学習するため追加の実行が必要になる場合がある。
失敗・追跡不完全の場合は結果を保存せず、壊れたキャッシュはエラーとして報告する。
トレーサーに記録されなかった削除などの変更を検出した場合も、警告して結果を保存しない。

以下は Nx プラグインとして使う場合の手順。

## CLI と Nx で共通の環境変数設定

`nx.json` の `plugins[].options` 直下に一度だけ書く。

```json
{
  "plugins": [
    {
      "plugin": "nx-auto-cache-deps",
      "options": {
        "env": ["NODE_ENV", "VITE_*"],
        "untrackedEnv": ["NX_*"]
      }
    }
  ]
}
```

- `env` はコマンドに渡し、値をキーに含める。既定値は空配列。
- `untrackedEnv` はコマンドに渡すが、値をキーに含めない。Vite Task を基準とした既定リストに追加する。既定には `PATH`、`HOME`、`CI`、`NODE_OPTIONS`、CI / IDE の変数、`*_TOKEN` などがある。
- どちらにも該当しない ambient な変数は渡さない。色設定が選択されていなければ `FORCE_COLOR=1` を補う。
- glob と `!` による除外を使える。両方に一致した変数は `env` を優先する。既定で untracked の変数でも、結果を変えるなら `env` に指定する。
- 設定の変更と tracked な値の変更はキーに反映する。untracked な値だけが変わってもキーは変わらない。

単独 CLI も Nx の起動なしでこのファイルを読む。設定なしなら既定値で実行できる。
JSONC、末尾カンマ、Nx と同じ浅い `extends` のマージに対応する。
複数の推論プラグインを wrap する場合も、共通の環境変数設定は一つの登録にまとめる。
コマンド内の `FOO=bar` や executor 自身の明示的な環境変数設定は、そのコマンド・executor の設定として扱う。

**0.0.7 からの変更:** 従来の CLI は全環境変数を渡し、全ての値をハッシュしていた。今回から選択式になるため、必要な独自変数や `NODE_ENV` を明示する必要がある。旧キャッシュは新しい方針では再利用しない。

## 導入する

```sh
nx add nx-auto-cache-deps
```

`nx add` はパッケージをインストールし、`nx-auto-cache-deps:init` を実行する。`init` は `nx.json` の `plugins` に `"nx-auto-cache-deps"` を登録する。登録済みなら何もしない。

## 対象を選ぶ

対象 target の作られ方によって、選び方が2通りある。
どちらの方法でも、`project.json` の既存の設定（`options`・`outputs`・`dependsOn`・`cache`）はそのまま使われる。

### 推論プラグインが生成する target

`@nx/vite/plugin` など、設定ファイルから target を推論するプラグインの場合。
`nx.json` の `plugins` で、そのプラグインの登録を `nx-auto-cache-deps` の `wrap` の中へ移し、対象の target 名を `targets` に書く。

```json
{
  "plugins": [
    {
      "plugin": "nx-auto-cache-deps",
      "options": {
        "wrap": { "plugin": "@nx/vite/plugin", "options": { "buildTargetName": "build" } },
        "targets": ["build"]
      }
    }
  ]
}
```

`targets` に書いていない target（例: `serve`）は、推論されたまま使われる。
包むプラグインごとに `nx-auto-cache-deps` の登録を1つ書く。

`nx add` や `nx migrate` は、トップレベルに登録されたプラグインを前提に `nx.json` を更新することがある。
`wrap` の中に移したプラグインの設定は、自動では更新されない場合がある。

### `project.json` で executor を明示する target

`executor` を `nx-auto-cache-deps:run` に替え、元の executor を `original_executor` に書く。

```json
{
  "targets": {
    "build": {
      "executor": "nx-auto-cache-deps:run",
      "original_executor": "@nx/js:tsc",
      "cache": true,
      "outputs": ["{options.outputPath}"],
      "options": { "outputPath": "dist/libs/a", "tsConfig": "libs/a/tsconfig.lib.json" }
    }
  }
}
```

この target は、`nx add` が登録する `wrap` なしの `"nx-auto-cache-deps"` が扱う。

`inputs` を書かなければ、本プラグインが依存一覧のハッシュを `inputs` に設定する。`inputs` を書く場合は、後述の named input を含める。

## 普段どおり実行する

```sh
nx run web:build
```

| 状況 | 起きること |
| --- | --- |
| 依存一覧がない（初回・`nx reset` 後） | キャッシュを使わずに実行し、依存一覧を保存する |
| 依存一覧がある | 一覧の依存を現在の状態でハッシュし、Nx のキャッシュを照会する。結果があれば復元し、なければ実行する |
| 読んだファイルを編集・削除 | ハッシュが変わり、実行する |
| 読んでいないファイルを編集 | ハッシュは変わらない |
| 列挙したディレクトリにファイルを追加 | ハッシュが変わり、実行する |
| 存在を確認して無かったファイルを作成 | ハッシュが変わり、実行する |

依存一覧がない状態で実行した結果は再利用されない。依存一覧が変わらなければ、2回目の実行結果を3回目から復元できる。成果物の有無でコマンドのアクセス先が増えるなど、後続の実行で新しい依存が見つかる場合は、拡張した一覧のキーで結果を保存するために追加の実行が必要になる。

## worktree で使う

同じリポジトリの worktree どうしでは、Nx のキャッシュと同じく依存一覧も共有される。
worktree A で実行した後、同じ入力の worktree B で実行すると、B は A の依存一覧と実行結果を使う。

## ファイル以外の入力

本プラグインは、対象 target ごとに依存一覧のハッシュを表す named input `autoCacheDeps-<target 名>` をプロジェクトに追加する。

推論プラグインの target では、元の `inputs` にある環境変数・外部依存・runtime input の指定がそのまま残る。

共通設定の `env` と設定内容の fingerprint も、この named input に含まれる。`inputs` を明示する場合は named input を含める。追加の runtime / external dependency の指定は Nx 側で行う。

```json
{
  "build": {
    "executor": "nx-auto-cache-deps:run",
    "original_executor": "@nx/js:tsc",
    "inputs": ["autoCacheDeps-build", { "runtime": "node --version" }]
  }
}
```

`inputs` に `autoCacheDeps-<target 名>` を含めないと、依存一覧と共通環境変数の fingerprint は使われない。Nx の `{ "env": "NAME" }` は追加のハッシュ条件として残るが、受渡し変数の選択には共通の `env` / `untrackedEnv` を使う。

通常の Nx script から CLI を呼ぶ場合も CLI はこの設定を使う。プラグインの executor に差し替えていない外側の Nx タスクは、独自の Nx キャッシュ設定を持つ。

## 解除する

- 推論プラグインの target: `wrap` の中のプラグイン登録をトップレベルへ戻し、`nx-auto-cache-deps` の登録を削除する。
- 明示 executor の target: `executor` を `original_executor` の値に戻し、`original_executor` を削除する。

## 対応環境

| 項目 | 対応 |
| --- | --- |
| OS・CPU | Linux x64 (glibc / musl)、Linux arm64 (glibc)、macOS x64 / arm64、Windows x64 |
| Nx | 24 |
| Node.js | 24 以上 |

追跡に使うトレーサーは、上記の全環境の分がパッケージに同梱されている。上記以外の環境では、対象 target の実行時にエラーになる。
