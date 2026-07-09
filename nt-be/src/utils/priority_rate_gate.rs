//! Priority admission gate layered over a shared [`RateLimiter`].
//!
//! A single [`RateLimiter`] caps every caller against one budget but serves
//! waiters in arbitrary order, so bulk low-priority work can crowd out
//! latency-sensitive work that draws on the same budget. This gate fixes the
//! ordering without splitting the budget: a background driver owns the limiter,
//! draws a permit *only when a waiter exists* (so nothing is wasted while idle),
//! and hands each permit to the highest-priority waiter present at the moment
//! the permit lands (so a higher-priority request that arrives mid-wait still
//! preempts a lower-priority one queued first).
//!
//! The gate is generic over a consumer-supplied [`GatePriority`] enum, mirroring
//! how [`RateLimiter`] is a generic building block — no consumer semantics leak
//! into the util.
//!
//! ```no_run
//! use nt_be::utils::priority_rate_gate::{GatePriority, PriorityRateGate};
//! use nt_be::utils::rate_limiter::RateLimiter;
//!
//! #[derive(Clone, Copy)]
//! enum Priority {
//!     Urgent,
//!     Bulk,
//! }
//!
//! impl GatePriority for Priority {
//!     fn lanes() -> usize {
//!         2
//!     }
//!     fn lane(self) -> usize {
//!         match self {
//!             Priority::Urgent => 0,
//!             Priority::Bulk => 1,
//!         }
//!     }
//! }
//!
//! # async fn demo() {
//! let limiter = RateLimiter::per_minute("api", 10, 10);
//! let (gate, driver) = PriorityRateGate::<Priority>::new(limiter);
//! tokio::spawn(driver.run());
//!
//! gate.acquire(Priority::Urgent).await; // served before any Bulk waiter
//! // ... make the rate-limited call ...
//! # }
//! ```

use std::collections::VecDeque;
use std::marker::PhantomData;

use tokio::sync::{mpsc, oneshot};

use crate::utils::rate_limiter::RateLimiter;

/// Implemented by a consumer's own priority enum. Lane 0 = highest priority.
pub trait GatePriority: Copy + Send + 'static {
    /// Total number of priority lanes (> 0). Same for every value of the type.
    fn lanes() -> usize;
    /// Which lane this value maps to; 0 is served first.
    fn lane(self) -> usize;
}

struct Ticket {
    lane: usize,
    responder: oneshot::Sender<()>,
}

/// Cheaply-cloneable handle used to request a permit at a given priority.
///
/// Place a single gate on shared state (e.g. `AppState`) so every caller draws
/// on one budget; clone it freely across tasks.
#[derive(Clone)]
pub struct PriorityRateGate<P: GatePriority> {
    tx: mpsc::UnboundedSender<Ticket>,
    // Keeps the gate type-safe and `Clone` without owning a `P`.
    _marker: PhantomData<fn(P)>,
}

/// Owns the limiter and dispatches permits. Spawn its [`run`](Self::run) once.
pub struct PriorityRateGateDriver {
    limiter: RateLimiter,
    rx: mpsc::UnboundedReceiver<Ticket>,
    // One FIFO queue per priority lane; `lanes[0]` is served first.
    lanes: Vec<VecDeque<oneshot::Sender<()>>>,
}

impl<P: GatePriority> PriorityRateGate<P> {
    /// Build a gate/driver pair. The gate is cheap to clone onto shared state;
    /// the driver must be spawned exactly once (`tokio::spawn(driver.run())`).
    pub fn new(limiter: RateLimiter) -> (Self, PriorityRateGateDriver) {
        let (tx, rx) = mpsc::unbounded_channel();
        let lanes = (0..P::lanes().max(1)).map(|_| VecDeque::new()).collect();
        (
            Self {
                tx,
                _marker: PhantomData,
            },
            PriorityRateGateDriver { limiter, rx, lanes },
        )
    }

