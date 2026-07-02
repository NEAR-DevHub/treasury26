use serde::{Deserialize, Serialize};

use crate::handlers::public_history::bronze::store::PublicHistorySource;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PublicHistoryJob {
    RefreshLatest {
        job_key: String,
        account_id: String,
        source: PublicHistorySource,
        trigger_block_height: i64,
        trigger_transaction_hash: Option<String>,
    },
    BackfillPage {
        job_key: String,
        account_id: String,
        source: PublicHistorySource,
        cursor: Option<String>,
    },
}

impl PublicHistoryJob {
    pub fn refresh_latest(
        account_id: String,
        source: PublicHistorySource,
        trigger_block_height: i64,
        trigger_transaction_hash: Option<String>,
    ) -> Self {
        let job_key = latest_job_key(&account_id, source);
        Self::RefreshLatest {
            job_key,
            account_id,
            source,
            trigger_block_height,
            trigger_transaction_hash,
        }
    }

    pub fn backfill_page(
        account_id: String,
        source: PublicHistorySource,
        cursor: Option<String>,
    ) -> Self {
        let job_key = backfill_job_key(&account_id, source, cursor.as_deref());
        Self::BackfillPage {
            job_key,
            account_id,
            source,
            cursor,
        }
    }

    pub fn job_key(&self) -> &str {
        match self {
            Self::RefreshLatest { job_key, .. } | Self::BackfillPage { job_key, .. } => job_key,
        }
    }
}

pub fn latest_job_key(account_id: &str, source: PublicHistorySource) -> String {
    format!("latest:{}:{}", account_id, source.as_str())
}

pub fn backfill_job_key(
    account_id: &str,
    source: PublicHistorySource,
    cursor: Option<&str>,
) -> String {
    format!(
        "backfill:{}:{}:{}",
        account_id,
        source.as_str(),
        cursor.unwrap_or("start")
    )
}
