# Frontend

React 19 + TypeScript + Vite + Tailwind v4 + Zustand. Lives in `src/`.

## Boot

`src/main.tsx` mounts `<App />` (`src/app/App.tsx`). `App` is the only
component that:

- initialises theme / UI / colour stores;
- loads devices from Rust (`api.listDevices()`);
- registers global keyboard shortcuts (close pane, split, palette, …);
- starts `useDeviceHeartbeat()` — every 15 s, ping each connected non-local
  device and reconnect with backoff (15 / 30 / 60 / 60 s) if it drops.

The shell is `TitleBar` + `Sidebar` + `MainPanel` + `StatusBar`, plus host
components for toasts, confirm dialogs, the command palette, and the
sudo-password dialog.

## Devices, workspaces, panes

The model lives in [`src/store/app-store.ts`](../../src/store/app-store.ts):

- A **device** is `{ id, name, host, port, username, authType, isLocalhost, … }`.
  Persisted server-side in SQLite (`devices.rs`), surfaced to the UI via
  `api.listDevices()`. There's always at least the special `local`
  device representing the host machine.
- A **workspace** holds a binary tree of panes (`paneRoot`). Splits are
  horizontal or vertical with a `ratio` 0–1. Multiple workspaces can
  exist; one is active at a time.
- A **pane** is `{ id, deviceId, panel, instanceId, extra? }`. `panel` is
  a `PanelKind` (e.g. `"terminal"`, `"sql"`); `instanceId` keeps split
  copies of the same panel independent.

Operations on the tree (`openPane`, `splitPane`, `closePane`,
`setSplitRatio`, …) are pure functions on the tree, written so React's
diff is cheap.

When `paneRoot` is `null` and a device is active, `MainPanel` falls back
to `DashboardPanel` (quick launch + device list). Otherwise it renders
the tree through `PaneTile`.

## Panels

One file per panel under `src/panels/`. The kind, label, icon, category,
and "what does this do" description for every panel are centralised in
[`src/components/PaneTile.tsx`](../../src/components/PaneTile.tsx):

- `PanelKind` — the string union.
- `PANEL_LABELS` / `PANEL_ICONS` / `PANEL_DESCRIPTIONS`.
- `PANEL_CATEGORY` / `CATEGORY_ORDER` / `PANEL_ORDER_IN_CATEGORY` —
  used by the dashboard and the title-bar panel picker.
- `PanelContent({ pane })` — switch that routes a pane to its component.

Heavy panels are lazy-loaded. `SqlPanel` pulls in the Monaco editor
(~3 MB chunk), so it lives behind `React.lazy` + `Suspense` to keep the
main bundle small.

## Stores

All stores use Zustand. Conventions:

- One store per concern, no cross-store imports beyond types.
- A store **never calls Rust**. Components call `api.*`, await, then
  feed the result into the store with a setter.
- Persisted stores write to `localStorage` directly in the setter — see
  `http-store.ts` / `sql-store.ts` for the pattern.

The stores that matter:

| File                 | What it owns                                                   |
| -------------------- | -------------------------------------------------------------- |
| `app-store.ts`       | Devices, workspaces, pane tree, connection statuses            |
| `theme-store.ts`     | `light` / `dark` / `system` + applies CSS classes              |
| `ui-store.ts`        | Accent colour preset                                           |
| `colors-store.ts`    | Per-CSS-var overrides for advanced theme customisation         |
| `shortcuts-store.ts` | Customisable keybindings (`closePane`, `splitHorizontal`, …)   |
| `palette-store.ts`   | Command-palette open state                                     |
| `recents-store.ts`   | Recently used files / commands                                 |
| `http-store.ts`      | Saved HTTP requests                                            |
| `sql-store.ts`       | Saved SQL connections (password lives in OS keyring, not here) |
| `services-store.ts`  | Local service definitions                                      |
| `sudo-store.ts`      | Pending sudo-password prompts                                  |

## API layer

[`src/lib/api.ts`](../../src/lib/api.ts) is the only file that imports
`@tauri-apps/api/core.invoke`. It exports:

- TypeScript types mirroring every Rust struct returned to JS;
- a typed `api` object: one method per Tauri command;
- `errorMessage(e)` — pulls the human-readable message off an
  `AppErrorPayload` (or any thrown thing) for toasts.

If you add a Rust command, you add a binding here in the same change —
otherwise the panel has no typed way to call it.

## Styling

Tailwind v4 with custom CSS variables (`--color-bg`, `--color-fg`,
`--color-accent`, …) defined in `src/styles.css`. Components reference
them as `text-(--color-fg)` etc., which lets the theme store flip dark /
light by toggling a class on `<html>`.

## Tests

`vitest` with jsdom. The one suite that exists (`app-store.test.ts`)
covers the tree mutations. Run with `npx vitest run`.
