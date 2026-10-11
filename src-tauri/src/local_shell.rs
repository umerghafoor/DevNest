/// Helpers for running local processes portably.
///
/// Widgets send POSIX shell scripts, so on Windows we need a real `sh`. It's
/// rarely on PATH there, but Git for Windows ships one, so we look for that.
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

/// A `Command` for `program` that won't flash a console window on Windows.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// `sh -c <script>`, using the POSIX shell found by `posix_shell`.
pub fn sh(script: &str) -> Command {
    let mut cmd = command(posix_shell());
    cmd.arg("-c").arg(script);
    cmd
}

/// Path to a POSIX `sh`. On Unix that's just `sh`; on Windows we search PATH,
/// then the Git for Windows install next to `git.exe`, then the usual
/// install directories. Falls back to `sh` so the spawn error is readable.
pub fn posix_shell() -> &'static PathBuf {
    static SHELL: OnceLock<PathBuf> = OnceLock::new();
    SHELL.get_or_init(|| {
        if cfg!(windows) {
            find_windows_sh().unwrap_or_else(|| PathBuf::from("sh"))
        } else {
            PathBuf::from("sh")
        }
    })
}

fn find_windows_sh() -> Option<PathBuf> {
    let path_dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();

    if let Some(sh) = path_dirs
        .iter()
        .map(|d| d.join("sh.exe"))
        .find(|p| p.is_file())
    {
        return Some(sh);
    }

    // git.exe usually lives in <Git>\cmd or <Git>\bin; sh.exe is in <Git>\bin.
    let from_git = path_dirs
        .iter()
        .filter(|d| d.join("git.exe").is_file())
        .filter_map(|d| d.parent().map(|root| root.join("bin").join("sh.exe")));

    let from_install = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|v| std::env::var_os(v))
        .map(|d| PathBuf::from(d).join("Git"))
        .chain(
            std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Programs").join("Git")),
        )
        .map(|root| root.join("bin").join("sh.exe"));

    from_git.chain(from_install).find(|p| p.is_file())
}
