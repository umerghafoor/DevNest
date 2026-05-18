# Adding a panel

A panel is a self-contained React component that lives in `src/panels/`,
takes a `deviceId` prop (or none, for app-wide panels), and can call
Rust through the typed `api` object. This doc walks through every place
you have to touch, using the SQL Client panel as the worked example —
look at the actual git diff that added it for a complete reference.

## 1. Register the panel kind

[`src/store/app-store.ts`](../../src/store/app-store.ts) — extend the
`PanelKind` union:

```ts
export type PanelKind =
  | "docker"
  | ...
  | "sql";
```

## 2. Wire metadata in PaneTile

[`src/components/PaneTile.tsx`](../../src/components/PaneTile.tsx) is
the single source of truth for label/icon/category/description. Add
your panel to **all five** maps:

```ts
PANEL_ICONS.sql = "◰";
PANEL_LABELS.sql = "SQL Client";
PANEL_DESCRIPTIONS.sql = "Connect to Postgres / MySQL / SQLite";
PANEL_CATEGORY.sql = "code";
PANEL_ORDER_IN_CATEGORY.code.push("sql"); // or insert at the right spot
```

If you forget any of them TypeScript will refuse to compile —
`Record<PanelKind, …>` enforces exhaustiveness.

## 3. Implement the component

`src/panels/SqlPanel.tsx` (or wherever). Conventions:

- One default-exported function component.
- If the panel is per-device, take `{ deviceId }: { deviceId: string }`.
  If it's per-instance (multiple splits of the same panel staying
  independent), also take `instanceId?: string`.
- Don't `invoke` directly. Call through `api.*` from
  [`src/lib/api.ts`](../../src/lib/api.ts).
- For state that should survive remounts (e.g. saved connections),
  add a Zustand store under `src/store/`.
- For sensitive values (passwords, tokens), use the keyring path —
  add a `*_set_password` / `*_get_password` command pair that wraps
  `secrets.rs`.

## 4. Route the panel

In `PaneTile.tsx::PanelContent`, add the case:

```tsx
case "sql":
  return <SqlPanel />;
```

If the component is heavy (Monaco, big charting library, etc.),
lazy-load it so the main bundle stays small:

```tsx
const SqlPanel = lazy(() =>
  import("../panels/SqlPanel").then((m) => ({ default: m.SqlPanel })),
);

case "sql":
  return (
    <Suspense fallback={<div>Loading…</div>}>
      <SqlPanel />
    </Suspense>
  );
```

## 5. (Optional) Add Rust commands

If you need backend work, follow the recipe in
[`ipc.md`](ipc.md#adding-a-new-command): module function → `#[tauri::command]`
in `commands.rs` → `invoke_handler!` in `lib.rs` → typed binding in
`api.ts`. For SQL this meant a new module (`sql.rs`) plus an SSH
tunneller (`ssh_tunnel.rs`) plus a keyring namespace
(`secrets.rs::set_sql`).

## 6. Verify

```bash
npx tsc --noEmit       # frontend
cd src-tauri && cargo check
cd .. && npx vitest run
cd src-tauri && cargo test     # if you added Rust tests
```

UI changes still need a manual smoke test — `npx tauri dev` and click
through the panel. Type-check passing doesn't mean the panel works.

## What you get "for free"

Once the panel kind exists, it shows up in:

- The Dashboard's "Quick launch" grid (grouped by category).
- The title-bar Panel picker.
- The command palette (Cmd/Ctrl-K → fuzzy search by label).
- Splitting (Cmd/Ctrl-D / Cmd/Ctrl-Shift-D inherits the active panel's
  kind into the new pane).
- Sudo prompts if any of your Rust commands return
  `AppError::SudoPasswordRequired` — `call<T>()` opens the dialog and
  retries transparently.
