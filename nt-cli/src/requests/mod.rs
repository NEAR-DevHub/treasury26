use crate::api::ApiClient;
use crate::config::{TreasuryContext, TrezuContext};
use crate::types::ProposalStatus;
use colored::Colorize;
use strum::{EnumDiscriminants, EnumIter, EnumMessage};

#[derive(Debug, Clone, interactive_clap::InteractiveClap)]
#[interactive_clap(input_context = TrezuContext)]
#[interactive_clap(output_context = RequestsTreasuryContext)]
pub struct Requests {
    #[interactive_clap(skip_default_input_arg)]
    /// Treasury (DAO) account ID
    treasury_id: String,
    #[interactive_clap(subcommand)]
    command: RequestsCommand,
}

impl Requests {
    fn input_treasury_id(context: &TrezuContext) -> color_eyre::eyre::Result<Option<String>> {
        crate::config::input_treasury_id(context)
    }
}

#[derive(Debug, Clone)]
pub struct RequestsTreasuryContext(TreasuryContext);

impl RequestsTreasuryContext {
    pub fn from_previous_context(
        previous_context: TrezuContext,
        scope: &<Requests as interactive_clap::ToInteractiveClapContextScope>::InteractiveClapContextScope,
    ) -> color_eyre::eyre::Result<Self> {
        crate::config::touch_treasury(&scope.treasury_id);
        Ok(Self(TreasuryContext {
            config: previous_context.config,
            global_context: previous_context.global_context,
            treasury_id: scope.treasury_id.clone(),
        }))
    }
}

impl From<RequestsTreasuryContext> for TreasuryContext {
    fn from(item: RequestsTreasuryContext) -> Self {
        item.0
    }
}

#[derive(Debug, EnumDiscriminants, Clone, interactive_clap::InteractiveClap)]
#[interactive_clap(context = TreasuryContext)]
#[strum_discriminants(derive(EnumMessage, EnumIter))]
/// Select requests action
pub enum RequestsCommand {
    #[strum_discriminants(strum(message = "list     -   List proposals"))]
    /// List proposals
    List(RequestsList),
    #[strum_discriminants(strum(message = "view     -   View proposal details"))]
    /// View proposal details
    View(RequestsView),
    #[strum_discriminants(strum(message = "pending  -   List pending (in-progress) proposals"))]
    /// List pending proposals
    Pending(RequestsPending),
    #[strum_discriminants(strum(message = "approve  -   Approve a proposal"))]
    /// Approve a proposal
    Approve(RequestsApprove),
    #[strum_discriminants(strum(message = "reject   -   Reject a proposal"))]
    /// Reject a proposal
    Reject(RequestsReject),
}

// --- List ---

#[derive(Debug, Clone, interactive_clap::InteractiveClap)]
#[interactive_clap(input_context = TreasuryContext)]
#[interactive_clap(output_context = RequestsListContext)]
pub struct RequestsList {
    #[interactive_clap(long)]
    #[interactive_clap(skip_default_input_arg)]
    /// Filter by status (InProgress, Approved, Rejected, Expired)
    status: String,
}

impl RequestsList {
    fn input_status(_context: &TreasuryContext) -> color_eyre::eyre::Result<Option<String>> {
        let options = vec![
            "All",
            "InProgress",
            "Approved",
            "Rejected",
            "Expired",
            "Failed",
        ];
        let selection = inquire::Select::new("Filter by status:", options).prompt()?;
        if selection == "All" {
            Ok(Some(String::new()))
        } else {
            Ok(Some(selection.to_string()))
        }
    }
}

#[derive(Debug, Clone)]
pub struct RequestsListContext;

impl RequestsListContext {
    #[tracing::instrument(name = "Listing proposals ...", skip_all)]
    pub fn from_previous_context(
        previous_context: TreasuryContext,
        scope: &<RequestsList as interactive_clap::ToInteractiveClapContextScope>::InteractiveClapContextScope,
    ) -> color_eyre::eyre::Result<Self> {
        let treasury_id = &previous_context.treasury_id;
        let api = ApiClient::new(&previous_context.config);

        let status_filter = if scope.status.is_empty() {
            None
        } else {
            Some(scope.status.as_str())
        };

        let result = api.list_proposals(treasury_id, status_filter, Some(1), Some(25))?;

        if result.proposals.is_empty() {
            tracing::info!("{}", "No proposals found.".dimmed());
            return Ok(Self);
        }

        tracing::info!(
            "{}",
            format!(
                "Proposals for {} (page {}/{}, total {})",
                treasury_id,
                result.page,
                (result.total + result.page_size - 1) / result.page_size.max(1),
                result.total,
            )
            .cyan()
            .bold()
        );

        print_proposals_table(&result.proposals);

        Ok(Self)
    }
}

