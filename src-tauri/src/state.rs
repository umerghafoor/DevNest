use crate::db::Db;
use crate::log_stream::LogStreamPool;
use crate::ssh::SessionPool;
use crate::terminal::TerminalPool;

pub struct AppState {
    pub db: Db,
    pub pool: SessionPool,
    pub terminals: TerminalPool,
    pub log_streams: LogStreamPool,
}
