use std::path::Path;
use std::process::Command;

use serde::Serialize;
use tauri::State;

use crate::devices::{self, Device};
use crate::error::{AppError, AppResult};
use crate::ssh;
use crate::state::AppState;

fn require_device(state: &AppState, id: &str) -> AppResult<Device> {
    devices::get(&state.db, id)?.ok_or_else(|| AppError::NotFound(id.to_string()))
}

/// Run `git <args>` either locally (when `device.is_localhost`) or via SSH
/// using the existing pool. For SSH runs we shell-escape every arg so paths
/// with spaces / quotes survive `sh -c`, and we `cd` first so git operates
/// against the right working tree.
fn run_git_for(
    state: &AppState,
    device: &Device,
    args: &[&str],
    cwd: Option<&str>,
) -> AppResult<String> {
    let out = run_git_raw(state, device, args, cwd)?;
    if out.exit_code != 0 {
        return Err(git_error(&out));
    }
    Ok(if device.is_localhost {
        out.stdout.trim().to_string()
    } else {
        out.stdout.trim_end_matches(['\n', '\r']).to_string()
    })
}

struct GitOutput {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

fn git_error(out: &GitOutput) -> AppError {
    let stderr = out.stderr.trim();
    AppError::Invalid(if stderr.is_empty() {
        format!("git exited with status {}", out.exit_code)
    } else {
        stderr.to_string()
    })
}

/// Run git and return its exit code and untrimmed output, for commands where
/// a non-zero exit isn't a failure (e.g. `diff --no-index` exits 1 on changes).
fn run_git_raw(
    state: &AppState,
    device: &Device,
    args: &[&str],
    cwd: Option<&str>,
) -> AppResult<GitOutput> {
    if device.is_localhost {
        let mut cmd = Command::new("git");
        cmd.args(args);
        if let Some(dir) = cwd {
            cmd.current_dir(Path::new(dir));
        }
        let out = cmd
            .output()
            .map_err(|e| AppError::Invalid(format!("git not available: {e}")))?;
        return Ok(GitOutput {
            exit_code: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
        });
    }

    // Remote — build `cd '<dir>' && git '<arg>' '<arg>' …`
    let mut shell = String::new();
    if let Some(dir) = cwd {
        shell.push_str("cd ");
        shell.push_str(&single_quote(dir));
        shell.push_str(" && ");
    }
    shell.push_str("git");
    for a in args {
        shell.push(' ');
        shell.push_str(&single_quote(a));
    }
    let out = ssh::run_command_no_sudo(&state.pool, device, &shell)?;
    Ok(GitOutput {
        exit_code: out.exit_code,
        stdout: out.stdout,
        stderr: out.stderr,
    })
}

/// POSIX single-quoting: wrap in `'…'`, escape `'` as `'\''`.
fn single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// Check whether the path on `device` is a git repo.
#[tauri::command(async)]
pub fn git_is_repo(state: State<'_, AppState>, device_id: String, path: String) -> AppResult<bool> {
    let device = require_device(&state, &device_id)?;
    if device.is_localhost {
        let p = Path::new(&path);
        if !p.is_dir() {
            return Ok(false);
        }
    }
    let result = run_git_for(
        &state,
        &device,
        &["rev-parse", "--is-inside-work-tree"],
        Some(&path),
    );
    Ok(matches!(result, Ok(s) if s == "true"))
}

#[tauri::command(async)]
pub fn git_branch(
    state: State<'_, AppState>,
    device_id: String,
    path: String,
) -> AppResult<Option<String>> {
    let device = require_device(&state, &device_id)?;
    match run_git_for(&state, &device, &["branch", "--show-current"], Some(&path)) {
        Ok(b) if b.is_empty() => Ok(None),
        Ok(b) => Ok(Some(b)),
        Err(_) => Ok(None),
    }
}

/// Clone `url` into a subdirectory of `parent_dir` named `repo_name`.
/// Returns the absolute path of the cloned directory.
/// Currently localhost-only; cloning to a remote device is not yet supported.
#[tauri::command(async)]
pub fn git_clone(url: String, parent_dir: String, repo_name: String) -> AppResult<String> {
    let parent = Path::new(&parent_dir);
    if !parent.is_dir() {
        return Err(AppError::Invalid(format!(
            "parent dir does not exist: {parent_dir}"
        )));
    }
    if repo_name.is_empty() || repo_name.contains('/') || repo_name.contains('\\') {
        return Err(AppError::Invalid(format!("invalid repo name: {repo_name}")));
    }
    let target = parent.join(&repo_name);
    if target.exists() {
        return Err(AppError::Invalid(format!(
            "target already exists: {}",
            target.display()
        )));
    }
    let target_str = target.to_string_lossy().to_string();
    let out = Command::new("git")
        .args(["clone", "--progress", &url, &target_str])
        .output()
        .map_err(|e| AppError::Invalid(format!("git not available: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(AppError::Invalid(if stderr.is_empty() {
            format!("git clone failed with status {}", out.status)
        } else {
            stderr
        }));
    }
    Ok(target_str)
}

