mod config;
pub mod fallbacks;
pub mod incidents;
pub mod monitor;
pub mod notifications;
pub mod oh_dear;

pub use monitor::run_status_monitor_loop;
pub use oh_dear::get_status;
