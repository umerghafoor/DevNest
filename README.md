# DevNest

A unified desktop control panel for developers and self-hosters. Manage Docker
containers, Tailscale nodes, SSH connections, system services, logs, files, and
more — all from one local-first desktop app built with Tauri 2.

## Status

**Phase 0 — Foundation.** See [docs/plans/](docs/plans/) for the roadmap.

## Stack

- **Desktop shell:** Tauri 2 (Rust + WebView)
- **Frontend:** React 19 + TypeScript + Tailwind CSS v4
- **Local storage:** SQLite via `tauri-plugin-sql`
- **SSH:** `ssh2` Rust crate (added in Phase 1)

## Development

### Prerequisites

- Node.js 22+
- Rust stable (install via [rustup](https://rustup.rs))
- Linux: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libxdo-dev`
- macOS: Xcode command-line tools
- Windows: Microsoft Visual Studio Build Tools

### Run

```bash
npm install
npm run tauri dev
```

### Test / lint

```bash
npm test           # Vitest
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit
npm run format     # Prettier
```

### Rust

```bash
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

## Layout

```text
src/                   React frontend
  app/                 Top-level app component
  components/          Reusable UI (Sidebar, TabBar, StatusBar, MainPanel)
  panels/              Feature panels (Docker, metrics, terminal, …)
  store/               Zustand stores
  lib/                 Frontend utilities
src-tauri/             Tauri + Rust backend
  src/                 Rust modules (commands, db, error, …)
  migrations/          SQLite migrations
docs/plans/            Roadmap and TODO
```
