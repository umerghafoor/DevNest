use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::error::{AppError, AppResult};

fn run_git(args: &[&str], cwd: Option<&Path>) -> AppResult<String> {
    let mut cmd = Command::new("git");
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let out = cmd
        .output()
        .map_err(|e| AppError::Invalid(format!("git not available: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(AppError::Invalid(if stderr.is_empty() {
            format!("git exited with status {}", out.status)
        } else {
            stderr
        }));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[tauri::command]
pub fn git_is_repo(path: String) -> AppResult<bool> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Ok(false);
    }
    let result = run_git(&["rev-parse", "--is-inside-work-tree"], Some(p));
    Ok(matches!(result, Ok(s) if s == "true"))
}

#[tauri::command]
pub fn git_branch(path: String) -> AppResult<Option<String>> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Ok(None);
    }
    match run_git(&["branch", "--show-current"], Some(p)) {
        Ok(b) if b.is_empty() => Ok(None),
        Ok(b) => Ok(Some(b)),
        Err(_) => Ok(None),
    }
}

/// Clone `url` into a subdirectory of `parent_dir` named `repo_name`.
/// Returns the absolute path of the cloned directory.
#[tauri::command]
pub fn git_clone(
    url: String,
    parent_dir: String,
    repo_name: String,
) -> AppResult<String> {
    let parent = Path::new(&parent_dir);
    if !parent.is_dir() {
        return Err(AppError::Invalid(format!(
            "parent dir does not exist: {parent_dir}"
        )));
    }
    if repo_name.is_empty() || repo_name.contains('/') || repo_name.contains('\\') {
        return Err(AppError::Invalid(format!(
            "invalid repo name: {repo_name}"
        )));
    }
    let target = parent.join(&repo_name);
    if target.exists() {
        return Err(AppError::Invalid(format!(
            "target already exists: {}",
            target.display()
        )));
    }
    let target_str = target.to_string_lossy().to_string();
    run_git(&["clone", "--progress", &url, &target_str], None)?;
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

/// Get the most recent commits. `limit` is capped to 1000 to keep payloads sane.
#[tauri::command]
pub fn git_log(path: String, limit: Option<usize>) -> AppResult<Vec<GitCommit>> {
    let p = Path::new(&path);
    let n = limit.unwrap_or(300).min(1000);

    // %H full hash, %h short, %an author name, %ae email, %at unix time,
    // %s subject, %P space-sep parents, %D ref names (HEAD -> main, origin/main, tag: v1)
    let format = format!(
        "--pretty=format:%H{F}%h{F}%an{F}%ae{F}%at{F}%s{F}%P{F}%D{C}",
        F = FIELD_SEP,
        C = COMMIT_SEP,
    );
    let out = run_git(
        &["log", "--all", "--date-order", &format!("-n{n}"), &format],
        Some(p),
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

#[tauri::command]
pub fn git_branches(path: String) -> AppResult<Vec<GitBranch>> {
    let p = Path::new(&path);
    // %(refname:short) %(HEAD) %(upstream:short) %(objectname:short)
    // Use \x1f as field separator.
    let format = format!(
        "--format=%(HEAD){F}%(refname){F}%(refname:short){F}%(upstream:short){F}%(objectname:short)",
        F = FIELD_SEP,
    );
    let out = run_git(&["branch", "--list", "--all", &format], Some(p))?;
    let mut branches = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.splitn(5, FIELD_SEP).collect();
        if parts.len() < 5 {
            continue;
        }
        let full_ref = parts[1];
        // Skip remote HEAD pointers like "refs/remotes/origin/HEAD".
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

#[tauri::command]
pub fn git_tags(path: String) -> AppResult<Vec<GitTag>> {
    let p = Path::new(&path);
    let format = format!("--format=%(refname:short){F}%(objectname:short)", F = FIELD_SEP);
    let out = run_git(&["tag", "--list", &format], Some(p))?;
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

#[tauri::command]
pub fn git_show(path: String, hash: String) -> AppResult<GitCommitDetail> {
    let p = Path::new(&path);
    let format = format!(
        "--pretty=format:%H{F}%an{F}%ae{F}%at{F}%s{F}%P{F}%b{C}",
        F = FIELD_SEP,
        C = COMMIT_SEP,
    );
    // --name-status appends file changes after the format on subsequent lines.
    let out = run_git(
        &[
            "show",
            "--no-color",
            "--name-status",
            &format,
            &hash,
        ],
        Some(p),
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
        // status \t path  (or status \t old \t new for renames)
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
#[tauri::command]
pub fn git_diff(path: String, hash: String, file_path: String) -> AppResult<String> {
    let p = Path::new(&path);
    let range = format!("{hash}^!");
    let out = run_git(
        &[
            "show",
            "--no-color",
            "--format=",
            "-U3",
            &range,
            "--",
            &file_path,
        ],
        Some(p),
    );
    // Root commits don't have a parent — fall back to showing the commit's tree.
    match out {
        Ok(s) => Ok(s),
        Err(_) => run_git(
            &[
                "show",
                "--no-color",
                "--format=",
                "-U3",
                &hash,
                "--",
                &file_path,
            ],
            Some(p),
        ),
    }
}
