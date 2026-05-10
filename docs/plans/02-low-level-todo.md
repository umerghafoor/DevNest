# DevNest — Low-Level TODO

Granular, ordered task list. Each task should be small enough to complete in one sitting. Check off as you go.

---

## Phase 0 — Foundation

### 0.1 Project init

- [ ] `npm create tauri-app@latest` with React + TypeScript + Vite template
- [ ] Move generated files into repo root
- [ ] Verify `npm run tauri dev` opens window with default Tauri page
- [ ] Add `.gitignore` for `node_modules/`, `src-tauri/target/`, `dist/`

### 0.2 Frontend tooling

- [ ] Install Tailwind CSS v4: `npm i -D tailwindcss @tailwindcss/vite`
- [ ] Configure Vite plugin and `index.css` with `@import "tailwindcss"`
- [ ] Install ESLint + Prettier with Tauri/React presets
- [ ] Install Vitest + `@testing-library/react`
- [ ] Add `npm scripts`: `lint`, `format`, `test`, `typecheck`
- [ ] Sample component test passes

### 0.3 Rust tooling

- [ ] Add `clippy` + `rustfmt` to CI
- [ ] Add `thiserror` for error types
- [ ] Add `serde` + `serde_json` for IPC payloads
- [ ] Add `tokio` (rt-multi-thread, fs, net, sync features)
- [ ] Add `tracing` + `tracing-subscriber` for structured logs

### 0.4 SQLite

- [ ] Add `tauri-plugin-sql` with `sqlite` feature
- [ ] Define migration: `devices` table (id, name, host, port, user, auth_type, key_path, created_at)
- [ ] Wrap DB access in a `db.rs` module with typed helpers
- [ ] Smoke test: insert + select a device row from a Tauri command

### 0.5 App shell

- [ ] Layout: `<Sidebar />` (left, 280px) + `<MainPanel />` (flex-1) + `<StatusBar />` (bottom, 24px)
- [ ] Sidebar shows `<DeviceList />` (empty state OK)
- [ ] MainPanel shows `<Tabs />` placeholder
- [ ] Add Zustand or Jotai store for global state (`activeDevice`, `tabs`)
- [ ] Routing via `react-router` or simple state-based view switching

### 0.6 CI/CD

- [ ] GitHub Actions: lint + typecheck + cargo check + test on push
- [ ] Build matrix: Linux, macOS, Windows
- [ ] Cache `node_modules` and `~/.cargo`

---

## Phase 1 — MVP

### 1.1 SSH session core

- [ ] Add `ssh2 = "0.9"` to `Cargo.toml`
- [ ] Define `SshSession` struct holding `ssh2::Session` + connection metadata
- [ ] Define `SshError` enum (Connect, Auth, Channel, Io, Timeout)
- [ ] Define `SessionPool`: `Arc<Mutex<HashMap<DeviceId, SshSession>>>`
- [ ] Function: `connect(device: &Device) -> Result<SshSession>`
- [ ] Function: `run_command(&mut self, cmd: &str) -> Result<CommandOutput>` (stdout, stderr, exit_code)
- [ ] Function: `is_alive(&self) -> bool` (cheap channel open/close)
- [ ] Reconnect on dead session
- [ ] Unit tests against a Dockerized OpenSSH server (`linuxserver/openssh-server`)

### 1.2 Tauri commands for SSH

- [ ] `connect_device(device_id) -> Result<()>`
- [ ] `disconnect_device(device_id) -> Result<()>`
- [ ] `run_remote_command(device_id, cmd) -> Result<CommandOutput>` — internal use only, NOT exposed to plugins
- [ ] `device_status(device_id) -> ConnectionStatus`
- [ ] Background task: every 30s ping all connected devices

### 1.3 Device manager UI

- [ ] `<AddDeviceDialog />` form: name, host, port (default 22), user, auth (key path or password)
- [ ] Form validation with `zod`
- [ ] Save to SQLite via Tauri command `create_device`
- [ ] `<DeviceList />` queries SQLite, renders rows
- [ ] Each row: name, online dot (green/red/yellow), connect/disconnect button
- [ ] Right-click menu: edit, delete, duplicate
- [ ] `<EditDeviceDialog />` reuses form
- [ ] Localhost device pre-seeded on first run, marked non-deletable

### 1.4 Secrets storage

- [ ] Add `keyring = "2"` crate
- [ ] When user enters password, store in OS keychain keyed by device ID
- [ ] DB only stores reference, not the secret
- [ ] On `connect`, fetch secret from keychain
- [ ] Migration path for SSH key passphrases too

### 1.5 Docker panel — read path