#[derive(Debug, Serialize)]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub subject: String,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
}

const COMMIT_SEP: &str = "\x1e";
const FIELD_SEP: &str = "\x1f";

#[tauri::command(async)]
pub fn git_log(
    state: State<'_, AppState>,
    device_id: String,
    path: String,
    limit: Option<usize>,
) -> AppResult<Vec<GitCommit>> {
    let device = require_device(&state, &device_id)?;
    let n = limit.unwrap_or(300).min(1000);
    let format = format!(
        "--pretty=format:%H{F}%h{F}%an{F}%ae{F}%at{F}%s{F}%P{F}%D{C}",
        F = FIELD_SEP,
        C = COMMIT_SEP,
    );
    let n_arg = format!("-n{n}");
    let out = run_git_for(
        &state,
        &device,
        &["log", "--all", "--date-order", &n_arg, &format],
        Some(&path),
    )?;

    let mut commits = Vec::new();
    for chunk in out.split(COMMIT_SEP) {
        let chunk = chunk.trim_matches(|c: char| c == '\n' || c == '\r');
        if chunk.is_empty() {
            continue;
        }
        let parts: Vec<&str> = chunk.splitn(8, FIELD_SEP).collect();
        if parts.len() < 8 {
            continue;
        }
        let timestamp = parts[4].trim().parse::<i64>().unwrap_or(0);
        let parents = if parts[6].is_empty() {
            Vec::new()
        } else {
            parts[6].split_whitespace().map(|s| s.to_string()).collect()
        };
        let refs = if parts[7].is_empty() {
            Vec::new()
        } else {
            parts[7]
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        };
        commits.push(GitCommit {
            hash: parts[0].to_string(),
            short_hash: parts[1].to_string(),
            author_name: parts[2].to_string(),
            author_email: parts[3].to_string(),
            timestamp,
            subject: parts[5].to_string(),
            parents,
            refs,
        });
    }
    Ok(commits)
}

#[derive(Debug, Serialize)]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub last_commit: Option<String>,
}

#[tauri::command(async)]
pub fn git_branches(
    state: State<'_, AppState>,
    device_id: String,
    path: String,
) -> AppResult<Vec<GitBranch>> {
    let device = require_device(&state, &device_id)?;
    let format = format!(
        "--format=%(HEAD){F}%(refname){F}%(refname:short){F}%(upstream:short){F}%(objectname:short)",
        F = FIELD_SEP,
    );
    let out = run_git_for(
        &state,
        &device,
        &["branch", "--list", "--all", &format],
        Some(&path),
    )?;
    let mut branches = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.splitn(5, FIELD_SEP).collect();
        if parts.len() < 5 {
            continue;
        }
        let full_ref = parts[1];
        if full_ref.ends_with("/HEAD") {
            continue;
        }
        let is_remote = full_ref.starts_with("refs/remotes/");
        let upstream = if parts[3].is_empty() {
            None
        } else {
            Some(parts[3].to_string())
        };
        branches.push(GitBranch {
            name: parts[2].to_string(),
            is_current: parts[0].trim() == "*",
            is_remote,
            upstream,
            last_commit: if parts[4].is_empty() {
                None
            } else {
                Some(parts[4].to_string())
            },
        });
    }
    Ok(branches)
}

#[derive(Debug, Serialize)]
pub struct GitTag {
    pub name: String,
    pub commit: Option<String>,
}

#[tauri::command(async)]
pub fn git_tags(
    state: State<'_, AppState>,
    device_id: String,
    path: String,
) -> AppResult<Vec<GitTag>> {
    let device = require_device(&state, &device_id)?;
    let format = format!(
        "--format=%(refname:short){F}%(objectname:short)",
        F = FIELD_SEP
    );
    let out = run_git_for(&state, &device, &["tag", "--list", &format], Some(&path))?;
    let mut tags = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.splitn(2, FIELD_SEP).collect();
        if parts.is_empty() || parts[0].is_empty() {
            continue;
        }
        tags.push(GitTag {
            name: parts[0].to_string(),
            commit: parts.get(1).map(|s| s.to_string()),
        });
    }
    Ok(tags)
}

