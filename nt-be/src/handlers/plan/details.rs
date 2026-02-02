use crate::AppState;
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Deserialize)]
pub struct PlanDetailsQuery {
    pub treasury_id: String,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PlanType {
    Trial,
    Plus,
    Pro,
    Custom,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PlanPeriod {
    Trial,
    Month,
}

#[derive(Debug, Serialize)]
pub struct PlanDetailsResponse {
    pub plan_type: PlanType,
    pub batch_payment_credit_limit: Option<i32>, // None for unlimited
    pub period: PlanPeriod,
}

/// Get plan details for a treasury's subscription
/// Returns the plan type, credit limits for various features, and period information
/// Currently uses dummy data - plan field will be added to DB later
pub async fn get_plan_details(
    State(_state): State<Arc<AppState>>,
    Query(query): Query<PlanDetailsQuery>,
) -> Result<Json<PlanDetailsResponse>, StatusCode> {
    // TODO: Fetch plan from database once the field is added
    // For now, return dummy data based on treasury_id pattern for testing

    // Dummy logic to demonstrate different plan types
    // In production, this will be fetched from monitored_accounts table
    let plan_details = get_dummy_plan_details(&query.treasury_id);

    log::info!(
        "Plan details for treasury {}: {:?}",
        query.treasury_id,
        plan_details
    );

    Ok(Json(plan_details))
}

/// Returns dummy plan details for testing
pub fn get_dummy_plan_details(_treasury_id: &str) -> PlanDetailsResponse {
    // manually change this to test different plans
    // Trial plan
    PlanDetailsResponse {
        plan_type: PlanType::Trial,
        batch_payment_credit_limit: Some(5),
        period: PlanPeriod::Trial,
    }

    // PlanDetailsResponse {
    //     plan_type: PlanType::Pro,
    //     batch_payment_credit_limit: Some(100),
    //     period: PlanPeriod::Month,
    // }

    // Plus plan
    // PlanDetailsResponse {
    //     plan_type: PlanType::Plus,
    //     batch_payment_credit_limit: Some(10),
    //     period: PlanPeriod::Month,
    // }

    // Custom/Unlimited plan (None = unlimited)
    // PlanDetailsResponse {
    //     plan_type: PlanType::Custom,
    //     batch_payment_credit_limit: None,
    //     period: PlanPeriod::Month,
    // }
}