// --- View ---

#[derive(Debug, Clone, interactive_clap::InteractiveClap)]
#[interactive_clap(input_context = TreasuryContext)]
#[interactive_clap(output_context = RequestsViewContext)]
pub struct RequestsView {
    /// Proposal ID
    proposal_id: u64,
}

#[derive(Debug, Clone)]
pub struct RequestsViewContext;

impl RequestsViewContext {
    #[tracing::instrument(name = "Viewing proposal ...", skip_all)]
    pub fn from_previous_context(
        previous_context: TreasuryContext,
        scope: &<RequestsView as interactive_clap::ToInteractiveClapContextScope>::InteractiveClapContextScope,
    ) -> color_eyre::eyre::Result<Self> {
        let treasury_id = &previous_context.treasury_id;
        let api = ApiClient::new(&previous_context.config);
        let proposal = api.get_proposal(treasury_id, scope.proposal_id)?;

        tracing::info!("{}", format!("Proposal #{}", proposal.id).cyan().bold());
        tracing::info!("Status:      {}", format_status(&proposal.status));
        tracing::info!("Proposer:    {}", proposal.proposer);
        tracing::info!("Description: {}", proposal.description);
        tracing::info!("Submitted:   {}", proposal.submission_time);

        tracing::info!("{}", "Kind:".bold());
        tracing::info!(
            "{}",
            serde_json::to_string_pretty(&proposal.kind).unwrap_or_default()
        );

        if !proposal.votes.is_empty() {
            tracing::info!("{}", "Votes:".bold());
            for (voter, vote) in &proposal.votes {
                let vote_str = match vote {
                    crate::types::Vote::Approve => "Approve".green().to_string(),
                    crate::types::Vote::Reject => "Reject".red().to_string(),
                    crate::types::Vote::Remove => "Remove".yellow().to_string(),
                };
                tracing::info!("  {} → {}", voter, vote_str);
            }
        }

        if !proposal.vote_counts.is_empty() {
            tracing::info!("{}", "Vote counts by role:".bold());
            for (role, counts) in &proposal.vote_counts {
                tracing::info!("  {}: {}", role, counts);
            }
        }

        Ok(Self)
    }
}

// --- Pending ---

#[derive(Debug, Clone, interactive_clap::InteractiveClap)]
#[interactive_clap(input_context = TreasuryContext)]
#[interactive_clap(output_context = RequestsPendingContext)]
pub struct RequestsPending {}

#[derive(Debug, Clone)]
pub struct RequestsPendingContext;

impl RequestsPendingContext {
    #[tracing::instrument(name = "Listing pending proposals ...", skip_all)]
    pub fn from_previous_context(
        previous_context: TreasuryContext,
        _scope: &<RequestsPending as interactive_clap::ToInteractiveClapContextScope>::InteractiveClapContextScope,
    ) -> color_eyre::eyre::Result<Self> {
        let treasury_id = &previous_context.treasury_id;
        let api = ApiClient::new(&previous_context.config);
        let result = api.list_proposals(treasury_id, Some("InProgress"), Some(1), Some(50))?;

        if result.proposals.is_empty() {
            tracing::info!("{}", "No pending proposals.".green());
            return Ok(Self);
        }

        tracing::info!(
            "{}",
            format!("{} pending proposals", result.total)
                .yellow()
                .bold()
        );

        print_proposals_table(&result.proposals);

        Ok(Self)
    }
}

// --- Approve ---

#[derive(Debug, Clone, interactive_clap::InteractiveClap)]
#[interactive_clap(input_context = TreasuryContext)]
#[interactive_clap(output_context = RequestsApproveContext)]
pub struct RequestsApprove {
    #[interactive_clap(skip_default_input_arg)]
    /// Proposal ID to approve
    proposal_id: u64,
    #[interactive_clap(named_arg)]
    /// Select network
    network_config: near_cli_rs::network_for_transaction::NetworkForTransactionArgs,
}

impl RequestsApprove {
    fn input_proposal_id(context: &TreasuryContext) -> color_eyre::eyre::Result<Option<u64>> {
        input_pending_proposal_id(context, "approve")
    }
}

