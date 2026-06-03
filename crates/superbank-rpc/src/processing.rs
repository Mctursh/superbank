// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

use std::error::Error as StdError;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProcessingError {
    #[error("Database error: {context}")]
    Database {
        context: String,
        #[source]
        source: Option<Box<dyn StdError + Send + Sync>>,
    },
    #[error("Deserialization error: {context}")]
    Deserialization {
        context: String,
        #[source]
        source: Option<Box<dyn StdError + Send + Sync>>,
    },
    #[error("Timeout error: {context}")]
    Timeout {
        context: String,
        #[source]
        source: Option<Box<dyn StdError + Send + Sync>>,
    },
}

pub type ProcessingResult<T> = Result<T, ProcessingError>;

impl ProcessingError {
    pub fn database<E>(context: impl Into<String>, source: E) -> Self
    where
        E: StdError + Send + Sync + 'static,
    {
        ProcessingError::Database {
            context: context.into(),
            source: Some(Box::new(source)),
        }
    }

    pub fn database_msg(context: impl Into<String>) -> Self {
        ProcessingError::Database {
            context: context.into(),
            source: None,
        }
    }

    pub fn deserialization<E>(context: impl Into<String>, source: E) -> Self
    where
        E: StdError + Send + Sync + 'static,
    {
        ProcessingError::Deserialization {
            context: context.into(),
            source: Some(Box::new(source)),
        }
    }

    pub fn deserialization_msg(context: impl Into<String>) -> Self {
        ProcessingError::Deserialization {
            context: context.into(),
            source: None,
        }
    }

    pub fn timeout<E>(context: impl Into<String>, source: E) -> Self
    where
        E: StdError + Send + Sync + 'static,
    {
        ProcessingError::Timeout {
            context: context.into(),
            source: Some(Box::new(source)),
        }
    }

    pub fn timeout_msg(context: impl Into<String>) -> Self {
        ProcessingError::Timeout {
            context: context.into(),
            source: None,
        }
    }
}
