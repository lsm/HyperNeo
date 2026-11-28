use std::collections::VecDeque;
use tokio::time::{Duration, Instant};

/// A worker that makes no call for this long loses its place, so one that stopped calling
/// cannot keep the desktop.
pub(super) const IDLE: Duration = Duration::from_secs(180);

struct Seat {
    worker: String,
    todo: String,
    seen: Instant,
}

/// One worker uses this Mac's desktop at a time. The first in line holds it until its todo
/// ends, it stops, or it goes idle; the others keep their place.
#[derive(Default)]
pub(super) struct Desk {
    line: VecDeque<Seat>,
}

impl Desk {
    /// Removes the workers whose todos have ended or who went idle, and returns them.
    pub(super) fn end(&mut self, live_todos: &[String], now: Instant) -> Vec<String> {
        let (live, ended): (VecDeque<Seat>, VecDeque<Seat>) = std::mem::take(&mut self.line)
            .into_iter()
            .partition(|seat| live_todos.contains(&seat.todo) && seat.seen + IDLE > now);
        self.line = live;
        ended.into_iter().map(|seat| seat.worker).collect()
    }

    /// True when this worker holds the desktop; otherwise it keeps its place in line.
    pub(super) fn take(&mut self, worker: &str, todo: &str, now: Instant) -> bool {
        match self.line.iter_mut().find(|seat| seat.worker == worker) {
            Some(seat) => {
                seat.todo = todo.to_owned();
                seat.seen = now;
            }
            None => self.line.push_back(Seat {
                worker: worker.to_owned(),
                todo: todo.to_owned(),
                seen: now,
            }),
        }
        self.line.front().is_some_and(|seat| seat.worker == worker)
    }

    pub(super) fn leave(&mut self, worker: &str) {
        self.line.retain(|seat| seat.worker != worker);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workers_take_turns_in_arrival_order() {
        let mut desk = Desk::default();
        let now = Instant::now();
        let all: Vec<String> = ["t1", "t2", "t3"].map(String::from).into();
        assert!(desk.take("a", "t1", now));
        assert!(!desk.take("b", "t2", now));
        assert!(!desk.take("c", "t3", now));
        assert!(desk.end(&all, now).is_empty());
        assert!(desk.take("a", "t1", now));
        assert_eq!(desk.end(&all[1..], now), ["a"]);
        assert!(!desk.take("c", "t3", now));
        assert!(desk.take("b", "t2", now));
        desk.leave("b");
        assert!(desk.take("c", "t3", now));
    }

    #[test]
    fn a_holder_that_stops_calling_loses_the_desktop() {
        let mut desk = Desk::default();
        let now = Instant::now();
        let all: Vec<String> = ["t1", "t2"].map(String::from).into();
        assert!(desk.take("a", "t1", now));
        assert!(!desk.take("b", "t2", now + IDLE / 2));
        assert!(desk.end(&all, now + IDLE / 2).is_empty());
        assert_eq!(desk.end(&all, now + IDLE), ["a"]);
        assert!(desk.take("b", "t2", now + IDLE));
    }
}
