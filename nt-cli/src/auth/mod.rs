use crate::api::ApiClient;
use crate::config::TrezuContext;
use crate::types::LoginRequest;
use base64::Engine;
use colored::Colorize;

use near_cli_rs::commands::message::sign_nep413::{
    FinalSignNep413Context, NEP413Payload, SignedMessage,
};
use rand::RngCore;
use strum::{EnumDiscriminants, EnumIter, EnumMessage};

/// NEP-641 authorization purpose used for dApp authentication.
const AUTH_PURPOSE: &str = "PROVE_OWNERSHIP";
/// Bare recipient bound into the authorization. Must match the backend's
/// `AUTH_RECIPIENT` in `nt-be/src/auth/handlers.rs`.
const AUTH_RECIPIENT: &str = "Trezu App";

#[derive(Debug, Clone, interactive_clap::InteractiveClap)]
#[interactive_clap(context = TrezuContext)]
pub struct Auth {
    #[interactive_clap(subcommand)]
    command: AuthCommand,
}

#[derive(Debug, EnumDiscriminants, Clone, interactive_clap::InteractiveClap)]
#[interactive_clap(context = TrezuContext)]
#[strum_discriminants(derive(EnumMessage, EnumIter))]
/// Select auth action
pub enum AuthCommand {
    #[strum_discriminants(strum(message = "login    -   Log in with your NEAR account"))]
    /// Log in with your NEAR account
    Login(Login),
    #[strum_discriminants(strum(message = "logout   -   Log out and clear stored credentials"))]
    /// Log out and clear stored credentials
    Logout(Logout),
    #[strum_discriminants(strum(message = "whoami   -   Show current authenticated user"))]
    /// Show current authenticated user
    Whoami(Whoami),
}

// --- Login ---

#[derive(Debug, Clone, interactive_clap::InteractiveClap)]
#[interactive_clap(input_context = TrezuContext)]
#[interactive_clap(output_context = LoginContext)]
pub struct Login {
    #[interactive_clap(skip_default_input_arg)]
    /// NEAR account ID (e.g. myaccount.near)
    account_id: String,
    #[interactive_clap(subcommand)]
    sign_with: near_cli_rs::commands::message::sign_nep413::signature_options::SignWith,
}

impl Login {
    fn input_account_id(context: &TrezuContext) -> color_eyre::eyre::Result<Option<String>> {
        near_cli_rs::common::input_signer_account_id_from_used_account_list(
            &context.global_context.config.credentials_home_dir,
            "Enter your NEAR account ID (e.g. myaccount.near):",
        )
        .map(|opt| opt.map(|id| id.to_string()))
    }
}

#[derive(Clone)]
pub struct LoginContext(FinalSignNep413Context);

impl std::fmt::Debug for LoginContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginContext").finish()
    }
}

impl LoginContext {
    #[tracing::instrument(name = "Preparing login challenge ...", skip_all)]
    pub fn from_previous_context(
        previous_context: TrezuContext,
        scope: &<Login as interactive_clap::ToInteractiveClapContextScope>::InteractiveClapContextScope,
    ) -> color_eyre::eyre::Result<Self> {
        let account_id = &scope.account_id;
        tracing::info!("Authenticating as {}...", account_id.cyan());

        let signer_id: near_primitives::types::AccountId = account_id
            .parse()
            .map_err(|e| color_eyre::eyre::eyre!("Invalid account ID: {}", e))?;

        let api = ApiClient::new(&previous_context.config);
        let challenge = api.get_challenge()?;

        // NEP-641 NEP-413 fallback: the challenge payload is the signed message
        // and the purpose is bound into the recipient as "<PURPOSE>@<recipient>".
        // The nonce is generated client-side; replay protection comes from the
        // backend consuming the unique challenge payload.
        let mut nonce_32 = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut nonce_32);
        let nonce_b64 = base64::engine::general_purpose::STANDARD.encode(nonce_32);

        let payload = NEP413Payload {
            message: challenge.payload.clone(),
            nonce: nonce_32,
            recipient: format!("{AUTH_PURPOSE}@{AUTH_RECIPIENT}"),
            callback_url: None,
        };

        let trezu_config = previous_context.config.clone();
        let challenge_payload = challenge.payload.clone();
        let login_account_id = account_id.clone();

