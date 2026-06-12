use std::str::FromStr;

use crate::api::ApiClient;
use crate::config::{TreasuryContext, TrezuContext};
use crate::types::{SimplifiedToken, TokenResidency};
use colored::Colorize;
use strum::{EnumDiscriminants, EnumIter, EnumMessage};

/// Destination network sentinel: direct transfer on the NEAR chain (Transfer
/// proposal kind, no 1Click involved).
const NETWORK_NEAR_DIRECT: &str = "near";
/// Destination network sentinel: the recipient's NEAR Intents (near.com)
/// balance. Funds stay inside intents.near.
const NETWORK_NEAR_COM: &str = "near.com";

/// v1.signer `sign` gas, mirrors nt-fe `V1_SIGNER_GAS` (15 TGas).
const V1_SIGNER_GAS: &str = "15000000000000";
/// ft_transfer / mt_transfer gas, mirrors nt-fe `FT_TRANSFER_GAS` (150 TGas).
const FT_TRANSFER_GAS: &str = "150000000000000";
/// near_deposit gas, mirrors nt-fe `STORAGE_DEPOSIT_GAS` (10 TGas).
const NEAR_DEPOSIT_GAS: &str = "10000000000000";

#[derive(Debug, Clone, interactive_clap::InteractiveClap)]
#[interactive_clap(input_context = TrezuContext)]
#[interactive_clap(output_context = PaymentsTreasuryContext)]
pub struct Payments {
    #[interactive_clap(skip_default_input_arg)]
    /// Treasury (DAO) account ID
    treasury_id: String,
    #[interactive_clap(subcommand)]
    command: PaymentsCommand,
}

impl Payments {
    fn input_treasury_id(context: &TrezuContext) -> color_eyre::eyre::Result<Option<String>> {
        crate::config::input_treasury_id(context)
    }
}

#[derive(Debug, Clone)]
pub struct PaymentsTreasuryContext(TreasuryContext);

impl PaymentsTreasuryContext {
    pub fn from_previous_context(
        previous_context: TrezuContext,
        scope: &<Payments as interactive_clap::ToInteractiveClapContextScope>::InteractiveClapContextScope,
    ) -> color_eyre::eyre::Result<Self> {
        crate::config::touch_treasury(&scope.treasury_id);
        Ok(Self(TreasuryContext {
            config: previous_context.config,
            global_context: previous_context.global_context,
            treasury_id: scope.treasury_id.clone(),
        }))
    }
}

impl From<PaymentsTreasuryContext> for TreasuryContext {
    fn from(item: PaymentsTreasuryContext) -> Self {
        item.0
    }
}

#[derive(Debug, EnumDiscriminants, Clone, interactive_clap::InteractiveClap)]
#[interactive_clap(context = TreasuryContext)]
#[strum_discriminants(derive(EnumMessage, EnumIter))]
/// Select payment action
pub enum PaymentsCommand {
    #[strum_discriminants(strum(message = "send     -   Create a payment proposal"))]
    /// Create a payment proposal
    Send(PaymentSend),
}

#[derive(Debug, Clone, interactive_clap::InteractiveClap)]
#[interactive_clap(input_context = TreasuryContext)]
#[interactive_clap(output_context = PaymentTokenContext)]
pub struct PaymentSend {
    #[interactive_clap(skip_default_input_arg)]
    /// Token to send: a symbol (USDT), symbol@flavor (USDT@intents, USDT@ft, NEAR@near), or a contract id
    token: String,
    #[interactive_clap(named_arg)]
    /// Specify payment details
    details: PaymentDetails,
}

impl PaymentSend {
    fn input_token(context: &TreasuryContext) -> color_eyre::eyre::Result<Option<String>> {
        let api = ApiClient::new(&context.config);
        let assets = api.get_assets(&context.treasury_id)?;
        let sendable: Vec<&SimplifiedToken> = assets.iter().filter(|t| is_sendable(t)).collect();

        if sendable.is_empty() {
            return Err(color_eyre::eyre::eyre!(
                "No transferable assets available in treasury."
            ));
        }

        // The same symbol can appear in several flavors (native NEAR vs NEAR
        // on Intents, NEAR-chain FT vs Intents balance, …) — make each entry
        // distinguishable and return an unambiguous selector, not the symbol.
        let options: Vec<String> = sendable
            .iter()
            .map(|t| {
                let balance = crate::assets::format_balance_human(&t.balance, t.decimals);
                format!(
                    "{} — {} (balance: {})",
                    t.symbol,
                    token_flavor_label(t),
                    balance
                )
            })
            .collect();

        let selection = inquire::Select::new("Select token to send:", options.clone()).prompt()?;
        let index = options.iter().position(|o| o == &selection).unwrap();
        Ok(Some(token_selector(sendable[index], &sendable)))
    }
}

#[derive(Debug, Clone)]
pub struct PaymentTokenContext {
    global_context: near_cli_rs::GlobalContext,
    trezu_config: crate::config::TrezuConfig,
    treasury_id: String,
    signer_id: near_primitives::types::AccountId,
    token: SimplifiedToken,
    policy: crate::types::Policy,
    is_confidential: bool,
}

