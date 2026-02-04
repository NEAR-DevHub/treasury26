use reqwest::Client;
use serde::{Deserialize, Serialize};

/// Asset specification for checkout session
#[derive(Serialize, Clone, Debug)]
pub struct Asset {
    pub chain: String,
    pub symbol: String,
}

impl Default for Asset {
    fn default() -> Self {
        Self {
            chain: "NEAR".to_string(),
            symbol: "USDC".to_string(),
        }
    }
}

/// Request to create a checkout session
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateCheckoutSessionRequest {
    /// Amount in smallest units (6 decimals for USDC: "150000000" = 150 USDC)
    pub amount: String,

    /// Asset to receive (default: NEAR/USDC)
    pub asset: Asset,

    /// URL to redirect on successful payment
    pub success_url: String,

    /// URL to redirect on cancelled payment
    pub cancel_url: String,

    /// Optional metadata for tracking (treasury_id, plan_id, etc.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// Amount details in checkout response
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AmountDetails {
    pub asset_id: Option<String>,
    pub amount: String,
    pub decimals: Option<u8>,
}

/// Recipient details in checkout response
#[derive(Deserialize, Clone, Debug)]
pub struct RecipientDetails {
    pub address: String,
}

/// Session details in checkout response
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetails {
    pub session_id: String,
    pub status: String,
    pub amount: AmountDetails,
    pub recipient: RecipientDetails,
    #[serde(default)]
    pub payment_id: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub expires_at: Option<String>,
}

/// Response from creating a checkout session
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutSessionResponse {
    pub session: SessionDetails,
    pub session_url: String,
}

/// PingPay API client
pub struct PingPayClient {
    http_client: Client,
    api_url: String,
    api_key: Option<String>,
}

impl PingPayClient {
    /// Create a new PingPay client
    pub fn new(http_client: Client, api_url: String, api_key: Option<String>) -> Self {
        Self {
            http_client,
            api_url,
            api_key,
        }
    }

    /// Create a checkout session for payment
    ///
    /// # Arguments
    /// * `request` - The checkout session request details
    ///
    /// # Returns
    /// * `Ok(CheckoutSessionResponse)` - Session details including the URL to redirect user
    /// * `Err(String)` - Error message if the API call fails
    pub async fn create_checkout_session(
        &self,
        request: CreateCheckoutSessionRequest,
    ) -> Result<CheckoutSessionResponse, String> {
        let api_key = self
            .api_key
            .as_ref()
            .ok_or_else(|| "Missing PingPay API key".to_string())?;

        let url = format!("{}/checkout/sessions", self.api_url);

        log::info!(
            "Creating PingPay checkout session: amount={}, asset={}/{}",
            request.amount,
            request.asset.chain,
            request.asset.symbol
        );

        let response = self
            .http_client
            .post(&url)
            .header("x-api-key", api_key)
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .map_err(|e| format!("HTTP request failed: {}", e))?;

        let status = response.status();

        if !status.is_success() {
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());

            log::error!(
                "PingPay API error: status={}, body={}",
                status.as_u16(),
                error_text
            );

            return Err(format!("PingPay API error {}: {}", status.as_u16(), error_text));
        }

        let checkout_response: CheckoutSessionResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        log::info!(
            "Created PingPay checkout session: session_id={}, url={}",
            checkout_response.session.session_id,
            checkout_response.session_url
        );

        Ok(checkout_response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_checkout_request_serialization() {
        let request = CreateCheckoutSessionRequest {
            amount: "150000000".to_string(), // 150 USDC
            asset: Asset::default(),
            success_url: "https://example.com/success".to_string(),
            cancel_url: "https://example.com/cancel".to_string(),
            metadata: Some(serde_json::json!({
                "treasury_id": "test.sputnik-dao.near",
                "plan_id": "12m",
                "subscription_id": "123"
            })),
        };

        let json = serde_json::to_string_pretty(&request).unwrap();
        println!("Request JSON:\n{}", json);

        // Verify camelCase serialization
        assert!(json.contains("successUrl"));
        assert!(json.contains("cancelUrl"));
        assert!(!json.contains("success_url"));
    }

    #[test]
    fn test_checkout_response_deserialization() {
        let json = r#"{
            "session": {
                "sessionId": "cs_KkSF2ZfdK4N7oAzKdri_L",
                "status": "CREATED",
                "paymentId": null,
                "amount": {
                    "assetId": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
                    "amount": "150000000",
                    "decimals": 6
                },
                "recipient": {
                    "address": "trezu.near"
                },
                "createdAt": "2026-02-01T12:00:00Z",
                "expiresAt": "2026-02-01T13:00:00Z"
            },
            "sessionUrl": "https://pay.pingpay.io/checkout?sessionId=cs_KkSF2ZfdK4N7oAzKdri_L"
        }"#;

        let response: CheckoutSessionResponse = serde_json::from_str(json).unwrap();

        assert_eq!(response.session.session_id, "cs_KkSF2ZfdK4N7oAzKdri_L");
        assert_eq!(response.session.status, "CREATED");
        assert_eq!(response.session.amount.amount, "150000000");
        assert_eq!(response.session.recipient.address, "trezu.near");
        assert!(response.session_url.contains("cs_KkSF2ZfdK4N7oAzKdri_L"));
    }
}
