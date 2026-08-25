//! Typed catalog of alertable error events.
//!
//! Every Sentry-alertable failure is one [`ErrorCode`] variant. The code
//! string, alert priority, surface, failing dependency, and the stable
//! message title are declared once in [`ErrorCode::spec`] — call sites emit
//! via the [`error_event!`](crate::error_event!) macro and can no longer
//! misspell a tag, disagree about a priority, or drift from the
//! `surface / flow / cause — consequence` template (see docs/RUNBOOKS.md).

/// Routing priority; Sentry alert rules page on `p0`/`p1`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Priority {
    P0,
    P1,
    P2,
    /// Sentry-only, low-signal: kept for searchability, never expected to page
    /// or drive triage on its own.
    P3,
}

impl Priority {
    pub const fn as_str(self) -> &'static str {
        match self {
            Priority::P0 => "p0",
            Priority::P1 => "p1",
            Priority::P2 => "p2",
            Priority::P3 => "p3",
        }
    }
}

/// Who is affected: a user-initiated flow failing visibly, internal
/// machinery, or boot-time config/wiring.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    UserAction,
    /// A user-facing read/view endpoint failed — degraded page, nothing lost.
    UserRead,
    BackgroundJob,
    Startup,
}

impl Surface {
    pub const fn as_str(self) -> &'static str {
        match self {
            Surface::UserAction => "user_action",
            Surface::UserRead => "user_read",
            Surface::BackgroundJob => "background_job",
            Surface::Startup => "startup",
        }
    }
}

/// The external system at fault, when there is one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dependency {
    OneClick,
    NearRpc,
    Goldsky,
    BridgeRpc,
    MpcSigner,
    Telegram,
    Postgres,
    NearBlocks,
    DefiLlama,
}

impl Dependency {
    pub const fn as_str(self) -> &'static str {
        match self {
            Dependency::OneClick => "oneclick",
            Dependency::NearRpc => "near_rpc",
            Dependency::Goldsky => "goldsky",
            Dependency::BridgeRpc => "bridge_rpc",
            Dependency::MpcSigner => "mpc_signer",
            Dependency::Telegram => "telegram",
            Dependency::Postgres => "postgres",
            Dependency::NearBlocks => "nearblocks",
            Dependency::DefiLlama => "defillama",
        }
    }
}

/// Everything Sentry needs about one code, declared in one place.
pub struct EventSpec {
    pub code: &'static str,
    pub priority: Priority,
    pub surface: Surface,
    pub dependency: Option<Dependency>,
    /// Stable message — becomes the Sentry issue title. Never interpolate
    /// per-event data here; that goes in fields on the emitting site.
    pub title: &'static str,
}

impl EventSpec {
    /// `Option` so the tag is simply not recorded when there is no
    /// external dependency (tracing skips `None` values).
    pub fn dependency_str(&self) -> Option<&'static str> {
        self.dependency.map(Dependency::as_str)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    ConfigInvalidCorsOrigin,
    GoldskySinkConnectFailed,
    AlertTelegramSendFailed,
    JobStale,
    FleetStalled,
    VerificationHeadDrift,
    VerificationGateFailed,
    ExchangeTerminalFailed,
    PaymentTerminalFailed,
    ProposalExecutionFailed,
    BulkPayoutStateWriteFailed,
    BulkPayoutFailed,
    DepositAddressFailed,
    TreasuryCreateGaveUp,
    ConfIntentSigParseFailed,
    ConfIntentSubmitFailed,
    ConfIntentMarkFailedLost,
    RelaySubmitFailed,
    RelaySpendRecordFailed,
    // ── p2: distinct alertable failures surfaced by the raw-error migration ──
    ConfJwtRefreshFailed,
    ConfJwtPersistFailed,
    BulkConfSubmitFailed,
    BulkConfDriveFailed,
    ConfIntentLookupFailed,
    StatusMonitorDegraded,
    GoldskyEnrichmentWriteFailed,
    CreditDecrementFailed,
    SubscriptionResetSkipped,
    AuthMembershipCheckFailed,
    // ── p3: coded former raw `tracing::error!` sites (Sentry-only, low signal) ──
    AddressBookFailed,
    BalanceChangesApiFailed,
    HistoryApiFailed,
    UserTreasuriesFailed,
    WarningsApiFailed,
    ProposalTxLookupFailed,
    AnalyticsReadFailed,
    SubscriptionPlanReadFailed,
    ProfileReadFailed,
    MemberInvitesFailed,
    CustomRequestsFailed,
    TreasuryConfigFailed,
    ProposalTemplatesFailed,
    IntentsQuoteFailed,
    SwapStatusFailed,
    SystemStatusFailed,
    ConfBalancesReadFailed,
    ConfGenerateIntentFailed,
    BulkSubmitFailed,
    BulkPrepareFailed,
    TelegramWebhookFailed,
    TreasuryCreateStepFailed,
    ConfSetupStepFailed,
    StorageCreditsReadFailed,
    DaoMarkDirtyFailed,
    TxHashLookupFailed,
    AccountSyncFailed,
    StakingSyncFailed,
    PriceSyncFailed,
    DaoPolicySyncFailed,
    WorkerLoopRestarted,
    JobPlatformDegraded,
    ConfIngestStepFailed,
    ProposalMirrorFailed,
    BulkWorkerReadFailed,
    ConfigInvalidTolerance,
}

