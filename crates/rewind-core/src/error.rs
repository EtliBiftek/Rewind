use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("not a CS2 demo: {0}")]
    NotADemo(String),
    #[error("failed to parse demo: {0}")]
    Parse(String),
    #[error("demo contains no playable data: {0}")]
    Empty(String),
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;
