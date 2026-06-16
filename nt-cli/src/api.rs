use crate::config::TrezuConfig;
use crate::types::*;
use color_eyre::eyre::{Result, WrapErr, eyre};

pub struct ApiClient {
    client: reqwest::blocking::Client,
    base_url: String,
    auth_token: Option<String>,
}

impl ApiClient {
    pub fn new(config: &TrezuConfig) -> Self {
        Self {
            client: reqwest::blocking::Client::builder()
                .cookie_store(true)
                .build()
                .expect("Failed to create HTTP client"),
            base_url: config.api_base.clone(),
            auth_token: config.auth_token.clone(),
        }
    }

    fn url(&self, path: &str) -> String {
        let base_url = self.base_url.trim_end_matches('/');
        let path = path.trim_start_matches('/');
        format!("{}/api/{}", base_url, path)
    }

    fn get(&self, path: &str) -> reqwest::blocking::RequestBuilder {
        let mut req = self.client.get(self.url(path));
        if let Some(token) = &self.auth_token {
            req = req.header("Cookie", format!("auth_token={}", token));
        }
        req
    }

    fn post(&self, path: &str) -> reqwest::blocking::RequestBuilder {
        let mut req = self.client.post(self.url(path));
        if let Some(token) = &self.auth_token {
            req = req.header("Cookie", format!("auth_token={}", token));
        }
        req
    }

    fn delete(&self, path: &str) -> reqwest::blocking::RequestBuilder {
        let mut req = self.client.delete(self.url(path));
        if let Some(token) = &self.auth_token {
            req = req.header("Cookie", format!("auth_token={}", token));
        }
        req
    }

    #[tracing::instrument(name = "Getting auth challenge ...", skip_all)]
    pub fn get_challenge(&self) -> Result<ChallengeResponse> {
        let resp = self
            .post("/auth/challenge")
            .send()
            .wrap_err("Failed to get auth challenge")?;
        if !resp.status().is_success() {
            return Err(eyre!("Challenge request failed: {}", resp.status()));
        }
        resp.json().wrap_err("Failed to parse challenge response")
    }

    #[tracing::instrument(name = "Logging in ...", skip_all)]
    pub fn login(&self, request: &LoginRequest) -> Result<(MeResponse, String)> {
        let resp = self
            .client
            .post(self.url("/auth/login"))
            .json(request)
            .send()
            .wrap_err("Failed to send login request")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(eyre!("Login failed ({}): {}", status, body));
        }

        let token = resp
            .headers()
            .get_all("set-cookie")
            .iter()
            .find_map(|v| {
                let s = v.to_str().ok()?;
                if s.starts_with("auth_token=") {
                    Some(
                        s.split(';')
                            .next()?
                            .trim_start_matches("auth_token=")
                            .to_string(),
                    )
                } else {
                    None
                }
            })
            .ok_or_else(|| eyre!("No auth token in login response"))?;

