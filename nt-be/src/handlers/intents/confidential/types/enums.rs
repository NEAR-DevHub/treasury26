use std::fmt;
use std::str::FromStr;

/// 1Click history row status stored in bronze (`status` column).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryStatus {
    Success,
    Other,
}

impl HistoryStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            HistoryStatus::Success => "SUCCESS",
            HistoryStatus::Other => "OTHER",
        }
    }

    pub fn parse(value: &str) -> Self {
        if value.eq_ignore_ascii_case("SUCCESS") {
            HistoryStatus::Success
        } else {
            HistoryStatus::Other
        }
    }
}

/// Bronze `deposit_type` values we care about at projection boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DepositType {
    ConfidentialIntents,
    Intents,
    Other,
}

impl DepositType {
    pub fn parse(value: &str) -> Self {
        if value.eq_ignore_ascii_case("CONFIDENTIAL_INTENTS") {
            DepositType::ConfidentialIntents
        } else if value.eq_ignore_ascii_case("INTENTS") {
            DepositType::Intents
        } else {
            DepositType::Other
        }
    }
}

/// Gold `transaction_type` column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, sqlx::Type)]
#[sqlx(type_name = "confidential_transaction_type", rename_all = "lowercase")]
pub enum ConfidentialTxType {
    Sent,
    Exchange,
    Deposit,
}

impl ConfidentialTxType {
    pub fn as_str(self) -> &'static str {
        match self {
            ConfidentialTxType::Sent => "sent",
            ConfidentialTxType::Exchange => "exchange",
            ConfidentialTxType::Deposit => "deposit",
        }
    }
}

impl FromStr for ConfidentialTxType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "sent" => Ok(ConfidentialTxType::Sent),
            "exchange" => Ok(ConfidentialTxType::Exchange),
            "deposit" => Ok(ConfidentialTxType::Deposit),
            other => Err(format!("unknown confidential transaction type: {other}")),
        }
    }
}

impl fmt::Display for ConfidentialTxType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Provenance of a confidential deposit amount correction
/// (`confidential_deposit_amount_corrections.source`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type)]
#[sqlx(
    type_name = "confidential_deposit_correction_source",
    rename_all = "snake_case"
)]
pub enum ConfidentialDepositCorrectionSource {
    /// Forward path: live 1Click balance diff at ingest time.
    LiveFetch,
    /// Backfill path: poller-recorded `balance_changes` deposit leg.
    BalanceChanges,
}

impl ConfidentialDepositCorrectionSource {
    pub fn as_str(self) -> &'static str {
        match self {
            ConfidentialDepositCorrectionSource::LiveFetch => "live_fetch",
            ConfidentialDepositCorrectionSource::BalanceChanges => "balance_changes",
        }
    }
}

impl FromStr for ConfidentialDepositCorrectionSource {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "live_fetch" => Ok(ConfidentialDepositCorrectionSource::LiveFetch),
            "balance_changes" => Ok(ConfidentialDepositCorrectionSource::BalanceChanges),
            other => Err(format!(
                "unknown confidential deposit correction source: {other}"
            )),
        }
    }
}

impl fmt::Display for ConfidentialDepositCorrectionSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 1Click `recipientType` / `refundType` values controlling address chain namespace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecipientAddressType {
    Intents,
    ConfidentialIntents,
    OriginChain,
    DestinationChain,
    Other,
}

impl RecipientAddressType {
    pub fn parse(value: &str) -> Self {
        if value.eq_ignore_ascii_case("INTENTS") {
            RecipientAddressType::Intents
        } else if value.eq_ignore_ascii_case("CONFIDENTIAL_INTENTS") {
            RecipientAddressType::ConfidentialIntents
        } else if value.eq_ignore_ascii_case("ORIGIN_CHAIN") {
            RecipientAddressType::OriginChain
        } else if value.eq_ignore_ascii_case("DESTINATION_CHAIN") {
            RecipientAddressType::DestinationChain
        } else {
            RecipientAddressType::Other
        }
    }
}
