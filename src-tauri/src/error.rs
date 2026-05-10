use serde::ser::SerializeStruct;
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
#[allow(dead_code)]
pub enum AppError {
    #[error("ssh error: {0}")]
    Ssh(String),

    #[error("database error: {0}")]
    Db(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid input: {0}")]
    Invalid(String),

    #[error("sudo password required for device {0}")]
    SudoPasswordRequired(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl AppError {
    fn kind(&self) -> &'static str {
        match self {
            AppError::Ssh(_) => "ssh",
            AppError::Db(_) => "db",
            AppError::NotFound(_) => "notFound",
            AppError::Invalid(_) => "invalid",
            AppError::SudoPasswordRequired(_) => "sudoPasswordRequired",
            AppError::Io(_) => "io",
        }
    }

    fn detail(&self) -> Option<&str> {
        match self {
            AppError::SudoPasswordRequired(id) => Some(id.as_str()),
            _ => None,
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        let mut s = serializer.serialize_struct("AppError", 3)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("message", &self.to_string())?;
        s.serialize_field("detail", &self.detail())?;
        s.end()
    }
}

pub type AppResult<T> = std::result::Result<T, AppError>;
