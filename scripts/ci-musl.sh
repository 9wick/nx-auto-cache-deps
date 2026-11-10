#!/bin/sh
# Alpine コンテナ内で、配布用トレーサーと実際の Nx ワークスペースを検証する。
set -eu

mkdir -p .tmp
export TMPDIR="$PWD/.tmp"
export TMP="$TMPDIR"
export TEMP="$TMPDIR"
export CARGO_HOME="$PWD/.tmp/cargo"
export RUSTUP_HOME="$PWD/.tmp/rustup"
export PATH="$CARGO_HOME/bin:$PATH"

apk add --no-cache build-base curl git python3
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o .tmp/rustup-init.sh
sh .tmp/rustup-init.sh -y --profile minimal --default-toolchain none --no-modify-path
(cd native && rustup toolchain install)
npm install --global pnpm@12.18.0
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
tar -cf tracer-linux-x64-musl.tar bin/linux-x64-musl
