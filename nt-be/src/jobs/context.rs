use std::sync::Arc;

use crate::AppState;

#[derive(Clone)]
pub struct JobContext {
    pub state: Arc<AppState>,
}

impl JobContext {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }
}
