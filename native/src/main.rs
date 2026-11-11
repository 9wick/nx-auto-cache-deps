//! `nx-auto-cache-deps-trace <report.json> <workspace-root> <program> [args...]`
//! program を fspy の監視下で実行し、アクセス記録を report.json に書き、program の終了コードで終わる。

use serde::Serialize;
use std::{env, fs, io::{self, Write}, path::PathBuf, process::{ExitCode, Stdio}};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Access {
    kind: &'static str,
    path: String,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum Report {
    Complete { accesses: Vec<Access> },
    Incomplete { reason: String },
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("nx-auto-cache-deps-trace: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<u8, Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    let first = args.next().ok_or("missing report path")?;
    if first == "--lock" {
        let path = PathBuf::from(args.next().ok_or("missing lock path")?);
        if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }
        let file = fs::OpenOptions::new().create(true).truncate(false).write(true).open(path)?;
        file.lock()?;
        io::stdout().write_all(b"locked\n")?;
        io::stdout().flush()?;
        // 呼び出し元の終了・クラッシュでも stdin が閉じ、OSのロックが解放される。
        io::copy(&mut io::stdin(), &mut io::sink())?;
        return Ok(0);
    }
    let report_path = PathBuf::from(first);
    let workspace_root = PathBuf::from(args.next().ok_or("missing workspace root")?);
    if !workspace_root.is_absolute() {
        return Err("workspace root is not absolute".into());
    }
    let volume_root = workspace_root.ancestors().last().ok_or("missing volume root")?;
    let program = args.next().ok_or("missing program")?;
    let mut command = fspy::Command::new(program);
    // fspy 自身の初期化環境と、追跡するコマンドへ渡す環境を分ける。
    let command_env = match env::var("NX_AUTO_CACHE_DEPS_COMMAND_ENV_FILE") {
        Ok(path) => serde_json::from_str::<std::collections::BTreeMap<String, String>>(&fs::read_to_string(path)?)?
            .into_iter().map(|(key, value)| (key.into(), value.into())).collect(),
        Err(env::VarError::NotPresent) => env::vars_os().collect::<Vec<_>>(),
        Err(error) => return Err(error.into()),
    };
    command
        .args(args)
        .envs(command_env)
        .current_dir(env::current_dir()?)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let child = command.spawn(tokio_util::sync::CancellationToken::new()).await?;
    let termination = child.wait_handle.await?;
    let report = match termination.path_accesses {
        Ok(accesses) => {
            let mut list = Vec::new();
            for access in accesses.iter() {
                let kind = match access {
                    fspy::PathAccess::Read(_) => "read",
                    fspy::PathAccess::ReadDir(_) => "readDir",
                    fspy::PathAccess::ReadWrite(_)
                    | fspy::PathAccess::Write(_)
                    | fspy::PathAccess::RenameTarget(_)
                    | fspy::PathAccess::Mkdir(_) => "write",
                };
                for path in access.paths() {
                    // 他のボリュームや NT デバイスはワークスペース外。
                    // ディレクトリ名の大小文字には依存せず、ワークスペースのボリュームだけで絞る。
                    let Ok(relative) = path.clean_and_strip_path_prefix(volume_root) else {
                        continue;
                    };
                    let absolute = volume_root.join(relative);
                    let Some(path) = absolute.to_str() else {
                        return Err("non-UTF-8 path".into());
                    };
                    if matches!(access, fspy::PathAccess::ReadWrite(_)) {
                        list.push(Access { kind: "read", path: path.to_owned() });
                    }
                    list.push(Access { kind, path: path.to_owned() });
                }
            }
            Report::Complete { accesses: list }
        }
        Err(error) => Report::Incomplete { reason: format!("{error:?}") },
    };
    fs::write(report_path, serde_json::to_vec(&report)?)?;
    Ok(termination.status.code().map_or(1, |code| u8::try_from(code).unwrap_or(1)))
}