impl ErrorCode {
    pub const fn spec(self) -> EventSpec {
        use Dependency as D;
        use ErrorCode as C;
        use Priority as P;
        use Surface as S;
        match self {
            C::ConfigInvalidCorsOrigin => EventSpec {
                code: "CONFIG_INVALID_CORS_ORIGIN",
                priority: P::P0,
                surface: S::Startup,
                dependency: None,
                title: "startup / parse CORS config / invalid origin dropped — that frontend origin is blocked",
            },
            C::GoldskySinkConnectFailed => EventSpec {
                code: "GOLDSKY_SINK_CONNECT_FAILED",
                priority: P::P0,
                surface: S::Startup,
                dependency: Some(D::Goldsky),
                title: "startup / connect Goldsky sink DB / connection failed — enrichment worker disabled, status probe skipped",
            },
            C::AlertTelegramSendFailed => EventSpec {
                code: "ALERT_TELEGRAM_SEND_FAILED",
                priority: P::P2,
                surface: S::BackgroundJob,
                dependency: Some(D::Telegram),
                title: "background job / send ops alert / Telegram send failed — alerting path itself degraded",
            },
            C::JobStale => EventSpec {
                code: "JOB_STALE",
                priority: P::P2,
                surface: S::BackgroundJob,
                dependency: None,
                title: "background job / queue liveness / queue not making progress",
            },
            C::FleetStalled => EventSpec {
                code: "FLEET_STALLED",
                priority: P::P0,
                surface: S::BackgroundJob,
                dependency: None,
                title: "background job / fleet liveness / most queues stalled or DB unreachable — restarting process to recover",
            },
            C::VerificationHeadDrift => EventSpec {
                code: "VERIFICATION_HEAD_DRIFT",
                priority: P::P2,
                surface: S::BackgroundJob,
                dependency: None,
                title: "background job / verify ledger head / native drift beyond tolerance — chart marked stale",
            },
            C::VerificationGateFailed => EventSpec {
                code: "VERIFICATION_GATE_FAILED",
                priority: P::P2,
                surface: S::BackgroundJob,
                dependency: None,
                title: "background job / verify public balances / drift beyond tolerance — chart stays unavailable",
            },
            C::ExchangeTerminalFailed => EventSpec {
                code: "EXCHANGE_TERMINAL_FAILED",
                priority: P::P1,
                surface: S::UserAction,
                dependency: Some(D::OneClick),
                title: "user action / exchange settlement / terminal failed status on 1Click",
            },
            C::PaymentTerminalFailed => EventSpec {
                code: "PAYMENT_TERMINAL_FAILED",
                priority: P::P1,
                surface: S::UserAction,
                dependency: Some(D::OneClick),
                title: "user action / payment settlement / terminal failed status on 1Click",
            },
            C::ProposalExecutionFailed => EventSpec {
                code: "PROPOSAL_EXECUTION_FAILED",
                priority: P::P1,
                surface: S::UserAction,
                dependency: None,
                title: "user action / execute proposal / failed on-chain",
            },
            C::BulkPayoutStateWriteFailed => EventSpec {
                code: "BULK_PAYOUT_STATE_WRITE_FAILED",
                priority: P::P1,
                surface: S::BackgroundJob,
                dependency: Some(D::Postgres),
                title: "background job / bulk payout / failed to mark list completed in pending_payment_lists",
            },
            C::BulkPayoutFailed => EventSpec {
                code: "BULK_PAYOUT_FAILED",
                priority: P::P1,
                surface: S::BackgroundJob,
                dependency: Some(D::NearRpc),
                title: "background job / bulk payout batch / on-chain call failed — retried every tick, no give-up",
            },
            C::DepositAddressFailed => EventSpec {
                code: "DEPOSIT_ADDRESS_FAILED",
                priority: P::P1,
                surface: S::UserAction,
                dependency: Some(D::BridgeRpc),
                title: "user action / get deposit address / bridge returned server error",
            },
            C::TreasuryCreateGaveUp => EventSpec {
                code: "TREASURY_CREATE_GAVE_UP",
                priority: P::P0,
                surface: S::UserAction,
                dependency: None,
                title: "user action / create treasury / sweeper gave up after max attempts — treasury half-created",
            },
            C::ConfIntentSigParseFailed => EventSpec {
                code: "CONF_INTENT_SIG_PARSE_FAILED",
                priority: P::P0,
                surface: S::UserAction,
                dependency: Some(D::MpcSigner),
                title: "user action / confidential transfer / MPC signature unparseable — intent stuck pending, code fix required",
            },
            C::ConfIntentSubmitFailed => EventSpec {
                code: "CONF_INTENT_SUBMIT_FAILED",
                priority: P::P0,
                surface: S::UserAction,
                dependency: Some(D::OneClick),
                title: "user action / confidential transfer / 1Click submit failed after approved vote",
            },
            C::ConfIntentMarkFailedLost => EventSpec {
                code: "CONF_INTENT_MARK_FAILED_LOST",
                priority: P::P1,
                surface: S::UserAction,
                dependency: Some(D::Postgres),
                title: "user action / confidential transfer / failed-status write lost ",
            },
            C::RelaySubmitFailed => EventSpec {
                code: "RELAY_SUBMIT_FAILED",
                priority: P::P1,
                surface: S::UserAction,
                dependency: Some(D::NearRpc),
                title: "user action / relay submit / server error on sponsor path — proposal creation or vote failed visibly",
            },
            C::RelaySpendRecordFailed => EventSpec {
                code: "RELAY_SPEND_RECORD_FAILED",
                priority: P::P2,
                surface: S::BackgroundJob,
                dependency: Some(D::Postgres),
                title: "background job / record relay spend / DB write failed",
            },
            C::ConfJwtRefreshFailed => EventSpec {
                code: "CONF_JWT_REFRESH_FAILED",
                priority: P::P2,
                surface: S::UserAction,
                dependency: Some(D::OneClick),
                title: "user action / confidential auth / JWT refresh failed",
            },
            C::ConfJwtPersistFailed => EventSpec {
                code: "CONF_JWT_PERSIST_FAILED",
                priority: P::P2,
                surface: S::BackgroundJob,
                dependency: Some(D::Postgres),
                title: "background job / confidential auth / refreshed JWT could not be persisted",
            },
            C::BulkConfSubmitFailed => EventSpec {
                code: "BULK_CONF_SUBMIT_FAILED",
                priority: P::P2,
                surface: S::UserAction,
                dependency: Some(D::OneClick),
                title: "user action / confidential bulk payment / 1Click submit failed",
            },
            C::BulkConfDriveFailed => EventSpec {
                code: "BULK_CONF_DRIVE_FAILED",
                priority: P::P2,
                surface: S::BackgroundJob,
                dependency: None,
                title: "background job / confidential bulk payment / state machine step failed",
            },
            C::ConfIntentLookupFailed => EventSpec {
                code: "CONF_INTENT_LOOKUP_FAILED",
                priority: P::P2,
                surface: S::UserAction,
                dependency: None,
                title: "user action / confidential transfer / pending intent lookup failed — auto-submit blocked",
            },
            C::StatusMonitorDegraded => EventSpec {
                code: "STATUS_MONITOR_DEGRADED",
                priority: P::P2,
                surface: S::BackgroundJob,
                dependency: Some(D::Postgres),
                title: "background job / status monitor / operation failed — outage detection degraded",
            },
            C::GoldskyEnrichmentWriteFailed => EventSpec {
                code: "GOLDSKY_ENRICHMENT_WRITE_FAILED",
                priority: P::P2,
                surface: S::BackgroundJob,
                dependency: Some(D::Postgres),
                title: "background job / goldsky enrichment / write failed",
            },
            C::CreditDecrementFailed => EventSpec {
                code: "CREDIT_DECREMENT_FAILED",
                priority: P::P2,
                surface: S::BackgroundJob,
                dependency: Some(D::Postgres),
                title: "background job / consume payment credits / DB write failed — credit not charged",
            },
            C::SubscriptionResetSkipped => EventSpec {
                code: "SUBSCRIPTION_RESET_SKIPPED",
                priority: P::P2,
                surface: S::BackgroundJob,
                dependency: None,
                title: "background job / subscription reset / skipped DAO with unknown plan type",
            },
            C::AuthMembershipCheckFailed => EventSpec {
                code: "AUTH_MEMBERSHIP_CHECK_FAILED",
                priority: P::P2,
                surface: S::UserAction,
                dependency: Some(D::NearRpc),
                title: "user action / authorize member / on-chain membership check failed",
            },
            C::AddressBookFailed => EventSpec {
                code: "ADDRESS_BOOK_FAILED",
                priority: P::P3,
                surface: S::UserRead,
                dependency: Some(D::Postgres),
                title: "user read / address book / operation failed",
            },
            C::BalanceChangesApiFailed => EventSpec {
                code: "BALANCE_CHANGES_API_FAILED",
                priority: P::P3,
                surface: S::UserRead,
                dependency: None,
                title: "user read / balance changes / query failed",
            },
            C::HistoryApiFailed => EventSpec {
                code: "HISTORY_API_FAILED",
                priority: P::P3,
                surface: S::UserRead,
                dependency: None,
                title: "user read / history / query failed",
            },
            C::UserTreasuriesFailed => EventSpec {
                code: "USER_TREASURIES_FAILED",
                priority: P::P3,
                surface: S::UserAction,
                dependency: Some(D::Postgres),
                title: "user action / saved treasuries / DB operation failed",
            },
            C::WarningsApiFailed => EventSpec {
                code: "WARNINGS_API_FAILED",
                priority: P::P3,
                surface: S::UserRead,
                dependency: Some(D::Postgres),
                title: "user read / warnings / operation failed",
            },
            C::ProposalTxLookupFailed => EventSpec {
                code: "PROPOSAL_TX_LOOKUP_FAILED",
                priority: P::P3,
                surface: S::UserRead,
                dependency: Some(D::NearBlocks),
                title: "user read / proposal tx lookup / NearBlocks request failed",
            },
            C::AnalyticsReadFailed => EventSpec {
                code: "ANALYTICS_READ_FAILED",
                priority: P::P3,
                surface: S::UserRead,
                dependency: Some(D::Postgres),
                title: "user read / analytics / query failed",
            },
            C::SubscriptionPlanReadFailed => EventSpec {
                code: "SUBSCRIPTION_PLAN_READ_FAILED",
                priority: P::P3,
                surface: S::UserRead,
                dependency: None,
                title: "user read / subscription plans / query failed",
            },
            C::ProfileReadFailed => EventSpec {
                code: "PROFILE_READ_FAILED",
                priority: P::P3,
                surface: S::UserRead,
                dependency: Some(D::Postgres),
                title: "user read / profile / query failed",
            },
            C::MemberInvitesFailed => EventSpec {
                code: "MEMBER_INVITES_FAILED",
                priority: P::P3,
                surface: S::UserAction,
                dependency: Some(D::Postgres),
                title: "user action / member invites / operation failed",
            },
            C::CustomRequestsFailed => EventSpec {
                code: "CUSTOM_REQUESTS_FAILED",
                priority: P::P3,
                surface: S::UserAction,
                dependency: Some(D::Postgres),
                title: "user action / custom requests / operation failed",
            },
            C::TreasuryConfigFailed => EventSpec {
                code: "TREASURY_CONFIG_FAILED",
                priority: P::P3,
                surface: S::UserAction,
                dependency: Some(D::Postgres),
                title: "user action / treasury config / operation failed",
            },
            C::ProposalTemplatesFailed => EventSpec {
                code: "PROPOSAL_TEMPLATES_FAILED",
                priority: P::P3,
                surface: S::UserAction,
                dependency: Some(D::Postgres),
                title: "user action / proposal templates / operation failed",
            },
            C::IntentsQuoteFailed => EventSpec {
                code: "INTENTS_QUOTE_FAILED",
                priority: P::P3,
                surface: S::UserRead,
                dependency: Some(D::OneClick),
                title: "user read / get quote / 1Click call failed",
            },
            C::SwapStatusFailed => EventSpec {
                code: "SWAP_STATUS_FAILED",
                priority: P::P3,
                surface: S::UserRead,
                dependency: Some(D::OneClick),
                title: "user read / swap status / 1Click call failed",
            },
            C::SystemStatusFailed => EventSpec {
                code: "SYSTEM_STATUS_FAILED",
                priority: P::P3,
                surface: S::UserRead,
                dependency: None,
                title: "user read / system status / upstream status API failed",
            },
            C::ConfBalancesReadFailed => EventSpec {
                code: "CONF_BALANCES_READ_FAILED",
                priority: P::P3,
                surface: S::UserRead,
                dependency: Some(D::OneClick),
                title: "user read / confidential balances / 1Click call failed",
            },
            C::ConfGenerateIntentFailed => EventSpec {
                code: "CONF_GENERATE_INTENT_FAILED",
                priority: P::P3,
                surface: S::UserAction,
                dependency: Some(D::OneClick),
                title: "user action / generate confidential intent / 1Click call failed",
            },
            C::BulkSubmitFailed => EventSpec {
                code: "BULK_SUBMIT_FAILED",
                priority: P::P3,
                surface: S::UserAction,
                dependency: Some(D::NearRpc),
                title: "user action / bulk payment submit / operation failed",
            },
            C::BulkPrepareFailed => EventSpec {
                code: "BULK_PREPARE_FAILED",
                priority: P::P3,
                surface: S::UserRead,
                dependency: Some(D::Postgres),
                title: "user read / bulk payment prepare / query failed",
            },
            C::TelegramWebhookFailed => EventSpec {
                code: "TELEGRAM_WEBHOOK_FAILED",
                priority: P::P3,
                surface: S::UserAction,
                dependency: Some(D::Telegram),
                title: "user action / telegram connect / operation failed",
            },
            C::TreasuryCreateStepFailed => EventSpec {
                code: "TREASURY_CREATE_STEP_FAILED",
                priority: P::P3,
                surface: S::UserAction,
                dependency: Some(D::NearRpc),
                title: "user action / create treasury / step failed — sweeper retries",
            },
            C::ConfSetupStepFailed => EventSpec {
                code: "CONF_SETUP_STEP_FAILED",
                priority: P::P3,
                surface: S::UserAction,
                dependency: Some(D::NearRpc),
                title: "user action / confidential setup / on-chain step failed",
            },
            C::StorageCreditsReadFailed => EventSpec {
                code: "STORAGE_CREDITS_READ_FAILED",
                priority: P::P3,
                surface: S::UserRead,
                dependency: Some(D::Postgres),
                title: "user read / storage credits / query failed",
            },
            C::DaoMarkDirtyFailed => EventSpec {
                code: "DAO_MARK_DIRTY_FAILED",
                priority: P::P3,
                surface: S::BackgroundJob,
                dependency: Some(D::Postgres),
                title: "background job / mark DAO dirty / DB write failed",
            },
            C::TxHashLookupFailed => EventSpec {
                code: "TX_HASH_LOOKUP_FAILED",
                priority: P::P3,
                surface: S::BackgroundJob,
                dependency: Some(D::NearRpc),
                title: "background job / tx hash lookup / RPC query failed",
            },
            C::AccountSyncFailed => EventSpec {
                code: "ACCOUNT_SYNC_FAILED",
                priority: P::P3,
                surface: S::BackgroundJob,
                dependency: None,
                title: "background job / account sync / cycle step failed",
            },
            C::StakingSyncFailed => EventSpec {
                code: "STAKING_SYNC_FAILED",
                priority: P::P3,
                surface: S::BackgroundJob,
                dependency: None,
                title: "background job / staking sync / gap fill failed",
            },
            C::PriceSyncFailed => EventSpec {
                code: "PRICE_SYNC_FAILED",
                priority: P::P3,
                surface: S::BackgroundJob,
                dependency: Some(D::DefiLlama),
                title: "background job / price sync / refresh failed",
            },
            C::DaoPolicySyncFailed => EventSpec {
                code: "DAO_POLICY_SYNC_FAILED",
                priority: P::P3,
                surface: S::BackgroundJob,
                dependency: Some(D::Postgres),
                title: "background job / dao policy sync / DB write failed",
            },
            C::WorkerLoopRestarted => EventSpec {
                code: "WORKER_LOOP_RESTARTED",
                priority: P::P3,
                surface: S::BackgroundJob,
                dependency: None,
                title: "background job / worker loop / crashed and restarting",
            },
            C::JobPlatformDegraded => EventSpec {
                code: "JOB_PLATFORM_DEGRADED",
                priority: P::P3,
                surface: S::BackgroundJob,
                dependency: Some(D::Postgres),
                title: "background job / job platform / infrastructure operation failed",
            },
            C::ConfIngestStepFailed => EventSpec {
                code: "CONF_INGEST_STEP_FAILED",
                priority: P::P3,
                surface: S::BackgroundJob,
                dependency: Some(D::OneClick),
                title: "background job / confidential ingest / step failed",
            },
            C::ProposalMirrorFailed => EventSpec {
                code: "PROPOSAL_MIRROR_FAILED",
                priority: P::P3,
                surface: S::BackgroundJob,
                dependency: Some(D::Postgres),
                title: "background job / proposal mirror / confidential mirror write failed",
            },
            C::BulkWorkerReadFailed => EventSpec {
                code: "BULK_WORKER_READ_FAILED",
                priority: P::P3,
                surface: S::BackgroundJob,
                dependency: Some(D::NearRpc),
                title: "background job / bulk payout / on-chain list view failed",
            },
            C::ConfigInvalidTolerance => EventSpec {
                code: "CONFIG_INVALID_TOLERANCE",
                priority: P::P3,
                surface: S::Startup,
                dependency: None,
                title: "startup / parse verification tolerance / invalid value — using zero",
            },
        }
    }

