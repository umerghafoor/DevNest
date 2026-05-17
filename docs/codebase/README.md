# Codebase guide

DevDash (package name `devnest`) is a Tauri 2 desktop app: a React frontend
talking to a Rust backend over Tauri's IPC. It targets developers and
self-hosters who want one window for SSH, Docker, logs, metrics, Git, an
HTTP client, a SQL client, and so on.

This folder is the orientation manual for the code itself. If you want to
_use_ the app, start with the top-level `README.md`. If you want to extend
it, start here.

## At a glance

```
DevDash/
├── src/                # React + TypeScript frontend (Vite)
│   ├── app/            # App shell + global hooks
│   ├── components/     # Cross-panel UI (sidebar, titlebar, toasts, …)
│   ├── panels/         # One file per panel (Docker, Git, SQL, …)
│   ├── store/          # Zustand stores (one per concern)
│   ├── lib/            # api.ts (typed IPC), fuzzy, theme helpers, …
│   ├── styles.css      # Tailwind v4 + custom CSS vars
│   └── main.tsx        # Vite entry
├── src-tauri/          # Rust backend (Tauri 2)
│   └── src/            # One module per concern (ssh, sql, docker, …)
├── docs/codebase/      # This folder
└── docs/plans/         # Roadmap & design notes (separate from the code)
```

A single browser window mounts `App.tsx`. The user picks a **device**
(localhost or remote SSH) in the sidebar and opens **panels** in a tiled
workspace. Each panel calls into Rust through `src/lib/api.ts`, which is
the only place `@tauri-apps/api/core.invoke` is used directly.

## The four reading orders

1. **"How does the UI work?"** → [frontend.md](frontend.md)
2. **"How does the backend work?"** → [backend.md](backend.md)
3. **"How do the two sides talk?"** → [ipc.md](ipc.md)
4. **"I want to add my own panel"** → [adding-a-panel.md](adding-a-panel.md)

## Key conventions

- **One store per concern.** Devices/workspaces/panes live in
  `app-store.ts`; SQL connections in `sql-store.ts`; theme in
  `theme-store.ts`; etc. Stores never call Rust directly — they hold
  state, components call `api.*`, then write the result back into a
  store.
- **One Rust module per concern.** `docker.rs`, `git.rs`, `metrics.rs`,
  `sql.rs`. `commands.rs` is the thin Tauri-facing layer that wraps
  these modules into `#[tauri::command]` functions.
- **Errors flow as `AppError`.** Rust returns `AppResult<T>`; the
  frontend `call<T>()` helper rejects with a typed `AppErrorPayload`
  (`kind`, `message`, `detail`). Components surface them with
  `errorMessage(e)` and a toast.
- **Devices and panes are first-class.** Every panel takes a `deviceId`
  prop; panes are tiled in a binary split tree.
- **No CDNs at runtime.** Monaco and other heavy assets are bundled —
  the app must work offline.