impl PaymentTokenContext {
    #[tracing::instrument(name = "Loading treasury and token details ...", skip_all)]
    pub fn from_previous_context(
        previous_context: TreasuryContext,
        scope: &<PaymentSend as interactive_clap::ToInteractiveClapContextScope>::InteractiveClapContextScope,
    ) -> color_eyre::eyre::Result<Self> {
        let treasury_id = &previous_context.treasury_id;
        let config = &previous_context.config;

        let account_id = config.account_id.as_deref().ok_or_else(|| {
            color_eyre::eyre::eyre!("Not logged in. Run `trezu auth login` first.")
        })?;

        let signer_id: near_primitives::types::AccountId = account_id
            .parse()
            .map_err(|e| color_eyre::eyre::eyre!("Invalid account ID: {}", e))?;

        let api = ApiClient::new(config);
        let assets = api.get_assets(treasury_id)?;
        let token = resolve_token(&assets, &scope.token)?.clone();

        let policy = api.get_treasury_policy(treasury_id)?;
        let treasury_config = api.get_treasury_config(treasury_id)?;

        tracing::info!(
            target: "near_teach_me",
            parent: &tracing::Span::none(),
            "Treasury {} is {}. Token {}: residency={}, contract_id={:?}, decimals={} → 1Click origin asset {}",
            treasury_id,
            if treasury_config.is_confidential { "CONFIDENTIAL (payments go through MPC-signed private intents)" } else { "public" },
            token.symbol,
            token.residency,
            token.contract_id,
            token.decimals,
            resolve_origin_asset(&token)
                .unwrap_or_else(|_| "<none: NEAR-direct transfers only>".to_string()),
        );

        Ok(Self {
            global_context: previous_context.global_context,
            trezu_config: previous_context.config.clone(),
            treasury_id: treasury_id.to_string(),
            signer_id,
            token,
            policy,
            is_confidential: treasury_config.is_confidential,
        })
    }
}

#[derive(Debug, Clone, interactive_clap::InteractiveClap)]
#[interactive_clap(input_context = PaymentTokenContext)]
#[interactive_clap(output_context = PaymentSendContext)]
pub struct PaymentDetails {
    #[interactive_clap(skip_default_input_arg)]
    /// Amount the recipient should receive (e.g. 0.5, 100)
    amount: String,
    #[interactive_clap(skip_default_input_arg)]
    /// Destination network: "near" (direct transfer), "near.com" (NEAR Intents), or a bridge asset id (e.g. nep141:eth.omft.near)
    destination_network: String,
    /// Recipient address on the destination network
    receiver: String,
    #[interactive_clap(skip_default_input_arg)]
    /// Description/memo for the payment
    description: String,
    #[interactive_clap(named_arg)]
    /// Select network
    network_config: near_cli_rs::network_for_transaction::NetworkForTransactionArgs,
}

impl PaymentDetails {
    fn input_amount(context: &PaymentTokenContext) -> color_eyre::eyre::Result<Option<String>> {
        let amount = inquire::Text::new(&format!(
            "Amount of {} for the recipient to receive:",
            context.token.symbol
        ))
        .with_validator(|input: &str| match validate_amount(input) {
            Ok(()) => Ok(inquire::validator::Validation::Valid),
            Err(msg) => Ok(inquire::validator::Validation::Invalid(msg.into())),
        })
        .prompt()?;
        Ok(Some(amount.trim().to_string()))
    }

    fn input_destination_network(
        context: &PaymentTokenContext,
    ) -> color_eyre::eyre::Result<Option<String>> {
        let token = &context.token;
        let is_near_chain_token = matches!(token.residency, TokenResidency::Near)
            || matches!(token.residency, TokenResidency::Ft);
        let is_intents_token = matches!(token.residency, TokenResidency::Intents);

        let mut ids: Vec<String> = Vec::new();
        let mut labels: Vec<String> = Vec::new();

        if is_near_chain_token {
            ids.push(NETWORK_NEAR_DIRECT.to_string());
            labels.push("NEAR (direct transfer on the NEAR chain)".to_string());
        }
        if is_intents_token || !context.is_confidential {
            ids.push(NETWORK_NEAR_COM.to_string());
            labels.push("near.com (recipient's NEAR Intents balance)".to_string());
        }

        // Cross-chain destinations come from the 1Click bridge catalog: the
        // entry whose networks include this token's origin asset id.
        if let (true, Ok(origin_asset)) = (
            is_intents_token || !context.is_confidential,
            resolve_origin_asset(token),
        ) {
            let api = ApiClient::new(&context.trezu_config);
            match api.get_bridge_tokens() {
                Ok(bridge) => {
                    if let Some(asset) = find_bridge_asset(&bridge.assets, &origin_asset) {
                        tracing::info!(
                            target: "near_teach_me",
                            parent: &tracing::Span::none(),
                            "Bridge asset '{}' matched origin {} with {} destination networks",
                            asset.name,
                            origin_asset,
                            asset.networks.len()
                        );
                        for network in &asset.networks {
                            if normalize_near_asset_id(&network.id)
                                == normalize_near_asset_id(&origin_asset)
                            {
                                continue;
                            }
                            ids.push(network.id.clone());
                            labels.push(format!(
                                "{} — {} ({})",
                                network.name, network.symbol, network.id
                            ));
                        }
                    } else {
                        tracing::info!(
                            "{}",
                            format!(
                                "No bridge networks found for {} — only NEAR destinations available.",
                                token.symbol
                            )
                            .dimmed()
                        );
                    }
                }
                Err(e) => {
                    tracing::warn!("Failed to fetch bridge networks: {e}");
                }
            }
        }

        if ids.is_empty() {
            return Err(color_eyre::eyre::eyre!(
                "No destination networks available for token {}",
                token.symbol
            ));
        }
        if ids.len() == 1 {
            return Ok(Some(ids.remove(0)));
        }

        let selection =
            inquire::Select::new("Select destination network:", labels.clone()).prompt()?;
        let index = labels.iter().position(|l| l == &selection).unwrap();
        Ok(Some(ids.swap_remove(index)))
    }

    fn input_description(
        _context: &PaymentTokenContext,
    ) -> color_eyre::eyre::Result<Option<String>> {
        let desc = inquire::Text::new("Payment description:")
            .with_default("Payment")
            .prompt()?;
        Ok(Some(desc))
    }
}