    /// Wait for a permit at the given priority, then return.
    ///
    /// Fails open: if the driver isn't running (e.g. a test that never spawned
    /// it, or shutdown), this returns immediately rather than hanging.
    pub async fn acquire(&self, priority: P) {
        let (resp_tx, resp_rx) = oneshot::channel();
        let ticket = Ticket {
            lane: priority.lane(),
            responder: resp_tx,
        };
        if self.tx.send(ticket).is_err() {
            return; // driver gone → fail open
        }
        let _ = resp_rx.await; // driver dropped responder → fail open
    }
}

impl PriorityRateGateDriver {
    /// Run the dispatch loop until every gate handle is dropped.
    pub async fn run(mut self) {
        // Cloning shares the same GCRA bucket, so acquiring on this handle draws
        // on the same budget while keeping `self` free to mutate the lanes.
        let limiter = self.limiter.clone();

        loop {
            self.drain();

            // No waiter → block for one. Crucially we do NOT touch the limiter
            // while idle, so no permit is consumed against the budget.
            if self.is_empty() {
                match self.rx.recv().await {
                    Some(ticket) => self.enqueue(ticket),
                    None => return, // all gate handles dropped → shut down
                }
            }

            // A waiter exists: acquire one permit, folding any tickets that
            // arrive mid-wait into their lanes. Re-poll the SAME acquire future
            // across arrivals so we never drop/restart it and desync the GCRA cell.
            let acquire = limiter.acquire();
            tokio::pin!(acquire);
            loop {
                tokio::select! {
                    biased;
                    _ = &mut acquire => break,
                    maybe = self.rx.recv() => match maybe {
                        Some(ticket) => self.enqueue(ticket),
                        None => {
                            // Senders gone, but a permit is on its way and we
                            // still have waiters: honor it, then dispatch below.
                            (&mut acquire).await;
                            break;
                        }
                    },
                }
            }

            self.dispatch_one();
        }
    }

    /// Move any queued tickets into their lanes without blocking.
    fn drain(&mut self) {
        while let Ok(ticket) = self.rx.try_recv() {
            self.enqueue(ticket);
        }
    }

    fn enqueue(&mut self, ticket: Ticket) {
        // The `GatePriority` contract guarantees `lane < lanes`, but clamp
        // defensively so a buggy impl can't panic the driver.
        let lane = ticket.lane.min(self.lanes.len() - 1);
        self.lanes[lane].push_back(ticket.responder);
    }

    fn is_empty(&self) -> bool {
        self.lanes.iter().all(VecDeque::is_empty)
    }