- [ ] Tauri command: `docker_list_containers(device_id) -> Vec<Container>`
- [ ] Run `docker ps -a --format '{{json .}}'` and parse line-delimited JSON
- [ ] Define `Container` struct (id, name, image, status, state, ports, created)
- [ ] React: `<DockerPanel />` with tab `Containers | Images | Volumes | Networks`
- [ ] `<ContainerTable />` with virtualized rows (`@tanstack/react-virtual`)
- [ ] Auto-refresh every 5s while panel is visible
- [ ] Loading + error states

### 1.6 Docker panel — write path

- [ ] Commands: `docker_start`, `docker_stop`, `docker_restart`, `docker_remove(force?)`
- [ ] Confirmation modal for destructive ops
- [ ] Optimistic UI update + revert on failure
- [ ] Toast on success/failure

### 1.7 Docker logs streaming

- [ ] Tauri command: `docker_stream_logs(device_id, container_id, channel_id)`
- [ ] Spawn background task running `docker logs -f --tail 200 <id>`
- [ ] Emit Tauri events `docker:logs:<channel_id>` with each line
- [ ] React: `<LogStream />` with virtualized list, pause/resume, search box
- [ ] Cleanup: kill SSH channel when component unmounts

### 1.8 System metrics

- [ ] Parser: `parse_top_bn1(output) -> CpuMemSnapshot`
- [ ] Parser: `parse_df_h(output) -> Vec<DiskUsage>`
- [ ] Parser: `parse_proc_net_dev(output) -> Vec<NetIface>`
- [ ] Tauri command: `metrics_snapshot(device_id) -> MetricsSnapshot`
- [ ] React: `<MetricsPanel />` with 4 sparklines (CPU, mem, disk, net)
- [ ] Recharts `<LineChart />` with sliding 60-point window
- [ ] Poll every 2s when panel visible

### 1.9 Phase 1 polish

- [ ] Keyboard shortcuts: ⌘K to switch device, ⌘1/2/3 to switch panel
- [ ] Empty states everywhere (no devices, no containers, no metrics yet)
- [ ] Dark mode toggle, persisted to SQLite settings table
- [ ] Crash log: catch panics in Rust, log to `~/.devnest/logs/crash.log`
- [ ] Internal alpha: build signed dmg/AppImage/msi for 5 testers

---

## Phase 2 — V1

### 2.1 Tab system

- [ ] Tab data model: `{ id, deviceId, panelKind, state }`
- [ ] `<TabBar />` with reorder, close, pin
- [ ] Persist tabs to SQLite on change, restore on app start
- [ ] Keyboard: ⌘T new, ⌘W close, ⌘⇧[ / ⌘⇧] cycle

### 2.2 Tailscale panel

- [ ] Detection: run `which tailscale && tailscale status --json` once on connect
- [ ] Parser: `parse_tailscale_status(json) -> TailnetView`
- [ ] React: `<TailscalePanel />` showing self + peers
- [ ] Action: enable exit node (`tailscale set --exit-node=<ip>`)
- [ ] Action: clear exit node (`tailscale set --exit-node=`)
- [ ] "Connect via SSH" button → opens add-device dialog prefilled

### 2.3 PTY terminal

- [ ] Switch SSH layer to support `request_pty` + `shell` channels
- [ ] Tauri command: `terminal_open(device_id) -> terminal_id`
- [ ] Tauri command: `terminal_write(terminal_id, data)`
- [ ] Tauri command: `terminal_resize(terminal_id, cols, rows)`
- [ ] Event: `terminal:data:<terminal_id>` emits chunks
- [ ] React: `<Terminal />` wrapping xterm.js
- [ ] Multi-tab terminal panel
- [ ] Copy on select, paste on ⌘V

### 2.4 SFTP file browser

- [ ] Open SFTP subsystem on existing session (one per device)
- [ ] Tauri commands: `sftp_list_dir`, `sftp_read_file`, `sftp_write_file`, `sftp_mkdir`, `sftp_rmdir`, `sftp_rename`, `sftp_delete`
- [ ] Streaming upload/download with progress events
- [ ] React: `<FileBrowser />` two-pane (tree + table) like macOS Finder column view
- [ ] Drag-drop upload from OS to file browser
- [ ] In-app editor: Monaco for files <2MB, warning above
- [ ] Save = SFTP write back

### 2.5 Alerts engine

- [ ] SQLite table: `alert_rules` (device_id, kind, threshold, enabled)
- [ ] Background scheduler evaluates rules every 30s using metrics_snapshot
- [ ] Notification: Tauri `notification` plugin
- [ ] In-app `<ActivityLog />` panel listing all fired alerts
- [ ] Rule editor UI

