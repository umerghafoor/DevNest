# DevNest

Version 1.3.1 · Website: [devnest.optikflows.com](https://devnest.optikflows.com)

A unified desktop control panel for developers and self-hosters. Manage Docker
containers, Tailscale nodes, SSH connections, system services, logs, files, and
more — all from one local-first desktop app built with Tauri 2.
dation. See [docs/plans/](docs/plans/) for the roadmap.

## Demo

Watch the demo on YouTube: https://youtu.be/f_sWK1p-9cg
[![DevNest Demo](https://img.youtube.com/vi/f_sWK1p-9cg/maxresdefault.jpg)](https://youtu.be/f_sWK1p-9cg)

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

### Releases

Pushes to `main` automatically create a GitHub Release with installables for:

- Linux (`.deb`, `.rpm`, `.AppImage`)
- macOS (bundled desktop artifacts)
- Windows (bundled desktop artifacts)
- Android (`.apk` debug build)

macOS builds are **ad-hoc signed but not notarized** (notarization needs a
paid Apple Developer account). The first time you open DevNest, macOS blocks
it: go to **System Settings → Privacy & Security**, scroll to the message
about DevNest and click **Open Anyway**. You only need to do this once.

If macOS says the app **"is damaged and can't be opened"** (builds from
before 1.3.1 weren't signed at all), remove the download quarantine flag
once in Terminal:

```sh
xattr -dr com.apple.quarantine /Applications/DevNest.app
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

## License

[MIT](LICENSE) © 2026 Umer Ghafoor. See also the [privacy policy](https://devnest.optikflows.com/privacy.html).
