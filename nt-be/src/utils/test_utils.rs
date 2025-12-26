//! Test utilities for balance change tests
//!
//! Provides common setup functions used across multiple test modules.

#[cfg(test)]
use crate::AppState;

/// Load environment files in the correct order for tests
///
/// Loads .env files from multiple locations to ensure all required
/// environment variables are available for integration tests.
#[cfg(test)]
pub fn load_test_env() {
    dotenvy::from_filename(".env").ok();
    dotenvy::from_filename(".env.test").ok();
    dotenvy::from_filename("../.env").ok();
}

/// Initialize app state with loaded environment variables
///
/// This is a convenience function that loads environment files
/// and initializes the AppState for use in tests.
#[cfg(test)]
pub async fn init_test_state() -> AppState {
    load_test_env();
    crate::init_app_state()
        .await
        .expect("Failed to initialize app state")
}