        let me: MeResponse = resp.json().wrap_err("Failed to parse login response")?;
        Ok((me, token))
    }

    #[tracing::instrument(name = "Getting user info ...", skip_all)]
    pub fn get_me(&self) -> Result<MeResponse> {
        let resp = self
            .get("/auth/me")
            .send()
            .wrap_err("Failed to check auth status")?;
        if !resp.status().is_success() {
            return Err(eyre!("Not authenticated ({})", resp.status()));
        }
        resp.json().wrap_err("Failed to parse /me response")
    }

    #[tracing::instrument(name = "Logging out ...", skip_all)]
    pub fn logout(&self) -> Result<()> {
        let resp = self
            .post("/auth/logout")
            .send()
            .wrap_err("Failed to logout")?;
        if !resp.status().is_success() {
            return Err(eyre!("Logout failed: {}", resp.status()));
        }
        Ok(())
    }

    #[tracing::instrument(name = "Accepting terms of service ...", skip_all)]
    pub fn accept_terms(&self) -> Result<()> {
        let resp = self
            .post("/auth/accept-terms")
            .send()
            .wrap_err("Failed to accept terms")?;
        if !resp.status().is_success() {
            return Err(eyre!("Accept terms failed: {}", resp.status()));
        }
        Ok(())
    }

    #[tracing::instrument(name = "Fetching treasuries ...", skip_all)]
    pub fn list_treasuries(&self, account_id: &str) -> Result<Vec<Treasury>> {
        let resp = self
            .get("/user/treasuries")
            .query(&[("accountId", account_id)])
            .send()
            .wrap_err("Failed to list treasuries")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(eyre!("List treasuries failed ({}): {}", status, body));
        }
        resp.json().wrap_err("Failed to parse treasuries response")
    }

    #[tracing::instrument(name = "Fetching treasury config ...", skip_all)]
    pub fn get_treasury_config(&self, treasury_id: &str) -> Result<TreasuryConfig> {
        let resp = self
            .get("/treasury/config")
            .query(&[("treasuryId", treasury_id)])
            .send()
            .wrap_err("Failed to get treasury config")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(eyre!("Get treasury config failed ({}): {}", status, body));
        }
        resp.json()
            .wrap_err("Failed to parse treasury config response")
    }

    #[tracing::instrument(name = "Fetching treasury policy ...", skip_all)]
    pub fn get_treasury_policy(&self, treasury_id: &str) -> Result<Policy> {
        let resp = self
            .get("/treasury/policy")
            .query(&[("treasuryId", treasury_id)])
            .send()
            .wrap_err("Failed to get treasury policy")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(eyre!("Get treasury policy failed ({}): {}", status, body));
        }
        resp.json()
            .wrap_err("Failed to parse treasury policy response")
    }

    #[tracing::instrument(name = "Fetching assets ...", skip_all)]
    pub fn get_assets(&self, account_id: &str) -> Result<Vec<SimplifiedToken>> {
        let resp = self
            .get("/user/assets")
            .query(&[("accountId", account_id)])
            .send()
            .wrap_err("Failed to get assets")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(eyre!("Get assets failed ({}): {}", status, body));
        }
        resp.json().wrap_err("Failed to parse assets response")
    }

    #[tracing::instrument(name = "Listing proposals ...", skip_all)]
    pub fn list_proposals(
        &self,
        dao_id: &str,
        status: Option<&str>,
        page: Option<usize>,
        page_size: Option<usize>,
    ) -> Result<PaginatedProposals> {
        let mut req = self.get(&format!("/proposals/{}", dao_id));
        if let Some(s) = status {
            req = req.query(&[("statuses", s)]);
        }
        if let Some(p) = page {
            req = req.query(&[("page", &p.to_string())]);
        }
        if let Some(ps) = page_size {
            req = req.query(&[("pageSize", &ps.to_string())]);
        }
        let resp = req.send().wrap_err("Failed to list proposals")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(eyre!("List proposals failed ({}): {}", status, body));
        }
        resp.json().wrap_err("Failed to parse proposals response")
    }

    #[tracing::instrument(name = "Fetching proposal ...", skip_all)]
    pub fn get_proposal(&self, dao_id: &str, proposal_id: u64) -> Result<Proposal> {
        let resp = self
            .get(&format!("/proposal/{}/{}", dao_id, proposal_id))
            .send()
            .wrap_err("Failed to get proposal")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(eyre!("Get proposal failed ({}): {}", status, body));
        }
        resp.json().wrap_err("Failed to parse proposal response")
    }

    #[tracing::instrument(name = "Fetching address book ...", skip_all)]
    pub fn list_address_book(&self, dao_id: &str) -> Result<Vec<AddressBookEntry>> {
        let resp = self
            .get("/address-book")
            .query(&[("daoId", dao_id)])
            .send()
            .wrap_err("Failed to list address book")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(eyre!("List address book failed ({}): {}", status, body));
        }
        resp.json()
            .wrap_err("Failed to parse address book response")
    }

    #[tracing::instrument(name = "Adding address book entry ...", skip_all)]
    pub fn create_address_book_entries(
        &self,
        dao_id: &str,
        entries: Vec<CreateAddressBookEntryRequest>,
    ) -> Result<()> {
        let body = serde_json::json!({
            "daoId": dao_id,
            "entries": entries,
        });
        let resp = self
            .post("/address-book")
            .json(&body)
            .send()
            .wrap_err("Failed to create address book entries")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(eyre!(
                "Create address book entries failed ({}): {}",
                status,
                body
            ));
        }
        Ok(())
    }

    #[tracing::instrument(name = "Removing address book entry ...", skip_all)]
    pub fn delete_address_book_entries(&self, ids: Vec<uuid::Uuid>) -> Result<()> {
        let body = serde_json::json!({ "ids": ids });
        let resp = self
            .delete("/address-book")
            .json(&body)
            .send()
            .wrap_err("Failed to delete address book entries")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(eyre!(
                "Delete address book entries failed ({}): {}",
                status,
                body
            ));
        }
        Ok(())
    }

    #[tracing::instrument(name = "Fetching recent activity ...", skip_all)]
    pub fn get_recent_activity(
        &self,
        account_id: &str,
        limit: Option<usize>,
    ) -> Result<Vec<BalanceChange>> {
        use crate::types::RecentActivityResponse;
        let mut req = self
            .get("/recent-activity")
            .query(&[("accountId", account_id)]);
        if let Some(l) = limit {
            req = req.query(&[("limit", &l.to_string())]);
        }
        let resp = req.send().wrap_err("Failed to get recent activity")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(eyre!("Get recent activity failed ({}): {}", status, body));
        }
        let wrapper: RecentActivityResponse = resp
            .json()
            .wrap_err("Failed to parse recent activity response")?;
        Ok(wrapper.data)
    }

    #[tracing::instrument(name = "Fetching bridge networks ...", skip_all)]
    pub fn get_bridge_tokens(&self) -> Result<BridgeAssetsResponse> {
        tracing::info!(
            target: "near_teach_me",
            parent: &tracing::Span::none(),
            "I am making HTTP GET {} to discover which assets/networks the 1Click bridge supports",
            self.url("/intents/bridge-tokens")
        );
        let resp = self
            .get("/intents/bridge-tokens")
            .send()
            .wrap_err("Failed to get bridge tokens")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(eyre!("Get bridge tokens failed ({}): {}", status, body));
        }
        resp.json().wrap_err("Failed to parse bridge tokens")
    }

    #[tracing::instrument(name = "Getting intents quote ...", skip_all)]
    pub fn get_intents_quote(&self, request: &serde_json::Value) -> Result<serde_json::Value> {
        tracing::info!(
            target: "near_teach_me",
            parent: &tracing::Span::none(),
            "I am making HTTP POST {} (proxied to 1Click /v0/quote) with body:\n{}",
            self.url("/intents/quote"),
            serde_json::to_string_pretty(request).unwrap_or_default()
        );
        let resp = self
            .post("/intents/quote")
            .json(request)
            .send()
            .wrap_err("Failed to get intents quote")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(eyre!("Get intents quote failed ({}): {}", status, body));
        }
        let quote: serde_json::Value = resp
            .json()
            .wrap_err("Failed to parse intents quote response")?;
        tracing::info!(
            target: "near_teach_me",
            parent: &tracing::Span::none(),
            "1Click quote response:\n{}",
            serde_json::to_string_pretty(&quote).unwrap_or_default()
        );
        Ok(quote)
    }

    #[tracing::instrument(name = "Generating intent ...", skip_all)]
    pub fn generate_intent(&self, request: &serde_json::Value) -> Result<serde_json::Value> {
        tracing::info!(
            target: "near_teach_me",
            parent: &tracing::Span::none(),
            "I am making HTTP POST {} — the backend stores this intent (keyed by its NEP-413 \
             payload hash) and will auto-submit it to 1Click once the proposal is approved \
             and the MPC signature appears in the vote execution result. Body:\n{}",
            self.url("/confidential-intents/generate-intent"),
            serde_json::to_string_pretty(request).unwrap_or_default()
        );
        let resp = self
            .post("/confidential-intents/generate-intent")
            .json(request)
            .send()
            .wrap_err("Failed to generate intent")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(eyre!("Generate intent failed ({}): {}", status, body));
        }
        let intent: serde_json::Value = resp
            .json()
            .wrap_err("Failed to parse generate intent response")?;
        tracing::info!(
            target: "near_teach_me",
            parent: &tracing::Span::none(),
            "generate-intent response:\n{}",
            serde_json::to_string_pretty(&intent).unwrap_or_default()
        );
        Ok(intent)
    }

    #[tracing::instrument(name = "Relaying delegate action ...", skip_all)]
    pub fn relay_delegate_action(&self, body: &serde_json::Value) -> Result<serde_json::Value> {
        tracing::info!(
            target: "near_teach_me",
            parent: &tracing::Span::none(),
            "I am making HTTP POST {} with proposalType={} — the backend sponsors gas, executes \
             the delegate action on-chain, and (for confidential votes) extracts the MPC \
             signature from the execution result to auto-submit the pending intent",
            self.url("/relay/delegate-action"),
            body.get("proposalType")
                .and_then(|v| v.as_str())
                .unwrap_or("<none>")
        );
        let resp = self
            .post("/relay/delegate-action")
            .json(body)
            .send()
            .wrap_err("Failed to relay delegate action")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().unwrap_or_default();
            return Err(eyre!("Relay failed ({}): {}", status, text));
        }
        let result: serde_json::Value = resp.json().wrap_err("Failed to parse relay response")?;
        tracing::info!(
            target: "near_teach_me",
            parent: &tracing::Span::none(),
            "Relay response:\n{}",
            serde_json::to_string_pretty(&result).unwrap_or_default()
        );
        Ok(result)
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CreateAddressBookEntryRequest {
    pub name: String,
    pub networks: Vec<String>,
    pub address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}