#[derive(Debug, Serialize)]
pub struct GitChangedFile {
    pub status: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct GitCommitDetail {
    pub hash: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub subject: String,
    pub body: String,
    pub parents: Vec<String>,
    pub files: Vec<GitChangedFile>,
}

#[tauri::command(async)]
pub fn git_show(
    state: State<'_, AppState>,
    device_id: String,
    path: String,
    hash: String,
) -> AppResult<GitCommitDetail> {
    let device = require_device(&state, &device_id)?;
    let format = format!(
        "--pretty=format:%H{F}%an{F}%ae{F}%at{F}%s{F}%P{F}%b{C}",
        F = FIELD_SEP,
        C = COMMIT_SEP,
    );
    let out = run_git_for(
        &state,
        &device,
        &["show", "--no-color", "--name-status", &format, &hash],
        Some(&path),
    )?;

    let (header, files_section) = match out.split_once(COMMIT_SEP) {
        Some((h, rest)) => (h, rest),
        None => (out.as_str(), ""),
    };
    let parts: Vec<&str> = header.splitn(7, FIELD_SEP).collect();
    if parts.len() < 7 {
        return Err(AppError::Invalid("git show output unparseable".into()));
    }
    let parents = if parts[5].is_empty() {
        Vec::new()
    } else {
        parts[5].split_whitespace().map(|s| s.to_string()).collect()
    };
    let mut files = Vec::new();
    for line in files_section.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut split = trimmed.split('\t');
        let status = split.next().unwrap_or("").to_string();
        let collected: Vec<&str> = split.collect();
        if collected.is_empty() || status.is_empty() {
            continue;
        }
        let path = collected.last().unwrap().to_string();
        files.push(GitChangedFile { status, path });
    }
    Ok(GitCommitDetail {
        hash: parts[0].to_string(),
        author_name: parts[1].to_string(),
        author_email: parts[2].to_string(),
        timestamp: parts[3].trim().parse::<i64>().unwrap_or(0),
        subject: parts[4].to_string(),
        body: parts[6].trim_end_matches(['\n', '\r']).to_string(),
        parents,
        files,
    })
}

/// Get a unified diff for a single file in a single commit.
/// If the commit has no parents (root commit), uses the empty tree as base.
#[tauri::command(async)]
pub fn git_diff(
    state: State<'_, AppState>,
    device_id: String,
    path: String,
    hash: String,
    file_path: String,
) -> AppResult<String> {
    let device = require_device(&state, &device_id)?;
    let range = format!("{hash}^!");
    let out = run_git_for(
        &state,
        &device,
        &[
            "show",
            "--no-color",
            "--format=",
            "-U3",
            &range,
            "--",
            &file_path,
        ],
        Some(&path),
    );
    match out {
        Ok(s) => Ok(s),
        Err(_) => run_git_for(
            &state,
            &device,
            &[
                "show",
                "--no-color",
                "--format=",
                "-U3",
                &hash,
                "--",
                &file_path,
            ],
            Some(&path),
        ),
    }
}

// ─── Working tree: status, stage/unstage, diff, commit ──────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusFile {
    pub path: String,
    /// Source path for renames / copies.
    pub orig_path: Option<String>,
    /// Index (staged) status letter, '.' when unchanged.
    pub index: String,
    /// Worktree (unstaged) status letter, '.' when unchanged.
    pub worktree: String,
    pub untracked: bool,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitStatusFile>,
}

