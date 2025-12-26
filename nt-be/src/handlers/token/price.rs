use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;

#[derive(Deserialize)]
pub struct TokenPriceQuery {
    #[serde(rename = "tokenId")]
    pub token_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TokenPriceResponse {
    pub token_id: String,
    pub price: f64,
    pub source: String,
}

#[derive(Deserialize)]
struct CoinGeckoResponse {
    near: Option<CoinGeckoPrice>,
}

#[derive(Deserialize)]
struct CoinGeckoPrice {
    usd: Option<f64>,
}

#[derive(Deserialize)]
struct BinanceResponse {
    price: String,
}

#[derive(Deserialize)]
struct CryptoCompareResponse {
    #[serde(rename = "USD")]
    usd: Option<f64>,
}

#[derive(Deserialize)]
struct NearBlocksTokenResponse {
    contracts: Vec<NearBlocksContract>,
}

#[derive(Deserialize)]
struct NearBlocksContract {
    price: Option<String>,
}

/// Fetch NEAR token price from multiple sources with fallback
async fn fetch_near_price(http_client: &reqwest::Client) -> Result<(f64, String), String> {
    // Try CoinGecko first
    if let Ok(response) = http_client
        .get("https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd")
        .send()
        .await
        && let Ok(data) = response.json::<CoinGeckoResponse>().await
        && let Some(price) = data.near.and_then(|n| n.usd)
    {
        println!("✓ NEAR price from CoinGecko: ${}", price);
        return Ok((price, "coingecko".to_string()));
    }

    // Try Binance as fallback
    if let Ok(response) = http_client
        .get("https://api.binance.com/api/v3/ticker/price?symbol=NEARUSDT")
        .send()
        .await
        && let Ok(data) = response.json::<BinanceResponse>().await
        && let Ok(price) = data.price.parse::<f64>()
    {
        println!("✓ NEAR price from Binance: ${}", price);
        return Ok((price, "binance".to_string()));
    }

    // Try CryptoCompare as last fallback
    if let Ok(response) = http_client
        .get("https://min-api.cryptocompare.com/data/price?fsym=NEAR&tsyms=USD")
        .send()
        .await
        && let Ok(data) = response.json::<CryptoCompareResponse>().await
        && let Some(price) = data.usd
    {
        println!("✓ NEAR price from CryptoCompare: ${}", price);
        return Ok((price, "cryptocompare".to_string()));
    }

    Err("Failed to fetch NEAR price from all sources".to_string())
}

/// Fetch FT token price from Nearblocks
async fn fetch_ft_price(
    http_client: &reqwest::Client,
    token_id: &str,
) -> Result<(f64, String), String> {
    let url = format!("https://api.nearblocks.io/v1/fts/{}", token_id);

    match http_client.get(&url).send().await {
        Ok(response) => {
            if let Ok(data) = response.json::<NearBlocksTokenResponse>().await
                && let Some(contract) = data.contracts.first()
                && let Some(price_str) = &contract.price
                && let Ok(price) = price_str.parse::<f64>()
            {
                println!("✓ Token {} price from Nearblocks: ${}", token_id, price);
                return Ok((price, "nearblocks".to_string()));
            }
            Err(format!("No price data found for token {}", token_id))
        }
        Err(e) => Err(format!("Failed to fetch token price: {}", e)),
    }
}

/// Main handler for token price endpoint
pub async fn get_token_price(
    State(state): State<Arc<AppState>>,
    Query(params): Query<TokenPriceQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let token_id = params.token_id.trim();

    // Check cache first
    let cache_key = format!("token-price:{}", token_id);
    if let Some(cached_data) = state.cache.get(&cache_key).await {
        println!("🔁 Returning cached price for {}", token_id);
        return Ok((StatusCode::OK, Json(cached_data)));
    }

    // Determine if it's NEAR or FT token
    let is_near = token_id == "near" || token_id == "NEAR" || token_id == "wrap.near";

    let (price, source) = if is_near {
        fetch_near_price(&state.http_client).await.map_err(|e| {
            eprintln!("Error fetching NEAR price: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, e)
        })?
    } else {
        fetch_ft_price(&state.http_client, token_id)
            .await
            .map_err(|e| {
                eprintln!("Error fetching token price for {}: {}", token_id, e);
                (StatusCode::NOT_FOUND, e)
            })?
    };

    let response = TokenPriceResponse {
        token_id: token_id.to_string(),
        price,
        source,
    };

    let result_value = serde_json::to_value(&response).map_err(|e| {
        eprintln!("Error serializing token price: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to serialize token price".to_string(),
        )
    })?;

    // Cache for 60 seconds (prices change frequently)
    state.cache.insert(cache_key, result_value.clone()).await;

    Ok((StatusCode::OK, Json(result_value)))
}

/// Batch endpoint to fetch multiple token prices at once
#[derive(Deserialize)]
pub struct BatchTokenPriceQuery {
    #[serde(rename = "tokenIds")]
    pub token_ids: String, // Comma-separated token IDs
}

pub async fn get_batch_token_prices(
    State(state): State<Arc<AppState>>,
    Query(params): Query<BatchTokenPriceQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let token_ids: Vec<&str> = params.token_ids.split(',').map(|s| s.trim()).collect();

    if token_ids.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "No token IDs provided".to_string()));
    }

    let mut futures = Vec::new();

    for token_id in token_ids {
        let state_clone = state.clone();
        let token_id_owned = token_id.to_string();

        futures.push(async move {
            let cache_key = format!("token-price:{}", token_id_owned);

            // Check cache first
            if let Some(cached_data) = state_clone.cache.get(&cache_key).await {
                return serde_json::from_value::<TokenPriceResponse>(cached_data).ok();
            }

            let is_near = token_id_owned == "near"
                || token_id_owned == "NEAR"
                || token_id_owned == "wrap.near";

            let result = if is_near {
                fetch_near_price(&state_clone.http_client).await
            } else {
                fetch_ft_price(&state_clone.http_client, &token_id_owned).await
            };

            match result {
                Ok((price, source)) => {
                    let response = TokenPriceResponse {
                        token_id: token_id_owned.clone(),
                        price,
                        source,
                    };

                    if let Ok(value) = serde_json::to_value(&response) {
                        state_clone.cache.insert(cache_key, value).await;
                    }

                    Some(response)
                }
                Err(e) => {
                    eprintln!("Error fetching price for {}: {}", token_id_owned, e);
                    None
                }
            }
        });
    }

    let results = futures::future::join_all(futures).await;
    let prices: Vec<TokenPriceResponse> = results.into_iter().flatten().collect();

    Ok((StatusCode::OK, Json(prices)))
}
