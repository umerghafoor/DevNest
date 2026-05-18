# Frontend ↔ backend IPC

DevDash uses Tauri's built-in IPC. Two flavours:

1. **Request / response** — JS calls a Rust `#[tauri::command]` via
   `invoke(name, args)` and awaits the result.
2. **Streaming** — Rust emits Tauri events (`emit("channel:id", payload)`)
   and JS subscribes with `listen("channel:id", cb)`. Used for terminal
   bytes and tail-style log streaming where one request would not fit.

## Request / response

### Frontend side

Every call goes through the typed `api` object in
[`src/lib/api.ts`](../../src/lib/api.ts). That file's `call<T>()` wraps
`invoke<T>()` with one important behaviour:

> If the backend returns `SudoPasswordRequired`, open the global sudo
> dialog, wait for the user to save a password, then retry the call
> once. On cancel, rethrow the original error.

This is why no panel needs to handle sudo prompts manually — they
"just work" the moment a device has `useSudo = true`.

### Argument naming

`invoke` serialises args as JSON. Rust receives them as named
parameters in **camelCase** — Tauri's default conversion of Rust's
`snake_case` parameter names. So a Rust command:

```rust
#[tauri::command]
pub async fn sql_query(
    state: State<'_, AppState>,
    id: String,
    sql: String,
) -> AppResult<QueryResult> { ... }
```

is invoked from JS as `invoke("sql_query", { id, sql })`.

If you need a multi-word argument like `device_id`, JS sends `deviceId`:
`invoke("docker_logs", { deviceId, containerId, tail })`.

### Error shape

Rust errors serialise to a struct:

```ts
interface AppErrorPayload {
  kind: "ssh" | "db" | "notFound" | "invalid" | "sudoPasswordRequired" | "io";
  message: string;
  detail: string | null;
}
```

JS components shouldn't `try { … } catch (e: any)`. Use
`errorMessage(e)` from `api.ts` to extract a string, then surface via
`toast.error(...)`. If you need to branch on the type, use `isAppError(e)`.

## Streaming via events

For data that doesn't fit one request, the backend assigns the caller a
channel id and emits events on `<topic>:<id>`. Two examples in the
codebase:

### Terminal (`terminal.rs`)

```ts
const termId = await api.terminalOpen(deviceId, cols, rows);
const unlisten = await listen<string>(`terminal:${termId}`, (evt) => {
  // evt.payload is base64-encoded bytes; decode and write to xterm
});

// Send keystrokes back
await api.terminalWrite(termId, base64(data));

// Cleanup
unlisten();
await api.terminalClose(termId);
```

### Log streaming (`log_stream.rs`)

```ts
const streamId = uid();
const unlisten = await listen<string>(`log:${streamId}`, (evt) => {
  appendLine(evt.payload);
});
await api.logStreamStart(deviceId, streamId, cmd); // backend now emits
// later:
await api.logStreamStop(streamId);
unlisten();
```

Important: subscribe **before** invoking the start command, otherwise
you race against the first emitted event.

## Adding a new command

End to end:

1. Write the Rust function in the appropriate module:
   ```rust
   #[tauri::command]
   pub async fn my_thing(state: State<'_, AppState>, foo: String) -> AppResult<MyType> {
       ...
   }
   ```
2. Add it to the `invoke_handler!` list in `src-tauri/src/lib.rs`.
3. Mirror the return type in `src/lib/api.ts`:
   ```ts
   export interface MyType { ... }
   ```
4. Add the binding:
   ```ts
   myThing: (foo: string) => call<MyType>("my_thing", { foo }),
   ```
5. Use it from a panel.

Don't forget the camelCase wrinkle for multi-word Rust args.
