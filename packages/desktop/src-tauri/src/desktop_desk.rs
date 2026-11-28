use std::collections::VecDeque;

/// One worker uses this Mac's desktop at a time. The first in line holds it until its todo
/// ends or it stops; the others keep their place.
#[derive(Default)]
pub(super) struct Desk {
    line: VecDeque<(String, String)>,
}

impl Desk {
    /// True when this worker holds the desktop; otherwise it keeps its place in line.
    pub(super) fn take(&mut self, worker: &str, todo: &str, live_todos: &[String]) -> bool {
        self.line.retain(|(_, todo)| live_todos.contains(todo));
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
        assert!(desk.take("a", "t1", &all));
        assert!(!desk.take("b", "t2", &all));
        assert!(!desk.take("c", "t3", &all));
        assert!(desk.take("a", "t1", &all));
        assert!(!desk.take("c", "t3", &all[1..]));
        assert!(desk.take("b", "t2", &all[1..]));
        desk.leave("b");
        assert!(desk.take("c", "t3", &all));
    }
}