    pub const ALL: &'static [ErrorCode] = &[
        ErrorCode::ConfigInvalidCorsOrigin,
        ErrorCode::GoldskySinkConnectFailed,
        ErrorCode::AlertTelegramSendFailed,
        ErrorCode::JobStale,
        ErrorCode::FleetStalled,
        ErrorCode::VerificationHeadDrift,
        ErrorCode::VerificationGateFailed,
        ErrorCode::ExchangeTerminalFailed,
        ErrorCode::PaymentTerminalFailed,
        ErrorCode::ProposalExecutionFailed,
        ErrorCode::BulkPayoutStateWriteFailed,
        ErrorCode::BulkPayoutFailed,
        ErrorCode::DepositAddressFailed,
        ErrorCode::TreasuryCreateGaveUp,
        ErrorCode::ConfIntentSigParseFailed,
        ErrorCode::ConfIntentSubmitFailed,
        ErrorCode::ConfIntentMarkFailedLost,
        ErrorCode::RelaySubmitFailed,
        ErrorCode::RelaySpendRecordFailed,
        ErrorCode::ConfJwtRefreshFailed,
        ErrorCode::ConfJwtPersistFailed,
        ErrorCode::BulkConfSubmitFailed,
        ErrorCode::BulkConfDriveFailed,
        ErrorCode::ConfIntentLookupFailed,
        ErrorCode::StatusMonitorDegraded,
        ErrorCode::GoldskyEnrichmentWriteFailed,
        ErrorCode::CreditDecrementFailed,
        ErrorCode::SubscriptionResetSkipped,
        ErrorCode::AuthMembershipCheckFailed,
        ErrorCode::AddressBookFailed,
        ErrorCode::BalanceChangesApiFailed,
        ErrorCode::HistoryApiFailed,
        ErrorCode::UserTreasuriesFailed,
        ErrorCode::WarningsApiFailed,
        ErrorCode::ProposalTxLookupFailed,
        ErrorCode::AnalyticsReadFailed,
        ErrorCode::SubscriptionPlanReadFailed,
        ErrorCode::ProfileReadFailed,
        ErrorCode::MemberInvitesFailed,
        ErrorCode::CustomRequestsFailed,
        ErrorCode::TreasuryConfigFailed,
        ErrorCode::ProposalTemplatesFailed,
        ErrorCode::IntentsQuoteFailed,
        ErrorCode::SwapStatusFailed,
        ErrorCode::SystemStatusFailed,
        ErrorCode::ConfBalancesReadFailed,
        ErrorCode::ConfGenerateIntentFailed,
        ErrorCode::BulkSubmitFailed,
        ErrorCode::BulkPrepareFailed,
        ErrorCode::TelegramWebhookFailed,
        ErrorCode::TreasuryCreateStepFailed,
        ErrorCode::ConfSetupStepFailed,
        ErrorCode::StorageCreditsReadFailed,
        ErrorCode::DaoMarkDirtyFailed,
        ErrorCode::TxHashLookupFailed,
        ErrorCode::AccountSyncFailed,
        ErrorCode::StakingSyncFailed,
        ErrorCode::PriceSyncFailed,
        ErrorCode::DaoPolicySyncFailed,
        ErrorCode::WorkerLoopRestarted,
        ErrorCode::JobPlatformDegraded,
        ErrorCode::ConfIngestStepFailed,
        ErrorCode::ProposalMirrorFailed,
        ErrorCode::BulkWorkerReadFailed,
        ErrorCode::ConfigInvalidTolerance,
    ];
}

