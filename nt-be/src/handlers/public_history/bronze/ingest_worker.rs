//! Shared NearBlocks page helpers for the bronze queue workers.

use axum::http::StatusCode;

use crate::AppState;
use crate::handlers::public_history::bronze::NearblocksPriority;
use crate::handlers::public_history::bronze::api::{
    NearblocksPage, fetch_ft_transfers, fetch_mt_transfers, fetch_receipts,
};
use crate::handlers::public_history::bronze::store::PublicHistorySource;

pub(crate) const PUBLIC_HISTORY_PAGE_LIMIT: u32 = 25;

pub(crate) type HandlerResult<T> = Result<T, (StatusCode, String)>;

pub(crate) fn latest_seen(page: &NearblocksPage) -> Option<i64> {
    page.events.iter().map(|event| event.block_height).max()
}

pub(crate) async fn fetch_source_page(
    state: &AppState,
    account_id: &str,
    source: PublicHistorySource,
    cursor: Option<&str>,
    priority: NearblocksPriority,
) -> HandlerResult<NearblocksPage> {
    match source {
        PublicHistorySource::NearblocksFt => {
            fetch_ft_transfers(
                state,
                account_id,
                cursor,
                PUBLIC_HISTORY_PAGE_LIMIT,
                priority,
            )
            .await
        }
        PublicHistorySource::NearblocksMt => {
            fetch_mt_transfers(
                state,
                account_id,
                cursor,
                PUBLIC_HISTORY_PAGE_LIMIT,
                priority,
            )
            .await
        }
        PublicHistorySource::NearblocksReceipt => {
            fetch_receipts(
                state,
                account_id,
                cursor,
                PUBLIC_HISTORY_PAGE_LIMIT,
                priority,
            )
            .await
        }
    }
}
