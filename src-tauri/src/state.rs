use crate::db::Db;
use crate::ssh::SessionPool;

pub struct AppState {
    pub db: Db,
    pub pool: SessionPool,
}
