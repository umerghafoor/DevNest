-- DevNest initial schema.
--
-- devices: SSH-reachable hosts the user has registered. Localhost is seeded
-- on first run as a non-deletable row so the app always has somewhere to go.
-- auth_type=`key` means we look up the private key passphrase in the OS
-- keychain under (service="devnest", user=<id>); auth_type=`password` means
-- the password itself is in the keychain. The DB never stores secrets.
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL,
    auth_type TEXT NOT NULL CHECK (auth_type IN ('key', 'password', 'localhost')),
    key_path TEXT,
    is_localhost INTEGER NOT NULL DEFAULT 0,
    sudo_prefix TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_name ON devices(name);

-- settings: KV store for app preferences (theme, last active device, etc).
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- tabs: persisted main-panel tabs so sessions survive restart.
CREATE TABLE IF NOT EXISTS tabs (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    panel_kind TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tabs_position ON tabs(position);

-- alert_rules: user-defined thresholds for the alerting engine (Phase 2).
CREATE TABLE IF NOT EXISTS alert_rules (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    threshold REAL NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);
