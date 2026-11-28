# One desktop worker at a time

HyperNeo Desktop gives this Mac's desktop to one worker at a time. Workers wait
in the order they first called. The holder keeps the desktop until its todo
leaves the live todos the daemon sends with each dispatch, it makes no call
for three minutes, or it is stopped.
A waiting call keeps the list it arrived with, so the next worker gets the
desktop on its next call after the holder's todo ends. A stopped or held (stop not confirmed) worker leaves the
line and cannot rejoin, and so does a waiter whose turn is stopped. A worker
whose todo ended gives up its Locked Use session to the next holder. On a
locked Mac, Desktop retries the stop of held workers so one whose driver has
exited no longer keeps Locked Use from the next worker.

Build the embedded-host fixture as in `desktop-driver-private-channel.md`, then
run on a Mac:

```bash
cargo test --locked --manifest-path packages/desktop/tests/driver-host/Cargo.toml -- desk::
python3 packages/desktop/tests/worker-drivers.py \
  packages/desktop/tests/driver-host/target/debug/desktop-driver-fixture \
  WorkerDrivers.test_workers_take_the_desktop_in_turn_until_the_holders_todo_ends \
  WorkerDrivers.test_a_held_worker_stops_keeping_a_locked_mac_once_its_driver_exits \
  WorkerDrivers.test_a_cancelled_or_unconfirmed_worker_gives_up_its_place_in_line \
  WorkerDrivers.test_a_worker_stopped_while_it_waits_does_not_rejoin_the_line \
  WorkerDrivers.test_a_finished_workers_locked_use_passes_to_the_next_worker \
  WorkerDrivers.test_second_worker_waits_for_a_held_window_until_the_holder_stops \
  WorkerDrivers.test_foreground_calls_on_different_apps_take_turns
```

Pass prints `queue=fifo holder_todo_done=next_worker`,
`held_worker=retired locked_mac=next_worker`,
`cancelled_waiter=left_line unconfirmed_stop=left_line`,
`stopped_waiter=left_line next_worker=dispatched`,
`finished_worker=released locked_mac=next_worker`,
`held_desktop=desktop_queued after_stop=dispatched` and `foreground=serialized`,
then `OK`. Queued calls return `desktop_queued` without input; the third worker
cannot overtake the second; a Locked Use guardian starts for the next worker
once the held worker's fake driver exits. The fixture uses a fake driver and a
stand-in guardian: it sends no GUI input and does not unlock the Mac.

Not covered: a real Cua driver, a real lock screen, and workers driven by a model.
