use std::collections::HashMap;

use bigdecimal::BigDecimal;

use super::classify::project_row;
use super::models::{BronzeRow, ConfidentialDepositCorrectionIndex, GoldHistoryEvent};

/// Project a bronze suffix row into a gold history event using ledger replay.
pub(crate) fn bronze_to_gold(
    row: &BronzeRow,
    ledger: &mut HashMap<String, BigDecimal>,
    corrections: &ConfidentialDepositCorrectionIndex,
) -> Result<Option<GoldHistoryEvent>, String> {
    project_row(row, ledger, corrections)
}
