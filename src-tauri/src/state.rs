use crate::db::Db;
use crate::log_stream::LogStreamPool;
use crate::ngrok::NgrokPool;
use crate::sql::SqlPool;
use crate::ssh::SessionPool;
use crate::ssh_tunnel::TunnelPool;
use crate::terminal::TerminalPool;

pub struct AppState {
    pub db: Db,
    pub pool: SessionPool,
    pub terminals: TerminalPool,
    pub log_streams: LogStreamPool,
    pub ngrok: NgrokPool,
    pub tunnels: TunnelPool,
    pub sql: SqlPool,
}