/// Parse `git status --porcelain=v2 --branch -z`.
fn parse_status_v2(raw: &str) -> GitStatus {
    let mut st = GitStatus::default();
    let mut fields = raw.split('\0').peekable();
    while let Some(entry) = fields.next() {
        if entry.is_empty() {
            continue;
        }
        if let Some(h) = entry.strip_prefix("# ") {
            if let Some(v) = h.strip_prefix("branch.head ") {
                st.branch = (v != "(detached)").then(|| v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.upstream ") {
                st.upstream = Some(v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.ab ") {
                for part in v.split_whitespace() {
                    if let Some(n) = part.strip_prefix('+') {
                        st.ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix('-') {
                        st.behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        let kind = entry.as_bytes()[0];
        match kind {
            b'?' => st.files.push(GitStatusFile {
                path: entry[2..].to_string(),
                orig_path: None,
                index: ".".into(),
                worktree: "?".into(),
                untracked: true,
                conflicted: false,
            }),
            b'1' | b'2' | b'u' => {
                // Fixed number of space-separated fields before the path.
                let n = match kind {
                    b'1' => 8,
                    b'2' => 9,
                    _ => 10,
                };
                let parts: Vec<&str> = entry.splitn(n + 1, ' ').collect();
                if parts.len() < n + 1 {
                    continue;
                }
                let xy = parts[1].as_bytes();
                let orig_path = if kind == b'2' {
                    fields.next().map(|p| p.to_string())
                } else {
                    None
                };
                st.files.push(GitStatusFile {
                    path: parts[n].to_string(),
                    orig_path,
                    index: (xy[0] as char).to_string(),
                    worktree: (xy[1] as char).to_string(),
                    untracked: false,
                    conflicted: kind == b'u',
                });
            }
            _ => {}
        }
    }
    st
}

#[tauri::command(async)]
pub fn git_status(
    state: State<'_, AppState>,
    device_id: String,
    path: String,
) -> AppResult<GitStatus> {
    let device = require_device(&state, &device_id)?;
    let out = run_git_raw(
        &state,
        &device,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
        Some(&path),
    )?;
    if out.exit_code != 0 {
        return Err(git_error(&out));
    }
    Ok(parse_status_v2(&out.stdout))
}

/// Unified diff of one working-tree file: staged (index vs HEAD) or
/// unstaged (worktree vs index). Untracked files diff against /dev/null.
#[tauri::command(async)]
pub fn git_working_diff(
    state: State<'_, AppState>,
    device_id: String,
    path: String,
    file_path: String,
    staged: bool,
    untracked: bool,
) -> AppResult<String> {
    let device = require_device(&state, &device_id)?;
    let out = if untracked {
        run_git_raw(
            &state,
            &device,
            &[
                "diff",
                "--no-color",
                "--no-index",
                "--",
                "/dev/null",
                &file_path,
            ],
            Some(&path),
        )?
    } else if staged {
        run_git_raw(
            &state,
            &device,
            &["diff", "--no-color", "-U3", "--cached", "--", &file_path],
            Some(&path),
        )?
    } else {
        run_git_raw(
            &state,
            &device,
            &["diff", "--no-color", "-U3", "--", &file_path],
            Some(&path),
        )?
    };
    // `diff --no-index` exits 1 when the files differ — that's the normal case.
    if out.exit_code > 1 {
        return Err(git_error(&out));
    }
    Ok(out.stdout)
}

#[tauri::command(async)]
pub fn git_stage(
    state: State<'_, AppState>,
    device_id: String,
    path: String,
    files: Vec<String>,
) -> AppResult<()> {
    let device = require_device(&state, &device_id)?;
    if files.is_empty() {
        return Ok(());
    }
    // `add -A -- <paths>` also stages deletions of the listed paths.
    let mut args = vec!["add", "-A", "--"];
    args.extend(files.iter().map(String::as_str));
    run_git_for(&state, &device, &args, Some(&path)).map(|_| ())
}

#[tauri::command(async)]
pub fn git_unstage(
    state: State<'_, AppState>,
    device_id: String,
    path: String,
    files: Vec<String>,
) -> AppResult<()> {
    let device = require_device(&state, &device_id)?;
    if files.is_empty() {
        return Ok(());
    }
    let mut args = vec!["restore", "--staged", "--"];
    args.extend(files.iter().map(String::as_str));
    match run_git_for(&state, &device, &args, Some(&path)) {
        Ok(_) => Ok(()),
        // Older git (< 2.23) has no `restore`; `reset` does the same here.
        Err(_) => {
            let mut args = vec!["reset", "-q", "HEAD", "--"];
            args.extend(files.iter().map(String::as_str));
            run_git_for(&state, &device, &args, Some(&path)).map(|_| ())
        }
    }
}

/// Commit what's staged. Returns git's one-line summary.
#[tauri::command(async)]
pub fn git_commit(
    state: State<'_, AppState>,
    device_id: String,
    path: String,
    message: String,
    amend: bool,
) -> AppResult<String> {
    let device = require_device(&state, &device_id)?;
    if message.trim().is_empty() {
        return Err(AppError::Invalid("Commit message is empty".into()));
    }
    let mut args = vec!["commit", "-m", message.as_str()];
    if amend {
        args.push("--amend");
    }
    run_git_for(&state, &device, &args, Some(&path))
}

#[cfg(test)]
mod status_tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2() {
        let raw = [
            "# branch.oid abc",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -1",
            "1 M. N... 100644 100644 100644 aaa bbb src/staged.py",
            "1 .M N... 100644 100644 100644 aaa bbb src/unstaged file.py",
            "1 MM N... 100644 100644 100644 aaa bbb both.py",
            "2 R. N... 100644 100644 100644 aaa bbb R100 new_name.py",
            "old_name.py",
            "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.py",
            "? notes.txt",
            "",
        ]
        .join("\0");
        let st = parse_status_v2(&raw);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert_eq!((st.ahead, st.behind), (2, 1));
        let paths: Vec<_> = st.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "src/staged.py",
                "src/unstaged file.py",
                "both.py",
                "new_name.py",
                "conflict.py",
                "notes.txt"
            ]
        );
        assert_eq!(st.files[0].index, "M");
        assert_eq!(st.files[0].worktree, ".");
        assert_eq!(st.files[3].orig_path.as_deref(), Some("old_name.py"));
        assert!(st.files[4].conflicted);
        assert!(st.files[5].untracked);
    }
}
