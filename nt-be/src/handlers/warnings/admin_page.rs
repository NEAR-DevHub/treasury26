use axum::{
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Response},
};
use std::sync::Arc;
use std::sync::LazyLock;

use crate::AppState;

use super::admin::require_admin;
use super::templates;

const ADMIN_HTML: &str = include_str!("admin.html");

static ADMIN_HTML_RENDERED: LazyLock<String> =
    LazyLock::new(|| ADMIN_HTML.replace("\"__TEMPLATE_DATA__\"", &templates::template_data_json()));

pub async fn serve_admin_page(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    match require_admin(&headers, &state) {
        Ok(_) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            Html(ADMIN_HTML_RENDERED.as_str()),
        )
            .into_response(),
        Err(err) => err.into_response(),
    }
}
