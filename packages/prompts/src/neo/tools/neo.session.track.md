---
id: neo.session.track
---
Track a session the human started themselves, from its notice: key is the notice key from snapshot.sessionNoticeGroups or sessionNotices. The tap is the human’s approval: the daemon opens an ask with one todo that follows the session from the tap on, without sending it anything, and tells Neo the askId and todoId. Neo hears when the session stops before the todo is done.
