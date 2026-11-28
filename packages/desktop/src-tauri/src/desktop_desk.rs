use std::collections::VecDeque;

/// One worker uses this Mac's desktop at a time. The first in line holds it until its todo
/// ends or it stops; the others keep their place.
#[derive(Default)]
pub(super) struct Desk {
    line: VecDeque<(String, String)>,
}

impl Desk {
    /// Removes the workers whose todos have ended and returns them.
    pub(super) fn end(&mut self, live_todos: &[String]) -> Vec<String> {
        let (live, ended) = std::mem::take(&mut self.line)
            .into_iter()
            .partition(|(_, todo)| live_todos.contains(todo));
        self.line = live;
        ended.into_iter().map(|(worker, _)| worker).collect()
    }

    /// True when this worker holds the desktop; otherwise it keeps its place in line.
    pub(super) fn take(&mut self, worker: &str, todo: &str) -> bool {
        match self.line.iter_mut().find(|(seat, _)| seat == worker) {
            Some(seat) => seat.1 = todo.to_owned(),
            None => self.line.push_back((worker.to_owned(), todo.to_owned())),
        }
        self.line.front().is_some_and(|(seat, _)| seat == worker)
    }

    pub(super) fn leave(&mut self, worker: &str) {
        self.line.retain(|(seat, _)| seat != worker);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workers_take_turns_in_arrival_order() {
        let mut desk = Desk::default();
        let all: Vec<String> = ["t1", "t2", "t3"].map(String::from).into();
        assert!(desk.take("a", "t1"));
        assert!(!desk.take("b", "t2"));
        assert!(!desk.take("c", "t3"));
        assert!(desk.end(&all).is_empty());
        assert!(desk.take("a", "t1"));
        assert_eq!(desk.end(&all[1..]), ["a"]);
        assert!(!desk.take("c", "t3"));
        assert!(desk.take("b", "t2"));
        desk.leave("b");
        assert!(desk.take("c", "t3"));
    }
}