#[derive(Debug, Clone)]
pub struct PaymentSendContext {
    global_context: near_cli_rs::GlobalContext,
    signer_id: near_primitives::types::AccountId,
    trezu_config: crate::config::TrezuConfig,
    treasury_id: String,
    description: String,
    kind: serde_json::Value,
    deposit: u128,
}

impl PaymentSendContext {
    #[tracing::instrument(name = "Building payment proposal ...", skip_all)]
    pub fn from_previous_context(
        previous_context: PaymentTokenContext,
        scope: &<PaymentDetails as interactive_clap::ToInteractiveClapContextScope>::InteractiveClapContextScope,
    ) -> color_eyre::eyre::Result<Self> {
        let treasury_id = &previous_context.treasury_id;
        let token = &previous_context.token;
        let is_confidential = previous_context.is_confidential;
        let api = ApiClient::new(&previous_context.trezu_config);

        let deposit: u128 = previous_context
            .policy
            .proposal_bond
            .as_deref()
            .unwrap_or("0")
            .parse()
            .unwrap_or(0);

        let destination_network = scope.destination_network.trim();
        let is_direct = destination_network == NETWORK_NEAR_DIRECT;
        let is_near_com = destination_network.is_empty() || destination_network == NETWORK_NEAR_COM;

        tracing::info!(
            "Creating {} payment proposal: {} {} to {} (network: {})",
            if is_confidential {
                "confidential".magenta().to_string()
            } else {
                "public".to_string()
            },
            scope.amount.cyan(),
            token.symbol.cyan(),
            scope.receiver.cyan(),
            if is_direct {
                "NEAR direct"
            } else {
                destination_network
            }
            .cyan(),
        );

        let (description, kind) = if is_direct {
            // Direct on-chain transfer: the DAO's built-in Transfer kind moves
            // funds straight to a NEAR account, no 1Click involved.
            if matches!(token.residency, TokenResidency::Intents) {
                return Err(color_eyre::eyre::eyre!(
                    "Token {} lives on NEAR Intents — direct NEAR transfer is not possible. \
                     Pick near.com or a bridge network instead.",
                    token.symbol
                ));
            }
            let raw_amount = normalize_amount(&scope.amount, &token.symbol, token.decimals)?;
            let token_id = resolve_token_id(token)?;
            tracing::info!(
                target: "near_teach_me",
                parent: &tracing::Span::none(),
                "Direct transfer route: Sputnik `Transfer` proposal kind, token_id='{}', raw amount {} ({} decimals)",
                token_id,
                raw_amount,
                token.decimals
            );
            let kind = serde_json::json!({
                "Transfer": {
                    "token_id": token_id,
                    "receiver_id": scope.receiver,
                    "amount": raw_amount,
                    "msg": serde_json::Value::Null,
                }
            });
            (
                encode_to_markdown(&[("notes", scope.description.as_str())]),
                kind,
            )
        } else {
            // 1Click intents route (near.com or cross-chain).
            let origin_asset = resolve_origin_asset(token)?;
            let (destination_asset, recipient_type, amount_decimals) = if is_near_com {
                (
                    origin_asset.clone(),
                    if is_confidential {
                        "CONFIDENTIAL_INTENTS"
                    } else {
                        "INTENTS"
                    },
                    token.decimals,
                )
            } else {
                // Cross-chain: the destination network id doubles as the
                // destination asset; amounts are scaled with the
                // destination-side decimals (they can differ, e.g. 18 vs 24).
                let bridge = api.get_bridge_tokens()?;
                let network = find_bridge_asset(&bridge.assets, &origin_asset)
                    .and_then(|asset| asset.networks.iter().find(|n| n.id == destination_network))
                    .ok_or_else(|| {
                        color_eyre::eyre::eyre!(
                            "Destination network '{}' is not available for {} (origin {})",
                            destination_network,
                            token.symbol,
                            origin_asset
                        )
                    })?;
                (network.id.clone(), "DESTINATION_CHAIN", network.decimals)
            };

            let deposit_type = if is_confidential {
                "CONFIDENTIAL_INTENTS"
            } else if matches!(token.residency, TokenResidency::Intents) {
                "INTENTS"
            } else {
                "ORIGIN_CHAIN"
            };

            let raw_amount = normalize_amount(&scope.amount, &token.symbol, amount_decimals)?;

            tracing::info!(
                target: "near_teach_me",
                parent: &tracing::Span::none(),
                "Intents route: EXACT_OUTPUT quote (recipient receives exactly the requested amount; \
                 the treasury pays amountIn = amount + 1Click fees). originAsset={}, depositType={}, \
                 destinationAsset={}, recipientType={}, amount={} ({} decimals)",
                origin_asset,
                deposit_type,
                destination_asset,
                recipient_type,
                raw_amount,
                amount_decimals
            );

            let quote = request_quote(
                &api,
                treasury_id,
                &previous_context.policy,
                &origin_asset,
                deposit_type,
                &destination_asset,
                recipient_type,
                &raw_amount,
                &scope.receiver,
            )?;

            if is_confidential {
                build_confidential_proposal(&api, treasury_id, &quote, &scope.description)?
            } else {
                build_public_intents_proposal(
                    token,
                    &origin_asset,
                    &quote,
                    &scope.receiver,
                    destination_network,
                    &scope.description,
                )?
            }
        };

        Ok(Self {
            global_context: previous_context.global_context,
            signer_id: previous_context.signer_id,
            trezu_config: previous_context.trezu_config,
            treasury_id: treasury_id.to_string(),
            description,
            kind,
            deposit,
        })
    }
}