/// Emit one alertable error event at ERROR level (→ Sentry via the tracing
/// bridge). All routing tags come from the code's [`EventSpec`]; pass only
/// per-event fields, exactly like `tracing::error!` fields:
///
/// ```ignore
/// error_event!(ErrorCode::ConfIntentSubmitFailed, treasury_id, error = %err);
/// error_event!(code); // no extra fields
/// ```
#[macro_export]
macro_rules! error_event {
    ($code:expr) => {{
        let __spec = $crate::error_event::ErrorCode::spec($code);
        ::tracing::error!(
            tags.error_code = __spec.code,
            tags.alert_priority = __spec.priority.as_str(),
            tags.surface = __spec.surface.as_str(),
            tags.dependency = __spec.dependency_str(),
            "{}",
            __spec.title
        );
    }};
    ($code:expr, $($fields:tt)+) => {{
        let __spec = $crate::error_event::ErrorCode::spec($code);
        ::tracing::error!(
            tags.error_code = __spec.code,
            tags.alert_priority = __spec.priority.as_str(),
            tags.surface = __spec.surface.as_str(),
            tags.dependency = __spec.dependency_str(),
            $($fields)+,
            "{}",
            __spec.title
        );
    }};
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn code_strings_are_unique_and_screaming_snake() {
        let mut seen = HashSet::new();
        for code in ErrorCode::ALL {
            let spec = code.spec();
            assert!(seen.insert(spec.code), "duplicate code {}", spec.code);
            assert!(
                spec.code
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'),
                "{} is not SCREAMING_SNAKE_CASE",
                spec.code
            );
        }
        assert_eq!(seen.len(), ErrorCode::ALL.len());
    }

    #[test]
    fn titles_start_with_their_surface() {
        for code in ErrorCode::ALL {
            let spec = code.spec();
            let prefix = match spec.surface {
                Surface::UserAction => "user action / ",
                Surface::UserRead => "user read / ",
                Surface::BackgroundJob => "background job / ",
                Surface::Startup => "startup / ",
            };
            assert!(
                spec.title.starts_with(prefix),
                "{}: title {:?} does not start with {:?}",
                spec.code,
                spec.title,
                prefix
            );
        }
    }

    #[test]
    fn titles_follow_surface_flow_cause_shape() {
        for code in ErrorCode::ALL {
            let spec = code.spec();
            assert!(
                spec.title.matches(" / ").count() >= 2,
                "{}: title {:?} is missing the surface / flow / cause segments",
                spec.code,
                spec.title
            );
        }
    }
}
