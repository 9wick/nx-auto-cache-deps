# Ultracache 内部 API への接続実験

2026-11-11 に Linux x64 / Node.js 24.14.0 / Nx 24.0.5 / nx-auto-cache-deps 0.0.6 で実施。

## 結果

package.json の `scripts.build` と `nx:run-script` を保ったまま、通常の `nx run app:build` で以下を確認した。

| 操作 | 観測した結果 |
| --- | --- |
| 固定の入力一覧を渡して2回実行 | 初回実行、2回目はキャッシュヒット |
| fspy で読み取りを記録して実行を繰り返す | 記録が収束するとキャッシュヒット |
| 読んだ `src/input.txt` を変更 | 再実行され、成果物に変更が反映される |
| 読んでいない README を変更 | キャッシュヒット |
| 成果物ディレクトリを削除 | コマンドを実行せずに成果物を復元 |
| コマンドが生成した子 Node プロセスから入力を読む | その読み取りを記録 |
| 以前は存在しなかった `fail` ファイルを作る | キャッシュミスとなり、コマンドが失敗する |
| 失敗後の記録を比較 | 記録は更新されない |
| `fail` を削除して入力を元に戻す | 過去の成功キャッシュを復元 |

npm workspace と、pnpm 12.18.0 で依存をインストールした pnpm workspace で確認した。
pnpm の成功条件については後述する。

## どう差し込んだか

実験用 CommonJS プリロードを `NODE_OPTIONS=--require <bootstrap.cjs>` で読み込ませた。
Cloud との通信と Nx daemon は無効にした。Nx の配布ファイルは編集していない。

ハッシュ計算側では、`nx/src/ultracache/store` の export を実行時に差し替えた。

```js
store.loadUltracacheConfigurationsForRun = async () => {
  // 記録なしの初回は null を返し、宣言された inputs で実行する。
  const configurations = importUltracacheConfigurations(commit, recording);
  return { status: 'cached', configurations };
};
```

これにより、CI / Cloud の有効化条件を通さず、自前の記録を通常の CLI のハッシュ計算に渡せた。
import 関数を呼ぶだけでは、この通常実行への接続は成立しない。

実行側では、`nx:run-script` が呼ぶ `child_process.spawn` を実行時に差し替えた。
対象タスクの環境変数を確認して、起動するコマンドを次の形で包んだ。

```text
nx-auto-cache-deps-trace report.json workspace-root /bin/sh -c 'npm run build'
```

pnpm の場合は内側が `pnpm run build` になる。
コマンドの完了後に report を読み、成功かつ追跡完了の場合だけ入力一覧を保存した。
子プロセスへの二重の差し込みは、追跡中を示す環境変数で防いだ。

fspy の固定している revision は `Command::spawn` から追跡を開始する。
既存 PID に接続する公開 API は確認できなかったため、今回もプロセスの起動前に包んでいる。

## pnpm で見つかった制約

このマシンの通常の pnpm コマンドは、別バージョンの pnpm から、shebang のない pnpm 12.18.0 のラッパーを起動する。
通常実行は成功するが、fspy 監視下では以下のエラーで失敗した。

```text
Failed to switch pnpm to v12.18.0
spawnSync .../pnpm/12.18.0/bin/pnpm Unknown system error -8
```

`pnpm --version` だけを fspy 下で動かしても再現した。
pnpm 12.18.0 の実体バイナリ `@pnpm/exe.linux-x64/pnpm` を実験専用 PATH の先頭から使うと、
バージョン確認と、上記のキャッシュ・入力変更検知・復元の検証が成功した。
このため、現在のマシンの通常の pnpm 起動経路をそのままサポートできたとは評価しない。

## 実験の範囲

- 実行確認した接続は `NODE_OPTIONS` によるプリロードと内部関数の差し替え。通常のプラグイン登録だけで有効化する方法は未検証。
- 単一 project の単一 target を逐次実行した。複数タスクの並列実行・設定別の記録・同時更新は未検証。
- TTY からの CLI 実行も成功したが、実際の executor 内で観測した起動経路は pipe を使う `spawn`。PTY の起動経路自体は未検証。
- この実験で Ultracache に渡したのは、fspy の read 記録から得たパスと、それ以前の記録との和集合。存在しないパスの出現は検出できた。
- `readDir` は記録されたが、Ultracache 形式への変換にはまだ含めていない。列挙先へのファイル追加・削除・改名を正しく検出する方法は未検証。
- 書き込んだパスと宣言 outputs は既存の `toDependencyList` で入力から除いた。node_modules も実験用フィルタで除いた。
- 記録がない場合は宣言 inputs に戻した。未知の workspace 外参照や、宣言 inputs では拾えない初回依存まで安全に扱う製品実装は未検証。
- Nx daemon 有効時、ほかの OS、ほかの Nx バージョン、追跡が不完全だった場合、シグナルによる中断は未検証。

内部 API に依存するため、製品化する場合は対応する Nx バージョンごとに接続の検証が必要になる。
本実験では製品コードを変更していない。

## 確認した入口

- [`nx/nx-cloud-internals`](https://github.com/nrwl/nx/blob/master/packages/nx/nx-cloud-internals.ts)
- [`importUltracacheConfigurations` と読み込み処理](https://github.com/nrwl/nx/blob/master/packages/nx/src/ultracache/store.ts)
- [標準の CI / Cloud 利用条件](https://github.com/nrwl/nx/blob/master/packages/nx/src/ultracache/config.ts)
- [`nx:run-script` の実行処理](https://github.com/nrwl/nx/blob/master/packages/nx/src/executors/run-script/run-script.impl.ts)

リンク先の master は変化する。実行検証には npm 配布物の Nx 24.0.5 を使った。