impl From<PaymentSendContext> for near_cli_rs::commands::ActionContext {
    fn from(item: PaymentSendContext) -> Self {
        let treasury_id = item.treasury_id.clone();
        let description = item.description.clone();
        let kind = item.kind.clone();
        let deposit = item.deposit;
        let signer_id = item.signer_id.clone();

        let get_prepopulated_transaction_after_getting_network_callback:
            near_cli_rs::commands::GetPrepopulatedTransactionAfterGettingNetworkCallback =
        {
            std::sync::Arc::new(move |_network_config| {
                let args = serde_json::json!({
                    "proposal": {
                        "description": description,
                        "kind": kind,
                    }
                });
                let args_bytes = serde_json::to_vec(&args)
                    .map_err(|e| color_eyre::eyre::eyre!("Failed to serialize args: {}", e))?;

                let receiver_id: near_primitives::types::AccountId = treasury_id
                    .parse()
                    .map_err(|e| color_eyre::eyre::eyre!("Invalid treasury ID: {}", e))?;

                tracing::info!(
                    target: "near_teach_me",
                    parent: &tracing::Span::none(),
                    "add_proposal args:\n{}",
                    serde_json::to_string_pretty(&args).unwrap_or_default()
                );

                Ok(near_cli_rs::commands::PrepopulatedTransaction {
                    signer_id: signer_id.clone(),
                    receiver_id,
                    actions: vec![near_primitives::transaction::Action::FunctionCall(
                        Box::new(near_primitives::action::FunctionCallAction {
                            method_name: "add_proposal".to_string(),
                            args: args_bytes,
                            gas: near_primitives::types::Gas::from_teragas(270),
                            deposit: near_token::NearToken::from_yoctonear(deposit),
                        }),
                    )],
                })
            })
        };

        Self {
            global_context: item.global_context,
            interacting_with_account_ids: vec![item.signer_id],
            get_prepopulated_transaction_after_getting_network_callback,
            on_before_signing_callback: std::sync::Arc::new(
                |_unsigned_transaction, _network_config| Ok(()),
            ),
            on_before_sending_transaction_callback: std::sync::Arc::new(
                |_signed_transaction, _network_config| Ok(String::new()),
            ),
            on_after_sending_transaction_callback: std::sync::Arc::new(
                |_outcome, _network_config| Ok(()),
            ),
            sign_as_delegate_action: true,
            on_sending_delegate_action_callback: Some(crate::relay::build_relay_callback(
                item.trezu_config,
                item.treasury_id,
                Some("payment".to_string()),
                None,
            )),
        }
    }
}

/// Only liquid balances can be sent as payments; lockup/staked rows cannot.
fn is_sendable(token: &SimplifiedToken) -> bool {
    matches!(
        token.residency,
        TokenResidency::Near | TokenResidency::Ft | TokenResidency::Intents
    )
}

/// Short residency tag used in `SYMBOL@flavor` selectors.
fn residency_tag(residency: &TokenResidency) -> &'static str {
    match residency {
        TokenResidency::Near => "near",
        TokenResidency::Ft => "ft",
        TokenResidency::Intents => "intents",
        TokenResidency::Lockup => "lockup",
        TokenResidency::Staked => "staked",
    }
}

/// Human-readable flavor for the token selection list.
fn token_flavor_label(token: &SimplifiedToken) -> String {
    match token.residency {
        TokenResidency::Near => "native, on NEAR".to_string(),
        TokenResidency::Ft => format!(
            "on NEAR{}",
            token
                .contract_id
                .as_deref()
                .map(|c| format!(", {c}"))
                .unwrap_or_default()
        ),
        TokenResidency::Intents => format!(
            "on Intents{}",
            token
                .contract_id
                .as_deref()
                .map(|c| format!(", {c}"))
                .unwrap_or_default()
        ),
        TokenResidency::Lockup => "lockup".to_string(),
        TokenResidency::Staked => "staked".to_string(),
    }
}

/// Shortest unambiguous CLI selector for a token among its siblings:
/// plain symbol when unique, `SYMBOL@flavor` when the symbol repeats across
/// residencies, the contract id as a last resort.
fn token_selector(token: &SimplifiedToken, all: &[&SimplifiedToken]) -> String {
    let same_symbol = all
        .iter()
        .filter(|t| t.symbol.eq_ignore_ascii_case(&token.symbol))
        .count();
    if same_symbol <= 1 {
        return token.symbol.clone();
    }
    let same_flavor = all
        .iter()
        .filter(|t| t.symbol.eq_ignore_ascii_case(&token.symbol) && t.residency == token.residency)
        .count();
    if same_flavor <= 1 {
        return format!("{}@{}", token.symbol, residency_tag(&token.residency));
    }
    token
        .contract_id
        .clone()
        .unwrap_or_else(|| format!("{}@{}", token.symbol, residency_tag(&token.residency)))
}

