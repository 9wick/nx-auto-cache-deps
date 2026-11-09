//! `nx-auto-cache-deps-trace <report.json> <program> [args...]`
//! program を fspy の監視下で実行し、アクセス記録を report.json に書き、program の終了コードで終わる。

use serde::Serialize;
use std::{env, fs, path::PathBuf, process::{ExitCode, Stdio}};

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
    let report_path = PathBuf::from(args.next().ok_or("missing report path")?);
    let program = args.next().ok_or("missing program")?;
    let mut command = fspy::Command::new(program);
    command
        .args(args)
        .envs(env::vars_os())
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
                    let cleaned = path.clean_and_strip_path_prefix(PathBuf::from("/"))?;
                    let absolute = PathBuf::from("/").join(cleaned);
                    let Some(path) = absolute.to_str() else {
                        return Err("non-UTF-8 path".into());
                    };
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