#[derive(Debug, Clone)]
pub struct RequestsApproveContext {
    global_context: near_cli_rs::GlobalContext,
    trezu_config: crate::config::TrezuConfig,
    signer_id: near_primitives::types::AccountId,
    treasury_id: String,
    proposal_id: u64,
    proposal_kind: serde_json::Value,
}

impl RequestsApproveContext {
    #[tracing::instrument(name = "Approving proposal ...", skip_all)]
    pub fn from_previous_context(
        previous_context: TreasuryContext,
        scope: &<RequestsApprove as interactive_clap::ToInteractiveClapContextScope>::InteractiveClapContextScope,
    ) -> color_eyre::eyre::Result<Self> {
        let treasury_id = &previous_context.treasury_id;
        let account_id = previous_context
            .config
            .account_id
            .as_deref()
            .ok_or_else(|| {
                color_eyre::eyre::eyre!("Not logged in. Run `trezu auth login` first.")
            })?;
        let signer_id: near_primitives::types::AccountId = account_id
            .parse()
            .map_err(|e| color_eyre::eyre::eyre!("Invalid account ID: {}", e))?;

        let api = ApiClient::new(&previous_context.config);
        let proposal = api.get_proposal(treasury_id, scope.proposal_id)?;

        tracing::info!(
            "{} proposal #{} on {}...",
            "Approving".cyan(),
            scope.proposal_id,
            treasury_id
        );

        Ok(Self {
            global_context: previous_context.global_context,
            trezu_config: previous_context.config.clone(),
            signer_id,
            treasury_id: treasury_id.to_string(),
            proposal_id: scope.proposal_id,
            proposal_kind: proposal.kind,
        })
    }
}

impl From<RequestsApproveContext> for near_cli_rs::commands::ActionContext {
    fn from(item: RequestsApproveContext) -> Self {
        build_vote_action_context(
            item.global_context,
            item.trezu_config,
            item.signer_id,
            item.treasury_id,
            item.proposal_id,
            "VoteApprove",
            item.proposal_kind,
        )
    }
}

// --- Reject ---

#[derive(Debug, Clone, interactive_clap::InteractiveClap)]
#[interactive_clap(input_context = TreasuryContext)]
#[interactive_clap(output_context = RequestsRejectContext)]
pub struct RequestsReject {
    #[interactive_clap(skip_default_input_arg)]
    /// Proposal ID to reject
    proposal_id: u64,
    #[interactive_clap(named_arg)]
    /// Select network
    network_config: near_cli_rs::network_for_transaction::NetworkForTransactionArgs,
}

impl RequestsReject {
    fn input_proposal_id(context: &TreasuryContext) -> color_eyre::eyre::Result<Option<u64>> {
        input_pending_proposal_id(context, "reject")
    }
}

#[derive(Debug, Clone)]
pub struct RequestsRejectContext {
    global_context: near_cli_rs::GlobalContext,
    trezu_config: crate::config::TrezuConfig,
    signer_id: near_primitives::types::AccountId,
    treasury_id: String,
    proposal_id: u64,
    proposal_kind: serde_json::Value,
}

impl RequestsRejectContext {
    #[tracing::instrument(name = "Rejecting proposal ...", skip_all)]
    pub fn from_previous_context(
        previous_context: TreasuryContext,
        scope: &<RequestsReject as interactive_clap::ToInteractiveClapContextScope>::InteractiveClapContextScope,
    ) -> color_eyre::eyre::Result<Self> {
        let treasury_id = &previous_context.treasury_id;
        let account_id = previous_context
            .config
            .account_id
            .as_deref()
            .ok_or_else(|| {
                color_eyre::eyre::eyre!("Not logged in. Run `trezu auth login` first.")
            })?;
        let signer_id: near_primitives::types::AccountId = account_id
            .parse()
            .map_err(|e| color_eyre::eyre::eyre!("Invalid account ID: {}", e))?;

        let api = ApiClient::new(&previous_context.config);
        let proposal = api.get_proposal(treasury_id, scope.proposal_id)?;

        tracing::info!(
            "{} proposal #{} on {}...",
            "Rejecting".cyan(),
            scope.proposal_id,
            treasury_id
        );

        Ok(Self {
            global_context: previous_context.global_context,
            trezu_config: previous_context.config.clone(),
            signer_id,
            treasury_id: treasury_id.to_string(),
            proposal_id: scope.proposal_id,
            proposal_kind: proposal.kind,
        })
    }
}

