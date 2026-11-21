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
    todo: String,
    target: Target,
    until: Instant,
    /// Input may still be running: kept until `settle` or a confirmed `release`.
    busy: bool,
}

#[derive(Default)]
pub(super) struct Leases {
    held: Vec<Lease>,
}

impl Leases {
    /// Called while the worker's own driver slot is held, so none of its earlier input is in flight.
    pub(super) fn acquire(
        &mut self,
        worker: &str,
        todo: &str,
        live_todos: &[String],
        target: &Target,
        now: Instant,
        live: impl Fn(&Target) -> bool,
    ) -> Result<(), String> {
        self.held.retain(|lease| {
            lease.busy
                || (lease.until > now
                    && live(&lease.target)
                    && live_todos.contains(&lease.todo)
                    && !(lease.worker == worker && lease.todo != todo))
        });
        if let Some(lease) = self.held.iter().find(|lease| {
            (lease.worker != worker || lease.todo != todo) && lease.target.conflicts(target)
        }) {
            return Err(lease.worker.clone());
        }
        match self
            .held
            .iter_mut()
            .find(|lease| lease.worker == worker && &lease.target == target)
        {
            Some(lease) => {
                lease.until = now + IDLE;
                lease.busy = true;
            }
            None => self.held.push(Lease {
                worker: worker.to_owned(),
                todo: todo.to_owned(),
                target: target.clone(),
                until: now + IDLE,
                busy: true,
            }),
        }
        Ok(())
    }

    /// The worker's input finished; its leases now last until idle.
    pub(super) fn settle(&mut self, worker: &str, now: Instant) {
        for lease in self.held.iter_mut().filter(|lease| lease.worker == worker) {
            lease.busy = false;
            lease.until = now + IDLE;
        }
    }

    /// Stop is in progress and not yet confirmed.
    pub(super) fn pin(&mut self, worker: &str) {
        for lease in self.held.iter_mut().filter(|lease| lease.worker == worker) {
            lease.busy = true;
        }
    }

    /// Only after the worker's driver is confirmed gone.
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

    fn todos() -> Vec<String> {
        vec!["t1".into(), "t2".into(), "t3".into()]
    }

    #[test]
    fn one_window_one_todo() {
        let mut leases = Leases::default();
        let (now, live, todos) = (Instant::now(), |_: &Target| true, todos());
        let take = |leases: &mut Leases, worker, todo, pid, window| {
            leases.acquire(worker, todo, &todos, &target(pid, window), now, live)
        };
        assert!(take(&mut leases, "a", "t1", 9, Some(1)).is_ok());
        assert_eq!(take(&mut leases, "b", "t2", 9, Some(1)), Err("a".into()));
        assert!(take(&mut leases, "b", "t2", 9, Some(2)).is_ok());
        assert!(take(&mut leases, "b", "t2", 8, None).is_ok());
        assert!(take(&mut leases, "a", "t1", 9, Some(1)).is_ok());
        assert!(take(&mut leases, "a", "t1", 9, None).is_err());
    }

    #[test]
    fn busy_leases_never_lapse() {
        let mut leases = Leases::default();
        let (now, todos) = (Instant::now(), todos());
        let window = target(9, Some(1));
        assert!(leases
            .acquire("a", "t1", &todos, &window, now, |_| true)
            .is_ok());
        assert!(leases
            .acquire("b", "t2", &[], &window, now + IDLE * 3, |_| false)
            .is_err());
        leases.settle("a", now);
        assert!(leases
            .acquire("b", "t2", &todos, &window, now + IDLE, |_| true)
            .is_ok());
    }

    #[test]
    fn settled_leases_end_with_their_todo_window_or_idle() {
        let mut leases = Leases::default();
        let (now, todos) = (Instant::now(), todos());
        let window = target(9, Some(1));
        let hold = |leases: &mut Leases, worker, todo| {
            assert!(leases
                .acquire(worker, todo, &todos, &window, now, |_| true)
                .is_ok());
            leases.settle(worker, now);
        };
        hold(&mut leases, "a", "t1");
        assert!(leases
            .acquire("b", "t2", &["t2".into()], &window, now, |_| true)
            .is_ok());
        leases.settle("b", now);
        assert!(leases
            .acquire("c", "t3", &todos, &window, now, |_| false)
            .is_ok());
        leases.settle("c", now);
        assert!(leases
            .acquire("a", "t1", &todos, &window, now + IDLE, |_| true)
            .is_ok());
    }

    #[test]
    fn a_reused_worker_drops_its_previous_todos_leases() {
        let mut leases = Leases::default();
        let (now, todos) = (Instant::now(), todos());
        let window = target(9, Some(1));
        assert!(leases
            .acquire("a", "t1", &todos, &window, now, |_| true)
            .is_ok());
        leases.settle("a", now);
        assert!(leases
            .acquire("a", "t2", &todos, &window, now, |_| true)
            .is_ok());
        assert!(leases
            .acquire("b", "t1", &todos, &window, now, |_| true)
            .is_err());
    }
}
