# 利用手順

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

依存一覧がない状態で実行した結果は再利用されない。同じ入力のまま実行を続けると、2回目の実行結果から復元されるようになる。

## worktree で使う

同じリポジトリの worktree どうしでは、Nx のキャッシュと同じく依存一覧も共有される。
worktree A で実行した後、同じ入力の worktree B で実行すると、B は A の依存一覧と実行結果を使う。

## ファイル以外の入力

本プラグインは、対象 target ごとに依存一覧のハッシュを表す named input `autoCacheDeps-<target 名>` をプロジェクトに追加する。

推論プラグインの target では、元の `inputs` にある環境変数・外部依存・runtime input の指定がそのまま残る。

`project.json` で executor を明示する target で環境変数などを加えるときは、`inputs` に named input と一緒に書く。

```json
{
  "build": {
    "executor": "nx-auto-cache-deps:run",
    "original_executor": "@nx/js:tsc",
    "inputs": ["autoCacheDeps-build", { "env": "NODE_ENV" }]
  }
}
```

`inputs` に `autoCacheDeps-<target 名>` を含めないと、依存一覧のハッシュは使われない。

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
