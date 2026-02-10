use near_api::NetworkConfig;
use near_jsonrpc_client::{JsonRpcClient, auth};
use serde::{Deserialize, Serialize};
use std::error::Error;

/// Create a JSON-RPC client from network config
pub fn create_rpc_client(
    network: &NetworkConfig,
) -> Result<JsonRpcClient, Box<dyn Error + Send + Sync>> {
    let rpc_endpoint = network
        .rpc_endpoints
        .first()
        .ok_or("No RPC endpoint configured")?;

    let mut client = JsonRpcClient::connect(rpc_endpoint.url.as_str());

    if let Some(bearer) = &rpc_endpoint.bearer_header {
        let token = bearer.strip_prefix("Bearer ").unwrap_or(bearer);
        client = client.header(auth::Authorization::bearer(token)?);
    }

    Ok(client)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct JsonRpcRequest<T = serde_json::Value> {
    pub id: String,
    pub jsonrpc: String,
    pub method: String,
    pub params: Vec<T>,
}

impl<T> JsonRpcRequest<T> {
    pub fn new(id: impl Into<String>, method: impl Into<String>, params: Vec<T>) -> Self {
        Self {
            id: id.into(),
            jsonrpc: "2.0".to_string(),
            method: method.into(),
            params,
        }
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct JsonRpcResponse<T> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct JsonRpcError {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}