impl From<RequestsRejectContext> for near_cli_rs::commands::ActionContext {
    fn from(item: RequestsRejectContext) -> Self {
        build_vote_action_context(
            item.global_context,
            item.trezu_config,
            item.signer_id,
            item.treasury_id,
            item.proposal_id,
            "VoteReject",
            item.proposal_kind,
        )
    }
}

fn build_vote_action_context(
    global_context: near_cli_rs::GlobalContext,
    trezu_config: crate::config::TrezuConfig,
    signer_id: near_primitives::types::AccountId,
    treasury_id: String,
    proposal_id: u64,
    action: &'static str,
    proposal_kind: serde_json::Value,
) -> near_cli_rs::commands::ActionContext {
    let get_prepopulated_transaction_after_getting_network_callback:
        near_cli_rs::commands::GetPrepopulatedTransactionAfterGettingNetworkCallback =
    {
        let signer_id = signer_id.clone();
        let treasury_id = treasury_id.clone();
        std::sync::Arc::new(move |_network_config| {
            let mut args = serde_json::json!({
                "id": proposal_id,
                "action": action,
            });
            // The embedded proposal kind copy lets the backend relay recognize
            // v1.signer confidential proposals and extract the NEP-413 payload
            // hash before the vote executes.
            args.as_object_mut()
                .unwrap()
                .insert("proposal".to_string(), proposal_kind.clone());

            let args_bytes = serde_json::to_vec(&args)
                .map_err(|e| color_eyre::eyre::eyre!("Failed to serialize args: {}", e))?;

            tracing::info!(
                target: "near_teach_me",
                parent: &tracing::Span::none(),
                "act_proposal args (proposal kind embedded for the relay's confidential-intent \
                 detection):\n{}",
                serde_json::to_string_pretty(&args).unwrap_or_default()
            );

            let receiver_id: near_primitives::types::AccountId = treasury_id
                .parse()
                .map_err(|e| color_eyre::eyre::eyre!("Invalid treasury ID: {}", e))?;

            Ok(near_cli_rs::commands::PrepopulatedTransaction {
                signer_id: signer_id.clone(),
                receiver_id,
                actions: vec![near_primitives::transaction::Action::FunctionCall(
                    Box::new(near_primitives::action::FunctionCallAction {
                        method_name: "act_proposal".to_string(),
                        args: args_bytes,
                        gas: near_primitives::types::Gas::from_teragas(270),
                        deposit: near_token::NearToken::from_yoctonear(0),
                    }),
                )],
            })
        })
    };

    near_cli_rs::commands::ActionContext {
        global_context,
        interacting_with_account_ids: vec![signer_id],
        get_prepopulated_transaction_after_getting_network_callback,
        on_before_signing_callback: std::sync::Arc::new(
            |_unsigned_transaction, _network_config| Ok(()),
        ),
        on_before_sending_transaction_callback: std::sync::Arc::new(
            |_signed_transaction, _network_config| Ok(String::new()),
        ),
        on_after_sending_transaction_callback: std::sync::Arc::new(|_outcome, _network_config| {
            Ok(())
        }),
        sign_as_delegate_action: true,
        // proposalType "vote" is load-bearing: the backend only scans the vote
        // execution result for an MPC signature (and auto-submits the pending
        // confidential intent to 1Click) when the relay request is marked as a
        // vote. Omitting it makes confidential payments silently no-op.
        on_sending_delegate_action_callback: Some(crate::relay::build_relay_callback(
            trezu_config,
            treasury_id,
            Some("vote".to_string()),
            Some(proposal_id),
        )),
    }
}

/// Interactive proposal-id input for vote commands: show the pending
/// proposals table first, then let the user pick one from the list.
fn input_pending_proposal_id(
    context: &TreasuryContext,
    action: &str,
) -> color_eyre::eyre::Result<Option<u64>> {
    let api = ApiClient::new(&context.config);
    let result = api.list_proposals(&context.treasury_id, Some("InProgress"), Some(1), Some(50))?;

    if result.proposals.is_empty() {
        return Err(color_eyre::eyre::eyre!(
            "No pending proposals to {} on {}.",
            action,
            context.treasury_id
        ));
    }

    tracing::info!(
        "{}",
        format!(
            "{} pending proposals on {}",
            result.total, context.treasury_id
        )
        .cyan()
        .bold()
    );
    print_proposals_table(&result.proposals);

    let options: Vec<String> = result
        .proposals
        .iter()
        .map(|p| format!("#{} — {}", p.id, truncate_chars(&p.description, 60)))
        .collect();

    let selection =
        inquire::Select::new(&format!("Select proposal to {action}:"), options.clone()).prompt()?;
    let index = options.iter().position(|o| o == &selection).unwrap();
    Ok(Some(result.proposals[index].id))
}

