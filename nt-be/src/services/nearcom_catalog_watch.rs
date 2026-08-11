//! Notify-only watcher for near.com's private token catalog.
//!
//! Fetches `apps/defuse-near/src/tokens/production.json` from the private
//! `defuse-frontend-monorepos` repo via the GitHub Contents API, diffs it
//! against our vendored [`nearcom-tokens.json`], and sends a Telegram ops
//! alert summarizing changes. Never writes the vendored file.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use base64::Engine;
use serde::Deserialize;
use serde_json::Value;

use crate::AppState;

const UPSTREAM_REPO: &str = "defuse-protocol/defuse-frontend-monorepos";
const UPSTREAM_PATH: &str = "apps/defuse-near/src/tokens/production.json";
const VENDORED_CATALOG: &str = include_str!("../../data/nearcom-tokens.json");

#[derive(Debug, Deserialize)]
struct GithubContentsResponse {
    sha: String,
    content: Option<String>,
    encoding: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CatalogEntry {
    symbol: String,
    origin_chain: String,
    bridge: String,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct CatalogDiff {
    pub(crate) added: Vec<(String, CatalogEntry)>,
    pub(crate) removed: Vec<(String, CatalogEntry)>,
    pub(crate) updated: Vec<(String, CatalogEntry, CatalogEntry)>,
}

impl CatalogDiff {
    pub(crate) fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.updated.is_empty()
    }

    pub(crate) fn telegram_html(&self, upstream_sha: &str) -> String {
        let mut lines = vec![
            "<b>near.com token catalog changed</b>".to_string(),
            format!(
                "Upstream <code>{}</code> @ <code>{}</code>",
                UPSTREAM_PATH,
                &upstream_sha[..upstream_sha.len().min(12)]
            ),
            "Notify-only — review and sync <code>nt-be/data/nearcom-tokens.json</code> manually."
                .to_string(),
            String::new(),
        ];

        if !self.added.is_empty() {
            lines.push(format!("<b>Added ({})</b>", self.added.len()));
            for (id, entry) in self.added.iter().take(25) {
                lines.push(format!(
                    "• + <code>{}</code> {} on {} ({})",
                    html_escape(id),
                    html_escape(&entry.symbol),
                    html_escape(&entry.origin_chain),
                    html_escape(&entry.bridge)
                ));
            }
            if self.added.len() > 25 {
                lines.push(format!("…and {} more", self.added.len() - 25));
            }
            lines.push(String::new());
        }

        if !self.removed.is_empty() {
            lines.push(format!("<b>Removed ({})</b>", self.removed.len()));
            for (id, entry) in self.removed.iter().take(25) {
                lines.push(format!(
                    "• − <code>{}</code> {} on {}",
                    html_escape(id),
                    html_escape(&entry.symbol),
                    html_escape(&entry.origin_chain)
                ));
            }
            if self.removed.len() > 25 {
                lines.push(format!("…and {} more", self.removed.len() - 25));
            }
            lines.push(String::new());
        }

        if !self.updated.is_empty() {
            lines.push(format!("<b>Updated ({})</b>", self.updated.len()));
            for (id, before, after) in self.updated.iter().take(25) {
                lines.push(format!(
                    "• ~ <code>{}</code> {}/{} → {}/{}",
                    html_escape(id),
                    html_escape(&before.origin_chain),
                    html_escape(&before.bridge),
                    html_escape(&after.origin_chain),
                    html_escape(&after.bridge)
                ));
            }
            if self.updated.len() > 25 {
                lines.push(format!("…and {} more", self.updated.len() - 25));
            }
        }

        lines.join("\n")
    }
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn flatten_catalog(root: &Value) -> BTreeMap<String, CatalogEntry> {
    let mut out = BTreeMap::new();
    let Some(tokens) = root.get("tokens").and_then(|t| t.as_array()) else {
        return out;
    };
    for token in tokens {
        if let Some(grouped) = token.get("groupedTokens").and_then(|g| g.as_array()) {
            for base in grouped {
                if let Some((id, entry)) = base_entry(base) {
                    out.insert(id, entry);
                }
            }
        } else if let Some((id, entry)) = base_entry(token) {
            out.insert(id, entry);
        }
    }
    out
}

fn base_entry(base: &Value) -> Option<(String, CatalogEntry)> {
    let id = base.get("defuseAssetId")?.as_str()?.to_string();
    let symbol = base
        .get("symbol")
        .and_then(|s| s.as_str())
        .unwrap_or("?")
        .to_string();
    let origin_chain = base
        .get("originChainName")
        .and_then(|s| s.as_str())
        .unwrap_or("?")
        .to_string();
    let bridge = base
        .get("deployments")
        .and_then(|d| d.as_array())
        .and_then(|arr| arr.first())
        .and_then(|d| d.get("bridge"))
        .and_then(|b| b.as_str())
        .unwrap_or("?")
        .to_string();
    Some((
        id,
        CatalogEntry {
            symbol,
            origin_chain,
            bridge,
        },
    ))
}

pub(crate) fn diff_catalogs(
    vendored_json: &str,
    upstream_json: &str,
) -> Result<CatalogDiff, String> {
    let vendored: Value =
        serde_json::from_str(vendored_json).map_err(|e| format!("vendored parse: {e}"))?;
    let upstream: Value =
        serde_json::from_str(upstream_json).map_err(|e| format!("upstream parse: {e}"))?;
    let left = flatten_catalog(&vendored);
    let right = flatten_catalog(&upstream);

    let left_ids: BTreeSet<_> = left.keys().cloned().collect();
    let right_ids: BTreeSet<_> = right.keys().cloned().collect();

    let mut diff = CatalogDiff::default();
    for id in right_ids.difference(&left_ids) {
        if let Some(entry) = right.get(id) {
            diff.added.push((id.clone(), entry.clone()));
        }
    }
    for id in left_ids.difference(&right_ids) {
        if let Some(entry) = left.get(id) {
            diff.removed.push((id.clone(), entry.clone()));
        }
    }
    for id in left_ids.intersection(&right_ids) {
        let before = left.get(id).cloned();
        let after = right.get(id).cloned();
        if let (Some(before), Some(after)) = (before, after)
            && before != after
        {
            diff.updated.push((id.clone(), before, after));
        }
    }
    Ok(diff)
}

async fn fetch_upstream_catalog(
    state: &Arc<AppState>,
    github_token: &str,
) -> Result<(String, String), String> {
    let url = format!(
        "https://api.github.com/repos/{UPSTREAM_REPO}/contents/{UPSTREAM_PATH}"
    );
    let response = state
        .http_client
        .get(&url)
        .header("Authorization", format!("Bearer {github_token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "treasury26-nearcom-catalog-watch")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("github fetch failed: {e}"))?;

    let status = response.status();
    let body: GithubContentsResponse = response
        .json()
        .await
        .map_err(|e| format!("github response parse failed: {e}"))?;

    if !status.is_success() {
        return Err(format!(
            "github API {}: {}",
            status,
            body.message.unwrap_or_else(|| "unknown error".to_string())
        ));
    }

    let encoding = body.encoding.as_deref().unwrap_or("base64");
    if encoding != "base64" {
        return Err(format!("unexpected github content encoding: {encoding}"));
    }
    let content = body
        .content
        .ok_or_else(|| "github contents response missing content".to_string())?
        .replace('\n', "");
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(content.as_bytes())
        .map_err(|e| format!("base64 decode failed: {e}"))?;
    let json = String::from_utf8(decoded).map_err(|e| format!("utf8 decode failed: {e}"))?;
    Ok((body.sha, json))
}

async fn load_last_sha(pool: &sqlx::PgPool) -> Result<Option<String>, sqlx::Error> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT upstream_sha FROM nearcom_catalog_watch_state WHERE id = 1")
            .fetch_optional(pool)
            .await?;
    Ok(row.and_then(|(sha,)| sha))
}

async fn persist_state(
    pool: &sqlx::PgPool,
    sha: Option<&str>,
    notified: bool,
    error: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE nearcom_catalog_watch_state
        SET upstream_sha = COALESCE($1, upstream_sha),
            last_notified_at = CASE WHEN $2 THEN NOW() ELSE last_notified_at END,
            last_checked_at = NOW(),
            last_error = $3
        WHERE id = 1
        "#,
    )
    .bind(sha)
    .bind(notified)
    .bind(error)
    .execute(pool)
    .await?;
    Ok(())
}

/// One watch cycle. Returns a human-readable summary for the job board.
pub async fn run_nearcom_catalog_watch_cycle(
    state: &Arc<AppState>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let Some(token) = state.env_vars.nearcom_catalog_github_token.as_deref() else {
        return Ok("NEARCOM_CATALOG_GITHUB_TOKEN unset — skipped".to_string());
    };

    let (sha, upstream_json) = match fetch_upstream_catalog(state, token).await {
        Ok(v) => v,
        Err(err) => {
            let _ = persist_state(&state.db_pool, None, false, Some(&err)).await;
            let alert = format!(
                "<b>near.com catalog watch auth/fetch failed</b>\n<code>{}</code>\nSilence is not \"no changes\".",
                html_escape(&err)
            );
            let _ = state.telegram_client.send_ops_alert_html(&alert).await;
            return Err(err.into());
        }
    };

    let last_sha = load_last_sha(&state.db_pool).await?;
    if last_sha.as_deref() == Some(sha.as_str()) {
        persist_state(&state.db_pool, Some(&sha), false, None).await?;
        return Ok(format!("unchanged sha={}", &sha[..sha.len().min(12)]));
    }

    let diff = diff_catalogs(VENDORED_CATALOG, &upstream_json)?;
    if diff.is_empty() {
        // Upstream moved but catalog content matches vendored — record sha, no ping.
        persist_state(&state.db_pool, Some(&sha), false, None).await?;
        return Ok(format!(
            "sha advanced but no catalog delta ({})",
            &sha[..sha.len().min(12)]
        ));
    }

    let message = diff.telegram_html(&sha);
    state.telegram_client.send_ops_alert_html(&message).await?;
    persist_state(&state.db_pool, Some(&sha), true, None).await?;

    Ok(format!(
        "notified +{} -{} ~{} sha={}",
        diff.added.len(),
        diff.removed.len(),
        diff.updated.len(),
        &sha[..sha.len().min(12)]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_detects_add_remove_update() {
        let vendored = r#"{
          "tokens": [
            {
              "defuseAssetId": "nep141:a.near",
              "symbol": "A",
              "originChainName": "near",
              "deployments": [{"address":"a.near","decimals":24,"chainName":"near","bridge":"direct"}]
            },
            {
              "defuseAssetId": "nep141:b.near",
              "symbol": "B",
              "originChainName": "near",
              "deployments": [{"address":"b.near","decimals":24,"chainName":"near","bridge":"direct"}]
            }
          ]
        }"#;
        let upstream = r#"{
          "tokens": [
            {
              "defuseAssetId": "nep141:b.near",
              "symbol": "B",
              "originChainName": "near",
              "deployments": [{"address":"b.near","decimals":24,"chainName":"near","bridge":"poa"}]
            },
            {
              "defuseAssetId": "1cs_v1:sol:spl:Abc",
              "symbol": "ZEC",
              "originChainName": "solana",
              "deployments": [{"address":"Abc","decimals":8,"chainName":"solana","bridge":"near_omni"}]
            }
          ]
        }"#;
        let diff = diff_catalogs(vendored, upstream).expect("diff");
        assert_eq!(diff.added.len(), 1);
        assert_eq!(diff.added[0].0, "1cs_v1:sol:spl:Abc");
        assert_eq!(diff.removed.len(), 1);
        assert_eq!(diff.removed[0].0, "nep141:a.near");
        assert_eq!(diff.updated.len(), 1);
        assert_eq!(diff.updated[0].0, "nep141:b.near");
        assert_eq!(diff.updated[0].2.bridge, "poa");
    }
}