        let on_after_signing_callback: near_cli_rs::commands::message::sign_nep413::OnAfterSigningNep413Callback =
            std::sync::Arc::new(move |signed_message: SignedMessage| {
                complete_login(
                    &trezu_config,
                    &login_account_id,
                    &signed_message.public_key,
                    &signed_message.signature,
                    &challenge_payload,
                    &nonce_b64,
                )
            });

        Ok(Self(FinalSignNep413Context {
            global_context: previous_context.global_context,
            payload,
            signer_id,
            on_after_signing_callback,
        }))
    }
}

impl From<LoginContext> for FinalSignNep413Context {
    fn from(item: LoginContext) -> Self {
        item.0
    }
}

#[tracing::instrument(name = "Completing login ...", skip_all)]
fn complete_login(
    config: &crate::config::TrezuConfig,
    account_id: &str,
    public_key: &str,
    signature: &str,
    challenge_payload: &str,
    nonce_b64: &str,
) -> color_eyre::eyre::Result<()> {
    if !signature.starts_with("ed25519:") {
        return Err(color_eyre::eyre::eyre!("Only ED25519 keys are supported"));
    }

    let api = ApiClient::new(config);

    // NEP-413 `SignedMessage` blob the backend's NEP-641 fallback verifies.
    let authorization = serde_json::json!({
        "publicKey": public_key,
        "signature": signature,
        "message": challenge_payload,
        "recipient": format!("{AUTH_PURPOSE}@{AUTH_RECIPIENT}"),
        "nonce": nonce_b64,
    })
    .to_string();

    let login_request = LoginRequest {
        account_id: account_id.to_string(),
        authorization,
    };

    let (me, token) = api.login(&login_request)?;

    let mut config = config.clone();
    config.auth_token = Some(token);
    config.account_id = Some(me.account_id.clone());
    config.save()?;

    if !me.terms_accepted {
        tracing::info!("{}", "Accepting terms of service...".dimmed());
        let authed_api = ApiClient::new(&config);
        authed_api.accept_terms()?;
    }

    tracing::info!(
        "{} Logged in as {}",
        "✓".green().bold(),
        me.account_id.cyan()
    );

    Ok(())
}

// --- Logout ---

#[derive(Debug, Clone, interactive_clap::InteractiveClap)]
#[interactive_clap(input_context = TrezuContext)]
#[interactive_clap(output_context = LogoutContext)]
pub struct Logout {}

#[derive(Debug, Clone)]
pub struct LogoutContext;

impl LogoutContext {
    #[tracing::instrument(name = "Logging out ...", skip_all)]
    pub fn from_previous_context(
        previous_context: TrezuContext,
        _scope: &<Logout as interactive_clap::ToInteractiveClapContextScope>::InteractiveClapContextScope,
    ) -> color_eyre::eyre::Result<Self> {
        if previous_context.config.auth_token.is_some() {
            let api = ApiClient::new(&previous_context.config);
            let _ = api.logout();
        }

        let mut config = previous_context.config.clone();
        config.auth_token = None;
        config.account_id = None;
        config.save()?;

        tracing::info!("{} Logged out successfully", "✓".green().bold());
        Ok(Self)
    }
}

// --- Whoami ---

#[derive(Debug, Clone, interactive_clap::InteractiveClap)]
#[interactive_clap(input_context = TrezuContext)]
#[interactive_clap(output_context = WhoamiContext)]
pub struct Whoami {}

#[derive(Debug, Clone)]
pub struct WhoamiContext;

impl WhoamiContext {
    #[tracing::instrument(name = "Checking authentication status ...", skip_all)]
    pub fn from_previous_context(
        previous_context: TrezuContext,
        _scope: &<Whoami as interactive_clap::ToInteractiveClapContextScope>::InteractiveClapContextScope,
    ) -> color_eyre::eyre::Result<Self> {
        let api = ApiClient::new(&previous_context.config);
        match api.get_me() {
            Ok(me) => {
                tracing::info!("Account:        {}", me.account_id.cyan());
                tracing::info!(
                    "Terms accepted: {}",
                    if me.terms_accepted {
                        "yes".green()
                    } else {
                        "no".red()
                    }
                );
            }
            Err(_) => {
                if let Some(account) = &previous_context.config.account_id {
                    tracing::info!("Stored account: {} {}", account, "(session expired)".red());
                } else {
                    tracing::info!("{}", "Not logged in. Run `trezu auth login` first.".red());
                }
            }
        }
        Ok(Self)
    }
}