/// Resolve a user-supplied token query against the treasury assets.
///
/// Accepted forms, in priority order:
/// 1. contract id, with or without the `nep141:` prefix (always unambiguous)
/// 2. `SYMBOL@flavor` where flavor is `near` | `ft` | `intents`
/// 3. plain symbol — only when the treasury holds a single flavor of it
fn resolve_token<'a>(
    assets: &'a [SimplifiedToken],
    query: &str,
) -> color_eyre::eyre::Result<&'a SimplifiedToken> {
    let sendable: Vec<&SimplifiedToken> = assets.iter().filter(|t| is_sendable(t)).collect();
    let query = query.trim();

    let available = || {
        sendable
            .iter()
            .map(|t| token_selector(t, &sendable))
            .collect::<Vec<_>>()
            .join(", ")
    };

    if sendable.is_empty() {
        return Err(color_eyre::eyre::eyre!(
            "No transferable assets available in treasury."
        ));
    }

    // 1. Contract id match. The same contract can back several flavors (a
    // NEAR-chain FT row and an Intents row), so demand uniqueness here too.
    let normalized_query = normalize_near_asset_id(query);
    let contract_matches: Vec<&&SimplifiedToken> = sendable
        .iter()
        .filter(|t| {
            t.contract_id
                .as_deref()
                .is_some_and(|c| normalize_near_asset_id(c) == normalized_query)
        })
        .collect();
    match contract_matches.as_slice() {
        [token] => return Ok(token),
        [] => {}
        _ => {
            return Err(color_eyre::eyre::eyre!(
                "Contract '{}' matches several token flavors — specify one of: {}",
                query,
                contract_matches
                    .iter()
                    .map(|t| token_selector(t, &sendable))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }

    // 2. SYMBOL@flavor match.
    if let Some((symbol, flavor)) = query.split_once('@') {
        let flavor = flavor.to_ascii_lowercase();
        let matches: Vec<&&SimplifiedToken> = sendable
            .iter()
            .filter(|t| {
                t.symbol.eq_ignore_ascii_case(symbol) && residency_tag(&t.residency) == flavor
            })
            .collect();
        return match matches.as_slice() {
            [token] => Ok(token),
            [] => Err(color_eyre::eyre::eyre!(
                "Token '{}' not found in treasury. Available: {}",
                query,
                available()
            )),
            _ => Err(color_eyre::eyre::eyre!(
                "Token '{}' is ambiguous — use a contract id instead. Available: {}",
                query,
                available()
            )),
        };
    }

    // 3. Plain symbol — must be unique.
    let matches: Vec<&&SimplifiedToken> = sendable
        .iter()
        .filter(|t| t.symbol.eq_ignore_ascii_case(query))
        .collect();
    match matches.as_slice() {
        [token] => Ok(token),
        [] => Err(color_eyre::eyre::eyre!(
            "Token '{}' not found in treasury. Available: {}",
            query,
            available()
        )),
        _ => Err(color_eyre::eyre::eyre!(
            "Treasury holds {} flavors of '{}' — specify which one: {}",
            matches.len(),
            query,
            matches
                .iter()
                .map(|t| token_selector(t, &sendable))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// Map a treasury token to its 1Click intents origin asset id, mirrors
/// nt-fe `classifyPaymentToken().intentsOriginAsset`. Native NEAR is keyed
/// off residency (wrapped NEAR FT rows also carry the "NEAR" symbol).
fn resolve_origin_asset(token: &SimplifiedToken) -> color_eyre::eyre::Result<String> {
    if matches!(token.residency, TokenResidency::Near) {
        return Ok("nep141:wrap.near".to_string());
    }
    let contract_id = token.contract_id.as_deref().ok_or_else(|| {
        color_eyre::eyre::eyre!(
            "Token {} ({}) has no contract id — cannot route it through intents",
            token.symbol,
            token.residency
        )
    })?;
    if contract_id.starts_with("nep141:") || contract_id.starts_with("nep245:") {
        Ok(contract_id.to_string())
    } else {
        Ok(format!("nep141:{}", contract_id))
    }
}

/// Strip the multi-token standard prefix (`nep141:` / `nep245:`) for id
/// matching, extends nt-fe `normalizeNearAssetId` to nep245 ids.
fn normalize_near_asset_id(value: &str) -> String {
    let normalized = value.trim().to_lowercase();
    normalized
        .strip_prefix("nep141:")
        .or_else(|| normalized.strip_prefix("nep245:"))
        .map(|s| s.to_string())
        .unwrap_or(normalized)
}

fn find_bridge_asset<'a>(
    assets: &'a [crate::types::BridgeAsset],
    origin_asset: &str,
) -> Option<&'a crate::types::BridgeAsset> {
    let needle = normalize_near_asset_id(origin_asset);
    assets.iter().find(|asset| {
        asset
            .networks
            .iter()
            .any(|n| normalize_near_asset_id(&n.id) == needle)
    })
}

/// Validate a human-entered amount: a plain positive decimal number,
/// strictly greater than zero. Anything else ("", "0", "all", "1e5", "-1",
/// "1,5", …) is rejected with a clear message.
fn validate_amount(input: &str) -> Result<(), String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Amount is required".to_string());
    }

    let (int_part, fract_part) = match trimmed.split_once('.') {
        Some((int_part, fract_part)) => (int_part, Some(fract_part)),
        None => (trimmed, None),
    };
    let is_digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !is_digits(int_part) || !fract_part.is_none_or(is_digits) {
        return Err(format!(
            "Invalid amount '{trimmed}': expected a positive number like 0.5 or 100"
        ));
    }

    if trimmed.bytes().all(|b| b == b'0' || b == b'.') {
        return Err("Amount must be greater than zero".to_string());
    }

    Ok(())
}

/// Parse a human amount (e.g. "0.5") into a raw integer string at `decimals`.
fn normalize_amount(amount: &str, symbol: &str, decimals: u8) -> color_eyre::eyre::Result<String> {
    // Re-validate here: amounts passed as CLI arguments skip the interactive
    // prompt validator.
    validate_amount(amount).map_err(|e| color_eyre::eyre::eyre!(e))?;

    let ft_input = format!("{} {}", amount.trim(), symbol);
    let ft = near_cli_rs::types::ft_properties::FungibleToken::from_str(&ft_input)
        .map_err(|e| color_eyre::eyre::eyre!("Invalid amount '{}': {}", amount, e))?;
    let ft_metadata = near_cli_rs::types::ft_properties::FtMetadata {
        symbol: symbol.to_string(),
        decimals,
    };
    let normalized = ft.normalize(&ft_metadata)?;
    Ok(normalized.amount().to_string())
}

/// Sputnik Transfer kind token id: "" for native NEAR (by residency, not
/// symbol — wrapped NEAR FT rows are also labeled "NEAR"), bare contract
/// otherwise.
fn resolve_token_id(token: &SimplifiedToken) -> color_eyre::eyre::Result<String> {
    if matches!(token.residency, TokenResidency::Near) {
        return Ok(String::new());
    }

    let contract_id = token.contract_id.as_deref().ok_or_else(|| {
        color_eyre::eyre::eyre!(
            "Token {} ({}) has no contract id — cannot build a transfer for it",
            token.symbol,
            token.residency
        )
    })?;
    Ok(contract_id
        .strip_prefix("nep141:")
        .unwrap_or(contract_id)
        .to_string())
}

/// Replicates nt-fe `encodeToMarkdown`: "* Key Name: value" pairs joined with
/// " <br>", empty values skipped. Keys are passed already human-readable.
fn encode_to_markdown(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .filter(|(_, value)| !value.is_empty())
        .map(|(key, value)| format!("* {}: {}", readable_key(key), value))
        .collect::<Vec<_>>()
        .join(" <br>")
}

/// Mirrors nt-fe `parseKeyToReadableFormat` for the snake/camel keys we use.
fn readable_key(key: &str) -> String {
    let mut result = String::new();
    let mut capitalize = true;
    for c in key.chars() {
        if c == '_' {
            result.push(' ');
            capitalize = true;
        } else if c.is_uppercase() {
            result.push(' ');
            result.push(c);
            capitalize = false;
        } else if capitalize {
            result.push(c.to_ascii_uppercase());
            capitalize = false;
        } else {
            result.push(c);
        }
    }
    result
}

#[allow(clippy::too_many_arguments)]
#[tracing::instrument(name = "Requesting 1Click quote ...", skip_all)]
fn request_quote(
    api: &ApiClient,
    treasury_id: &str,
    policy: &crate::types::Policy,
    origin_asset: &str,
    deposit_type: &str,
    destination_asset: &str,
    recipient_type: &str,
    raw_amount: &str,
    receiver: &str,
) -> color_eyre::eyre::Result<serde_json::Value> {
    // The deposit address must stay valid until the proposal can no longer be
    // approved, so the quote deadline follows the proposal voting period.
    let deadline_ms = policy
        .proposal_period
        .as_deref()
        .and_then(|p| p.parse::<u64>().ok())
        .map(|nanos| nanos / 1_000_000)
        .unwrap_or(24 * 60 * 60 * 1000);
    let deadline = chrono::Utc::now() + chrono::Duration::milliseconds(deadline_ms as i64);

    let quote_request = serde_json::json!({
        "daoId": treasury_id,
        "swapType": "EXACT_OUTPUT",
        "slippageTolerance": 0,
        "originAsset": origin_asset,
        "depositType": deposit_type,
        "destinationAsset": destination_asset,
        "amount": raw_amount,
        "refundTo": treasury_id,
        "refundType": deposit_type,
        "recipient": receiver,
        "recipientType": recipient_type,
        "deadline": deadline.to_rfc3339(),
        "quoteWaitingTimeMs": 0,
        "isPayment": true,
        "dry": false,
    });

    let quote = api.get_intents_quote(&quote_request)?;

    let deposit_address = quote
        .pointer("/quote/depositAddress")
        .and_then(|v| v.as_str())
        .unwrap_or("<missing>");
    let amount_in = quote
        .pointer("/quote/amountInFormatted")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    let amount_out = quote
        .pointer("/quote/amountOutFormatted")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    tracing::info!(
        "  Quote: treasury pays {} → recipient receives {} (deposit address: {})",
        amount_in.cyan(),
        amount_out.cyan(),
        deposit_address.dimmed(),
    );

    Ok(quote)
}

/// Confidential route: ask the backend to generate (and store) the 1Click
/// intent, then wrap its NEP-413 payload hash into a v1.signer `sign` proposal.
///
/// The on-chain proposal is deliberately opaque: it signs a hash, revealing
/// neither token nor amount. After the proposal is approved through the Trezu
/// relay (vote relayed with proposalType="vote"), the backend extracts the MPC
/// signature from the execution result and auto-submits the stored intent to
/// 1Click, which performs the actual transfer.
#[tracing::instrument(name = "Building confidential proposal ...", skip_all)]
fn build_confidential_proposal(
    api: &ApiClient,
    treasury_id: &str,
    quote: &serde_json::Value,
    notes: &str,
) -> color_eyre::eyre::Result<(String, serde_json::Value)> {
    tracing::info!("  Generating confidential intent...");
    let mut quote_metadata = quote.clone();
    if let Some(obj) = quote_metadata.as_object_mut() {
        obj.remove("correlationId");
    }

    let intent_request = serde_json::json!({
        "type": "swap_transfer",
        "standard": "nep413",
        "signerId": treasury_id,
        "quoteMetadata": quote_metadata,
        "notes": if notes.is_empty() { None } else { Some(notes) },
    });

    let intent_response = api.generate_intent(&intent_request)?;

    let payload_hash = intent_response
        .get("payloadHash")
        .and_then(|v| v.as_str())
        .ok_or_else(|| color_eyre::eyre::eyre!("No payloadHash in generate-intent response"))?;

    let signer_args = serde_json::json!({
        "request": {
            "path": treasury_id,
            "payload_v2": {
                "Eddsa": payload_hash,
            },
            "domain_id": 1,
        }
    });

    let args_base64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        serde_json::to_string(&signer_args)?.as_bytes(),
    );

    let description = encode_to_markdown(&[
        ("proposal_action", "confidential"),
        (
            "notes",
            "Confidential proposal via private intents. Details are hidden for privacy.",
        ),
    ]);

    let kind = serde_json::json!({
        "FunctionCall": {
            "receiver_id": "v1.signer",
            "actions": [
                {
                    "method_name": "sign",
                    "args": args_base64,
                    "deposit": "1",
                    "gas": V1_SIGNER_GAS,
                }
            ]
        }
    });

    tracing::info!(
        target: "near_teach_me",
        parent: &tracing::Span::none(),
        "Proposal asks v1.signer to MPC-sign NEP-413 payload hash {} for path '{}' (domain 1 = \
         Ed25519). The backend stored the matching intent and will submit it to 1Click once it \
         sees this signature in an approved vote relayed with proposalType=\"vote\".",
        payload_hash,
        treasury_id
    );
    tracing::info!("  Intent generated, payload hash: {}", payload_hash);

    Ok((description, kind))
}

/// Public intents route: the proposal moves `amountIn` from the treasury to
/// the 1Click deposit address; 1Click then delivers the requested amount to
/// the recipient on the destination network.
#[tracing::instrument(name = "Building transfer proposal ...", skip_all)]
fn build_public_intents_proposal(
    token: &SimplifiedToken,
    origin_asset: &str,
    quote: &serde_json::Value,
    receiver: &str,
    destination_network: &str,
    notes: &str,
) -> color_eyre::eyre::Result<(String, serde_json::Value)> {
    let deposit_address = quote
        .pointer("/quote/depositAddress")
        .and_then(|v| v.as_str())
        .ok_or_else(|| color_eyre::eyre::eyre!("No depositAddress in quote response"))?;
    let amount_in = quote
        .pointer("/quote/amountIn")
        .and_then(|v| v.as_str())
        .ok_or_else(|| color_eyre::eyre::eyre!("No amountIn in quote response"))?;

    let kind = match token.residency {
        // Funds already on intents.near → multi-token transfer to the deposit address.
        TokenResidency::Intents => serde_json::json!({
            "FunctionCall": {
                "receiver_id": "intents.near",
                "actions": [
                    {
                        "method_name": "mt_transfer",
                        "args": json_to_base64(&serde_json::json!({
                            "receiver_id": deposit_address,
                            "amount": amount_in,
                            "token_id": origin_asset,
                        }))?,
                        "deposit": "1",
                        "gas": FT_TRANSFER_GAS,
                    }
                ]
            }
        }),
        // Native NEAR → wrap first, then ft_transfer wNEAR to the deposit address.
        TokenResidency::Near => serde_json::json!({
            "FunctionCall": {
                "receiver_id": "wrap.near",
                "actions": [
                    {
                        "method_name": "near_deposit",
                        "args": json_to_base64(&serde_json::json!({}))?,
                        "deposit": amount_in,
                        "gas": NEAR_DEPOSIT_GAS,
                    },
                    {
                        "method_name": "ft_transfer",
                        "args": json_to_base64(&serde_json::json!({
                            "receiver_id": deposit_address,
                            "amount": amount_in,
                        }))?,
                        "deposit": "1",
                        "gas": FT_TRANSFER_GAS,
                    }
                ]
            }
        }),
        // NEAR-chain FT → ft_transfer on the token contract.
        _ => serde_json::json!({
            "FunctionCall": {
                "receiver_id": resolve_token_id(token)?,
                "actions": [
                    {
                        "method_name": "ft_transfer",
                        "args": json_to_base64(&serde_json::json!({
                            "receiver_id": deposit_address,
                            "amount": amount_in,
                        }))?,
                        "deposit": "1",
                        "gas": FT_TRANSFER_GAS,
                    }
                ]
            }
        }),
    };

    let network_fee = compute_network_fee(quote);
    let signature = quote
        .get("signature")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let description = encode_to_markdown(&[
        ("proposal_action", "payment-transfer"),
        ("notes", notes),
        ("recipient", receiver),
        ("destinationNetwork", destination_network),
        ("networkFee", network_fee.as_deref().unwrap_or("")),
        ("depositAddress", deposit_address),
        ("signature", signature),
    ]);

    tracing::info!(
        target: "near_teach_me",
        parent: &tracing::Span::none(),
        "Public intents transfer: proposal sends amountIn={} of {} to 1Click deposit address {}; \
         1Click watches that address and delivers the requested amount to {} on {}.",
        amount_in,
        token.symbol,
        deposit_address,
        receiver,
        destination_network
    );

    Ok((description, kind))
}

/// 1Click fee shown in the proposal description: amountIn - amountOut using the
/// formatted (human) values, mirrors nt-fe `computeQuoteNetworkFee`.
fn compute_network_fee(quote: &serde_json::Value) -> Option<String> {
    let amount_in: f64 = quote
        .pointer("/quote/amountInFormatted")
        .and_then(|v| v.as_str())?
        .parse()
        .ok()?;
    let amount_out: f64 = quote
        .pointer("/quote/amountOutFormatted")
        .and_then(|v| v.as_str())?
        .parse()
        .ok()?;
    let fee = amount_in - amount_out;
    if fee > 0.0 {
        Some(format!("{}", (fee * 1e6).round() / 1e6))
    } else {
        None
    }
}

fn json_to_base64(value: &serde_json::Value) -> color_eyre::eyre::Result<String> {
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        serde_json::to_string(value)?.as_bytes(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(
        symbol: &str,
        residency: TokenResidency,
        contract_id: Option<&str>,
    ) -> SimplifiedToken {
        SimplifiedToken {
            id: symbol.to_lowercase(),
            contract_id: contract_id.map(|s| s.to_string()),
            lockup_instance_id: None,
            ft_lockup_schedule: None,
            residency,
            network: "near".to_string(),
            chain_name: "NEAR".to_string(),
            symbol: symbol.to_string(),
            balance: crate::types::Balance::Standard {
                total: "0".to_string(),
                locked: "0".to_string(),
            },
            decimals: 6,
            price: "0".to_string(),
            name: symbol.to_string(),
            icon: None,
            chain_icons: None,
        }
    }

    fn sample_assets() -> Vec<SimplifiedToken> {
        vec![
            token("NEAR", TokenResidency::Near, None),
            token("NEAR", TokenResidency::Intents, Some("nep141:wrap.near")),
            token("USDT", TokenResidency::Ft, Some("usdt.tether-token.near")),
            token(
                "USDT",
                TokenResidency::Intents,
                Some("nep141:usdt.tether-token.near"),
            ),
            token("USDC", TokenResidency::Intents, Some("nep141:usdc.near")),
            token("NEAR", TokenResidency::Staked, None),
        ]
    }

    #[test]
    fn resolve_token_unique_symbol() {
        let assets = sample_assets();
        let t = resolve_token(&assets, "usdc").unwrap();
        assert_eq!(t.residency, TokenResidency::Intents);
    }

    #[test]
    fn resolve_token_ambiguous_symbol_errors_with_selectors() {
        let assets = sample_assets();
        let err = resolve_token(&assets, "USDT").unwrap_err().to_string();
        assert!(err.contains("USDT@ft"), "got: {err}");
        assert!(err.contains("USDT@intents"), "got: {err}");
    }

    #[test]
    fn resolve_token_by_flavor() {
        let assets = sample_assets();
        assert_eq!(
            resolve_token(&assets, "USDT@ft").unwrap().residency,
            TokenResidency::Ft
        );
        assert_eq!(
            resolve_token(&assets, "usdt@intents").unwrap().residency,
            TokenResidency::Intents
        );
        assert_eq!(
            resolve_token(&assets, "NEAR@near").unwrap().residency,
            TokenResidency::Near
        );
    }

    #[test]
    fn resolve_token_by_contract_id() {
        let assets = sample_assets();
        let t = resolve_token(&assets, "nep141:usdc.near").unwrap();
        assert_eq!(t.symbol, "USDC");
        let t = resolve_token(&assets, "usdc.near").unwrap();
        assert_eq!(t.symbol, "USDC");
        // Same contract backs both the Ft and the Intents USDT rows →
        // ambiguous, must list flavor selectors.
        let err = resolve_token(&assets, "usdt.tether-token.near")
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("USDT@ft") && err.contains("USDT@intents"),
            "got: {err}"
        );
    }

    #[test]
    fn resolve_token_ignores_staked_and_unknown() {
        let assets = sample_assets();
        assert!(resolve_token(&assets, "NEAR@staked").is_err());
        assert!(resolve_token(&assets, "DOGE").is_err());
    }

    #[test]
    fn token_selector_prefers_shortest_unambiguous_form() {
        let assets = sample_assets();
        let sendable: Vec<&SimplifiedToken> = assets.iter().filter(|t| is_sendable(t)).collect();
        assert_eq!(token_selector(sendable[4], &sendable), "USDC");
        assert_eq!(token_selector(sendable[2], &sendable), "USDT@ft");
        assert_eq!(token_selector(sendable[0], &sendable), "NEAR@near");
        // Every selector must resolve back to the same token.
        for t in &sendable {
            let selector = token_selector(t, &sendable);
            let resolved = resolve_token(&assets, &selector).unwrap();
            assert_eq!(resolved.residency, t.residency, "selector {selector}");
            assert_eq!(resolved.contract_id, t.contract_id, "selector {selector}");
        }
    }

    #[test]
    fn normalize_near_asset_id_strips_multi_token_prefixes() {
        assert_eq!(normalize_near_asset_id("nep141:wrap.near"), "wrap.near");
        assert_eq!(
            normalize_near_asset_id("nep245:v2_1.omni.hot.tg:56_2CMM"),
            "v2_1.omni.hot.tg:56_2cmm"
        );
        assert_eq!(normalize_near_asset_id("wrap.near"), "wrap.near");
    }

    #[test]
    fn origin_asset_and_token_id_key_off_residency() {
        // Native NEAR by residency, regardless of other rows sharing the symbol.
        let native = token("NEAR", TokenResidency::Near, None);
        assert_eq!(resolve_origin_asset(&native).unwrap(), "nep141:wrap.near");
        assert_eq!(resolve_token_id(&native).unwrap(), "");

        // A wrapped-NEAR FT row also labeled "NEAR" must keep its contract.
        let wnear = token("NEAR", TokenResidency::Ft, Some("wrap.near"));
        assert_eq!(resolve_origin_asset(&wnear).unwrap(), "nep141:wrap.near");
        assert_eq!(resolve_token_id(&wnear).unwrap(), "wrap.near");

        // nep245 ids pass through unchanged.
        let omni = token(
            "USDT",
            TokenResidency::Intents,
            Some("nep245:v2_1.omni.hot.tg:56_2CMM"),
        );
        assert_eq!(
            resolve_origin_asset(&omni).unwrap(),
            "nep245:v2_1.omni.hot.tg:56_2CMM"
        );

        // Missing contract on a non-native token is an error, not wrap.near.
        let broken = token("USDT", TokenResidency::Ft, None);
        assert!(resolve_origin_asset(&broken).is_err());
        assert!(resolve_token_id(&broken).is_err());
    }

    #[test]
    fn validate_amount_accepts_positive_decimals() {
        for input in ["0.5", "100", "1.000001", " 2 ", "0.000001"] {
            assert!(validate_amount(input).is_ok(), "expected ok: {input:?}");
        }
    }

    #[test]
    fn validate_amount_rejects_invalid_input() {
        for input in [
            "", "  ", "0", "0.0", "00.000", ".", ".5", "5.", "-1", "1e5", "all", "1,5", "1 2",
            "NaN", "0x10",
        ] {
            assert!(validate_amount(input).is_err(), "expected err: {input:?}");
        }
    }

    #[test]
    fn normalize_amount_scales_and_validates() {
        assert_eq!(normalize_amount("0.5", "USDT", 6).unwrap(), "500000");
        assert_eq!(normalize_amount("100", "USDT", 6).unwrap(), "100000000");
        assert!(normalize_amount("", "USDT", 6).is_err());
        assert!(normalize_amount("0", "USDT", 6).is_err());
        // more fractional digits than the token supports
        assert!(normalize_amount("0.0000001", "USDT", 6).is_err());
    }
}