    /// Hand the permit to the highest-priority live waiter, skipping any whose
    /// caller future was dropped so the permit isn't wasted on a dead waiter.
    fn dispatch_one(&mut self) {
        for lane in &mut self.lanes {
            while let Some(responder) = lane.pop_front() {
                if responder.send(()).is_ok() {
                    return;
                }
            }
        }
        // No live waiter at all (rare: every waiter cancelled) → permit is lost.
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    use super::*;

    #[derive(Clone, Copy)]
    enum TestPriority {
        High,
        Low,
    }

    impl GatePriority for TestPriority {
        fn lanes() -> usize {
            2
        }
        fn lane(self) -> usize {
            match self {
                Self::High => 0,
                Self::Low => 1,
            }
        }
    }

    /// Poll `check` until true or the timeout elapses; panics with `msg` on timeout.
    async fn wait_until(msg: &str, timeout: Duration, check: impl Fn() -> bool) {
        tokio::time::timeout(timeout, async {
            while !check() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{msg}"));
    }

    // A high-priority request wins the next permit even when it is queued AFTER
    // several low-priority ones (covers both "high preempts low" and the
    // late-arriving-high preempt property).
    #[tokio::test]
    async fn high_lane_preempts_low_lane() {
        // Burst 1, ~1 permit/sec: drain the burst so the driver must wait for a
        // refill, giving every ticket time to land in its lane before dispatch.
        let limiter = RateLimiter::per_second("preempt-test", 1);
        assert!(limiter.try_acquire(), "drain the initial burst permit");
        let (gate, driver) = PriorityRateGate::<TestPriority>::new(limiter);
        tokio::spawn(driver.run());

        let order = Arc::new(std::sync::Mutex::new(Vec::<&'static str>::new()));

        for _ in 0..3 {
            let gate = gate.clone();
            let order = order.clone();
            tokio::spawn(async move {
                gate.acquire(TestPriority::Low).await;
                order.lock().unwrap().push("low");
            });
        }
        // Let the low waiters register, then enqueue the high waiter late.
        tokio::time::sleep(Duration::from_millis(100)).await;
        {
            let gate = gate.clone();
            let order = order.clone();
            tokio::spawn(async move {
                gate.acquire(TestPriority::High).await;
                order.lock().unwrap().push("high");
            });
        }

        wait_until(
            "some waiter should be served within the timeout",
            Duration::from_secs(4),
            || !order.lock().unwrap().is_empty(),
        )
        .await;

        assert_eq!(
            order.lock().unwrap().first().copied(),
            Some("high"),
            "high-priority waiter must be served before any low-priority waiter"
        );
    }

    // With only low-priority work present it receives 100% of the budget.
    #[tokio::test]
    async fn only_low_lane_uses_full_budget() {
        let limiter = RateLimiter::per_second("work-conserving-test", 1);
        let (gate, driver) = PriorityRateGate::<TestPriority>::new(limiter);
        tokio::spawn(driver.run());

        let done = Arc::new(AtomicUsize::new(0));
        for _ in 0..3 {
            let gate = gate.clone();
            let done = done.clone();
            tokio::spawn(async move {
                gate.acquire(TestPriority::Low).await;
                done.fetch_add(1, Ordering::SeqCst);
            });
        }

        // 1 permit from the burst + 2 refills (~1s each) ≈ 2s.
        wait_until(
            "all low-lane waiters complete when nothing competes",
            Duration::from_secs(5),
            || done.load(Ordering::SeqCst) == 3,
        )
        .await;
    }

    // An idle driver must not draw permits: with a burst of 1 and a 1/min refill,
    // the first request after a long idle is served instantly from the still-intact
    // burst permit. If the driver had consumed permits while idle, this would block.
    #[tokio::test]
    async fn idle_driver_draws_no_permit() {
        let limiter = RateLimiter::per_minute("idle-test", 1, 1);
        let (gate, driver) = PriorityRateGate::<TestPriority>::new(limiter);
        tokio::spawn(driver.run());

        tokio::time::sleep(Duration::from_millis(500)).await;

        tokio::time::timeout(Duration::from_secs(2), gate.acquire(TestPriority::Low))
            .await
            .expect("first request after idle is served immediately (no permit drawn on idle)");
    }

    // A permit isn't wasted on a waiter whose future was dropped: the driver
    // skips the dead high waiter and hands the single permit to the live low one.
    #[tokio::test]
    async fn cancelled_waiter_wastes_no_permit() {
        let limiter = RateLimiter::per_second("cancel-test", 1);
        assert!(limiter.try_acquire(), "drain the initial burst permit");
        let (gate, driver) = PriorityRateGate::<TestPriority>::new(limiter);
        tokio::spawn(driver.run());

        // High waiter registers, then is cancelled before the permit lands.
        let high = {
            let gate = gate.clone();
            tokio::spawn(async move { gate.acquire(TestPriority::High).await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        high.abort();

        let low_done = Arc::new(AtomicBool::new(false));
        {
            let gate = gate.clone();
            let low_done = low_done.clone();
            tokio::spawn(async move {
                gate.acquire(TestPriority::Low).await;
                low_done.store(true, Ordering::SeqCst);
            });
        }

        wait_until(
            "low waiter is served on the next permit; the cancelled high waiter didn't waste it",
            Duration::from_secs(4),
            || low_done.load(Ordering::SeqCst),
        )
        .await;
    }
}
