use serde_json::Value;
use tokio::time::{Duration, Instant};

pub(super) const IDLE: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Target {
    pub(super) instance: Value,
    pub(super) window: Option<u64>,
}

impl Target {
    pub(super) fn of(observed: &Value) -> Option<Self> {
        let instance = observed.get("instance").filter(|value| !value.is_null())?;
        Some(Self {
            instance: instance.clone(),
            window: observed["window_id"].as_u64(),
        })
    }

    fn conflicts(&self, other: &Self) -> bool {
        self.instance == other.instance
            && (self.window.is_none() || other.window.is_none() || self.window == other.window)
    }
}

struct Lease {
    worker: String,
    target: Target,
    until: Instant,
}

#[derive(Default)]
pub(super) struct Leases {
    held: Vec<Lease>,
}

impl Leases {
    pub(super) fn acquire(
        &mut self,
        worker: &str,
        target: &Target,
        now: Instant,
        live: impl Fn(&Target) -> bool,
    ) -> Result<(), String> {
        self.held
            .retain(|lease| lease.until > now && live(&lease.target));
        if let Some(lease) = self
            .held
            .iter()
            .find(|lease| lease.worker != worker && lease.target.conflicts(target))
        {
            return Err(lease.worker.clone());
        }
        match self
            .held
            .iter_mut()
            .find(|lease| lease.worker == worker && &lease.target == target)
        {
            Some(lease) => lease.until = now + IDLE,
            None => self.held.push(Lease {
                worker: worker.to_owned(),
                target: target.clone(),
                until: now + IDLE,
            }),
        }
        Ok(())
    }

    pub(super) fn release(&mut self, worker: &str) {
        self.held.retain(|lease| lease.worker != worker);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn target(pid: i64, window: Option<u64>) -> Target {
        Target::of(&json!({"instance": {"pid": pid}, "window_id": window})).unwrap()
    }

    #[test]
    fn one_window_one_worker() {
        let mut leases = Leases::default();
        let now = Instant::now();
        let live = |_: &Target| true;
        assert!(leases.acquire("a", &target(9, Some(1)), now, live).is_ok());
        assert_eq!(
            leases.acquire("b", &target(9, Some(1)), now, live),
            Err("a".into())
        );
        assert!(leases.acquire("b", &target(9, Some(2)), now, live).is_ok());
        assert!(leases.acquire("b", &target(8, None), now, live).is_ok());
        assert!(leases.acquire("a", &target(9, Some(1)), now, live).is_ok());
    }

    #[test]
    fn app_wide_call_conflicts_with_its_windows() {
        let mut leases = Leases::default();
        let now = Instant::now();
        let live = |_: &Target| true;
        assert!(leases.acquire("a", &target(9, Some(1)), now, live).is_ok());
        assert!(leases.acquire("b", &target(9, None), now, live).is_err());
        leases.release("a");
        assert!(leases.acquire("b", &target(9, None), now, live).is_ok());
        assert!(leases.acquire("a", &target(9, Some(3)), now, live).is_err());
    }

    #[test]
    fn idle_or_dead_leases_end() {
        let mut leases = Leases::default();
        let now = Instant::now();
        assert!(leases
            .acquire("a", &target(9, Some(1)), now, |_| true)
            .is_ok());
        assert!(leases
            .acquire("b", &target(9, Some(1)), now + IDLE, |_| true)
            .is_ok());
        assert!(leases
            .acquire("c", &target(9, Some(1)), now, |_| false)
            .is_ok());
    }
}