### 2.6 Beta polish

- [ ] Onboarding tooltips on first run
- [ ] Auto-update channel via Tauri updater (beta release track)
- [ ] Public landing page with download links
- [ ] Beta tester feedback widget (in-app form → email)

---

## Phase 3 — V2

### 3.1 Log viewer

- [ ] Tauri command: `log_tail(device_id, path, channel_id)` → spawns `tail -F`
- [ ] Presets: docker, journalctl unit, file path
- [ ] React: `<LogViewer />` with search bar (live filter), level filter, highlight rules
- [ ] Highlight rules editor (regex → color)
- [ ] Pause/resume buffer
- [ ] Export selected lines to file

### 3.2 Cron manager

- [ ] Tauri command: `cron_list(device_id)` runs `crontab -l`
- [ ] Tauri command: `cron_save(device_id, content)` pipes into `crontab -`
- [ ] Parser: `parse_crontab(text) -> Vec<CronEntry>`
- [ ] React: `<CronPanel />` table + add/edit modal
- [ ] Validation: cron expression parser (use `cron` crate)
- [ ] Show "next run" + human-readable description

### 3.3 Reverse proxy manager

- [ ] Detect: `systemctl is-active nginx` / `caddy`
- [ ] Locate config: `/etc/nginx/sites-enabled/`, `/etc/caddy/Caddyfile`
- [ ] Load via SFTP, edit in Monaco
- [ ] Validate before save: `nginx -t` / `caddy validate`
- [ ] Reload after save: `sudo systemctl reload nginx`
- [ ] List active vhosts (parse config or `nginx -T`)
- [ ] Cert expiry: `openssl x509 -enddate -noout -in <path>`

### 3.4 Env var manager

- [ ] `.env` editor: SFTP read, parse with `dotenv` style, masked table view
- [ ] Container env: `docker inspect <id> --format '{{json .Config.Env}}'`
- [ ] Edit container env requires recreate — show warning + diff
- [ ] Reveal-on-click for masked values, copy-to-clipboard

### 3.5 Port scanner

- [ ] Run `ss -tlnp` (or `netstat -tlnp` fallback)
- [ ] Parser: `parse_ss_output(text) -> Vec<ListeningPort>`
- [ ] React: `<PortsPanel />` table with filter
- [ ] Allowlist editor — unexpected ports highlighted red

### 3.6 Process list

- [ ] Run `ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu | head -50`
- [ ] React: `<ProcessPanel />` sortable table
- [ ] Kill button → signal picker modal → `kill -<sig> <pid>`
- [ ] Refresh every 3s

### 3.7 Soak testing

- [ ] Set up a 24/7 dev rig with 5 connected remotes for a week
- [ ] Monitor for memory leaks, dead sessions, panic logs
- [ ] Fix every issue before Phase 4

---

## Phase 4 — Launch

### 4.1 Onboarding

- [ ] First-run wizard: welcome → add first device → test connection → tour
- [ ] "Try with localhost" path for users without remotes
- [ ] Sample plugin gallery preview

### 4.2 Plugin API

- [ ] Define plugin manifest schema (`plugin.json`)
- [ ] Plugin loader: discover `~/.devnest/plugins/`, validate, load
- [ ] Expose API: `runCommand(deviceId, cmd)`, `registerPanel(name, component)`, `getActiveDevice()`
- [ ] Capability declarations in manifest (which panels, which commands)
- [ ] Reference plugin: Pi-hole admin (read stats from API endpoint)
- [ ] Plugin dev docs

### 4.3 Distribution

- [ ] Code-sign macOS app + notarize
- [ ] Code-sign Windows installer (EV cert or self-signed warning)
- [ ] Linux: AppImage + .deb + .rpm
- [ ] Tauri updater: production release track
- [ ] Homebrew tap, AUR package

### 4.4 Docs site

- [ ] VitePress site: getting started, panels, plugin guide, FAQ
- [ ] Search via Pagefind
- [ ] Hosted on Cloudflare Pages

### 4.5 Launch assets

- [ ] 5 hero screenshots, 1 GIF demo (use Charm's vhs or similar)
- [ ] 90-second walkthrough video
- [ ] Product Hunt page draft
- [ ] HN "Show HN" post draft
- [ ] Twitter/Bluesky launch thread

---

## Definition of done (per task)

A task is done when:

1. Code compiles + lints clean
2. Tests pass (unit for Rust parsers, component for non-trivial React)
3. Manual smoke test on at least one real remote
4. No new TODOs introduced without an issue link
5. PR merged to main