/// Truncate to at most `max_chars` characters (not bytes — slicing byte
/// indices panics on multi-byte UTF-8), appending "..." when shortened.
fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max_chars.saturating_sub(3)).collect();
    format!("{truncated}...")
}

#[cfg(test)]
mod tests {
    use super::truncate_chars;

    #[test]
    fn truncate_chars_is_utf8_safe() {
        assert_eq!(truncate_chars("short", 50), "short");
        assert_eq!(truncate_chars("abcdefgh", 8), "abcdefgh");
        assert_eq!(truncate_chars("abcdefghi", 8), "abcde...");
        // Multi-byte content around the cut point must not panic.
        let cyrillic = "Підтвердження платежу через приватні інтенти приховано";
        let truncated = truncate_chars(cyrillic, 20);
        assert_eq!(truncated.chars().count(), 20);
        assert!(truncated.ends_with("..."));
        assert!(truncate_chars("💸💸💸💸💸", 4).ends_with("..."));
    }
}

fn print_proposals_table(proposals: &[crate::types::Proposal]) {
    let mut table = prettytable::Table::new();
    table.set_format(*prettytable::format::consts::FORMAT_BOX_CHARS);
    table.set_titles(prettytable::row![bFc => "ID", "Status", "Proposer", "Description", "Votes"]);

    for p in proposals {
        let desc = truncate_chars(&p.description, 50);

        let vote_summary = if p.votes.is_empty() {
            "-".to_string()
        } else {
            let approves = p
                .votes
                .values()
                .filter(|v| matches!(v, crate::types::Vote::Approve))
                .count();
            let rejects = p
                .votes
                .values()
                .filter(|v| matches!(v, crate::types::Vote::Reject))
                .count();
            format!("{} yes / {} no", approves, rejects)
        };

        table.add_row(prettytable::Row::new(vec![
            prettytable::Cell::new(&p.id.to_string()),
            status_cell(&p.status),
            prettytable::Cell::new(&p.proposer),
            prettytable::Cell::new(&desc),
            prettytable::Cell::new(&vote_summary),
        ]));
    }
    tracing_indicatif::suspend_tracing_indicatif(|| table.printstd());
}

fn format_status(status: &ProposalStatus) -> String {
    match status {
        ProposalStatus::InProgress => "In Progress".yellow().to_string(),
        ProposalStatus::Approved => "Approved".green().to_string(),
        ProposalStatus::Rejected => "Rejected".red().to_string(),
        ProposalStatus::Removed => "Removed".dimmed().to_string(),
        ProposalStatus::Expired => "Expired".dimmed().to_string(),
        ProposalStatus::Moved => "Moved".blue().to_string(),
        ProposalStatus::Failed => "Failed".red().bold().to_string(),
    }
}

fn status_cell(status: &ProposalStatus) -> prettytable::Cell {
    use prettytable::Attr;
    use prettytable::color;
    match status {
        ProposalStatus::InProgress => {
            prettytable::Cell::new("In Progress").with_style(Attr::ForegroundColor(color::YELLOW))
        }
        ProposalStatus::Approved => {
            prettytable::Cell::new("Approved").with_style(Attr::ForegroundColor(color::GREEN))
        }
        ProposalStatus::Rejected => {
            prettytable::Cell::new("Rejected").with_style(Attr::ForegroundColor(color::RED))
        }
        ProposalStatus::Removed => {
            prettytable::Cell::new("Removed").with_style(Attr::ForegroundColor(color::BRIGHT_BLACK))
        }
        ProposalStatus::Expired => {
            prettytable::Cell::new("Expired").with_style(Attr::ForegroundColor(color::BRIGHT_BLACK))
        }
        ProposalStatus::Moved => {
            prettytable::Cell::new("Moved").with_style(Attr::ForegroundColor(color::BLUE))
        }
        ProposalStatus::Failed => prettytable::Cell::new("Failed")
            .with_style(Attr::ForegroundColor(color::RED))
            .with_style(Attr::Bold),
    }
}
