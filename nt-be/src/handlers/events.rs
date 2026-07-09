use std::{convert::Infallible, sync::Arc, time::Duration};

use async_stream::stream;
use axum::{
    extract::{Query, State},
    response::sse::{Event, KeepAlive, Sse},
};
use futures::Stream;
use near_api::AccountId;
use serde::Deserialize;
use tokio::sync::broadcast;

use crate::{AppEvent, AppState, auth::OptionalAuthUser};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEventsQuery {
    pub account_id: AccountId,
}

pub async fn app_events(
    State(state): State<Arc<AppState>>,
    user: OptionalAuthUser,
    Query(query): Query<AppEventsQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, (axum::http::StatusCode, String)> {
    user.verify_member_if_confidential(&state.db_pool, query.account_id.as_ref())
        .await?;

    let account_id = query.account_id.to_string();
    let mut rx = state.event_tx.subscribe();

    let event_stream = stream! {
        loop {
            match rx.recv().await {
                Ok(event) if event.account_id == account_id => {
                    match serde_json::to_string(&event) {
                        Ok(payload) => {
                            yield Ok(Event::default()
                                .event(AppEvent::TREASURY_PROJECTION_UPDATED)
                                .data(payload));
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "failed to serialize treasury SSE event");
                        }
                    }
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, account_id = %account_id, "treasury SSE receiver lagged");
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    Ok(Sse::new(event_stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    ))
}
