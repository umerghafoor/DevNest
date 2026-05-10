# DevNest — High-Level Plan

A unified desktop control panel for developers and self-hosters. Built on Tauri 2, with SSH as the universal command transport.

---

## Guiding principles

1. **Local-first** — UI runs on user's machine; nothing leaks to third parties.
2. **No remote agent** — every remote operation is a plain SSH command. If you can do it over SSH, DevNest can surface it.
3. **One persistent SSH session per device** — reused across all panels (Docker, metrics, files, terminal).
4. **Frontend-agnostic context switching** — selecting a device updates every panel atomically.
5. **Ship narrow vertical slices** — each phase delivers a working product, not a half-built skeleton.

---

## Phase 0 — Foundation (Week 0)

**Goal:** A bootable Tauri 2 app with React + Tailwind, SQLite wired up, basic IPC working.

- Initialize Tauri 2 project with React + TypeScript template
- Set up Tailwind CSS, ESLint, Prettier, Vitest
- Add SQLite via `tauri-plugin-sql`
- Define the IPC command shape (Tauri commands ↔ React)
- Build the app shell: sidebar (devices), main panel (tabs), status bar
- CI: lint + typecheck + build on every push

**Exit criteria:** App launches, shows empty sidebar, can write/read a row from SQLite.

---

## Phase 1 — MVP (Weeks 1–3)

**Goal:** Single-device Docker management + basic system metrics + SSH connection manager. Ship to 5–10 testers.

### 1A. SSH connection layer

- Wrap `ssh2` Rust crate with a `SshSession` type that owns one persistent connection
- Connection pool keyed by device ID
- `run_command(device_id, cmd) -> Result<Output>` Tauri command
- Support key-based and password auth
- Health check / reconnect logic

### 1B. Device manager

- SQLite schema for devices (id, name, host, port, user, auth method, key path)
- React UI: add/edit/delete device, sidebar list
- Localhost as a special "device" that bypasses SSH
- Online/offline indicator (periodic ping)

### 1C. Docker panel

- Run `docker ps --format json` over SSH, parse, render table
- Container actions: start / stop / restart / rm via `docker` CLI
- Container logs: stream `docker logs -f <id>` to a virtualized log view
- Image list, volume list, network list (read-only first)

### 1D. System metrics

- Parse `top -bn1`, `df -h`, `free -m`, `cat /proc/net/dev`
- Poll every 2s while panel is open; pause when hidden
- Recharts line graphs for CPU/RAM/disk/network

**Exit criteria:** Connect to a remote machine, see Docker containers, start/stop one, watch CPU graph for 60 seconds without crashing.

---

## Phase 2 — V1 (Weeks 4–6)

**Goal:** Tailscale + terminal + file browser + multi-device. Public beta.

### 2A. Multi-device session management

- Tabs at top of main panel — each tab is a (device, panel) pair
- Persisted session state per tab
- Atomic context switch when changing devices in sidebar

### 2B. Tailscale panel

- Detect tailscale on remote: `which tailscale`
- `tailscale status --json` → device list with IP, online status, exit node
- Enable/disable exit nodes via `tailscale set --exit-node=...`
- One-click "SSH to this peer" — populates the device manager form

### 2C. xterm.js terminal

- Tauri command opens a PTY-backed shell channel over SSH
- Pipe stdin/stdout to xterm.js via Tauri events
- Multi-tab support — multiple shells per device, multiple devices
- Resize handling (SIGWINCH)

### 2D. SFTP file browser

- Reuse existing SSH session, open SFTP subsystem
- List, navigate, create, rename, delete
- Upload/download with progress events
- In-app text editor (Monaco) for files <2MB

### 2E. Alerts & notifications

- User-defined thresholds (CPU > 80%, container exits, disk > 90%)
- Tauri native notifications when triggered
- In-app activity log

**Exit criteria:** Beta testers can manage 3+ devices simultaneously, edit a config file via the file browser, run a shell command in xterm, and get notified when a container dies.

---

## Phase 3 — V2 (Weeks 7–10)

**Goal:** Power-user features. Log viewer, cron, reverse proxy, env vars, port scanner, process list.

### 3A. Log viewer

- Tail arbitrary files: `tail -F <path>` over SSH
- Built-in shortcuts for `journalctl -u <unit> -f`, `docker logs -f`
- Search, filter, highlight rules
- Pause/resume, jump to bottom, copy line

### 3B. Cron manager

- `crontab -l` to read, `crontab -` to write
- Form-based editor with cron syntax validation
- Show last run / next run (parse with `cronstrue` + cron parser)

### 3C. Reverse proxy manager

- Detect Nginx/Caddy via systemctl + config paths
- Load config file via SFTP, edit in Monaco, save back
- `nginx -t` / `caddy validate` before reload
- `systemctl reload nginx` / `caddy` after save
- Cert expiry: parse `openssl x509 -enddate` for each site

### 3D. Env var manager

- `.env` file editor (per-project, scoped to a path)
- Container env editor — `docker inspect` to read, `docker run` regenerate to write (or restart with new --env)
- Mask sensitive values with reveal-on-click

### 3E. Port scanner

- `ss -tlnp` parse — listening ports + bound process
- Highlight unexpected ports (configurable allowlist)

### 3F. Process list

- `ps aux --sort=-%cpu` or `--sort=-%mem`
- Kill button (signal selector)

**Exit criteria:** All power features working on Linux + macOS remotes. No crashes in a 1-week soak test.

---

## Phase 4 — Launch (Weeks 11–12)

**Goal:** Polish, onboarding, plugin API, public launch.

- First-run onboarding wizard (add first device, test connection, tour panels)
- Plugin API spec + reference plugin (e.g. Pi-hole panel)
- Documentation site (Astro or VitePress)
- Code signing for macOS + Windows
- Auto-update via Tauri updater
- Product Hunt launch assets — screenshots, demo video, landing page

**Exit criteria:** Signed binaries on all 3 platforms, docs live, one community plugin in the wild.

---

## Cross-cutting concerns

| Concern         | Approach                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| Error handling  | Every SSH command returns `Result<Output, SshError>`. UI shows toast on error, never silent fail.               |
| Secrets storage | SSH keys + passwords encrypted at rest via OS keychain (`keyring` crate).                                       |
| Testing         | Unit tests on Rust parsers (docker ps output, top output, etc). Integration tests with a Dockerized SSH server. |
| Performance     | Long-running streams (logs, metrics) use Tauri events, not polling. UI uses virtualization for big lists.       |
| Observability   | Local log file, opt-in crash reporting via Sentry-OSS or similar.                                               |

---

## Risks & open questions

1. **`ssh2` crate maturity** — may need to fall back to `russh` if multiplexing is flaky.
2. **Windows SSH** — OpenSSH on Windows behaves differently; test early.
3. **Docker without sudo** — many remotes need `sudo docker`. Handle gracefully (detect, prompt, or allow per-device sudo prefix).
4. **Tailscale auth** — accessing tailscale CLI on remote may require sudo or membership in `tailscale` group.
5. **Plugin sandboxing** — plugins running arbitrary commands is dangerous. Decide: trusted-only marketplace, or capability scoping.
