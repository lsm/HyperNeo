from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
from threading import Thread
import time
from urllib.error import URLError
from urllib.request import urlopen


class ReadyDaemon(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()


@contextmanager
def target(run, attach):
    if attach:
        with HTTPServer(("127.0.0.1", 0), ReadyDaemon) as daemon:
            port = daemon.server_port
            url = f"http://localhost:{port}"
            (run / "data" / "runtime.json").write_text(
                json.dumps({"pid": os.getpid(), "port": port, "url": url})
            )
            thread = Thread(target=daemon.serve_forever)
            thread.start()
            try:
                yield port, f"{url}/"
            finally:
                daemon.shutdown()
                thread.join()
    else:
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            port = reserve.getsockname()[1]
        yield port, f"http://127.0.0.1:{port}/"


def verify(run, attach):
    run.mkdir()
    for name in ("home", "data", "workspace"):
        (run / name).mkdir()
    with target(run, attach) as (port, url):
        launch(run, attach, port, url)


def launch(run, attach, port, url):
    env = {name: os.environ[name] for name in ("PATH", "CARGO_HOME", "RUSTUP_HOME") if name in os.environ}
    env.update(
        NODE_ENV="test",
        HOME=str(run / "home"),
        CFFIXED_USER_HOME=str(run / "home"),
        HYPERNEO_DATA_DIR=str(run / "data"),
        HYPERNEO_DESKTOP_WORKSPACE=str(run / "workspace"),
        HYPERNEO_DESKTOP_PORT=str(port),
    )
    with (run / "desktop.log").open("wb") as log:
        desktop = subprocess.Popen(
            ["cargo", "tauri", "dev", "--no-watch"],
            cwd="packages/desktop",
            env=env,
            start_new_session=True,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + 900
            while time.monotonic() < deadline:
                status = desktop.poll()
                if status is not None:
                    raise RuntimeError(f"cargo tauri dev exited {status}")
                try:
                    with urlopen(url, timeout=2) as response:
                        code = response.status
                except URLError:
                    code = None
                output = (run / "desktop.log").read_text(errors="replace")
                if attach and code == 200 and "Attaching to the running daemon" in output:
                    if "Automatic sign-in skipped for the advertised daemon host" in output:
                        print("Tauri attached to localhost and reported manual pairing (2/2)")
                        return
                    if "No local device credential found" in output:
                        raise RuntimeError("The app tried local sign-in for the advertised localhost URL")
                if (
                    code == 200
                    and "HyperNeo desktop app spawned the hyperneo daemon" in output
                    and f"Daemon answered at {url}" in output
                    and list((run / "data").rglob("daemon.db"))
                ):
                    print(f"Tauri spawned its daemon; loopback GET / returned {code}; isolated DB present (3/3)")
                    return
                time.sleep(1)
            raise RuntimeError("Timed out waiting for the desktop-owned daemon")
        finally:
            try:
                os.killpg(desktop.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                desktop.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(desktop.pid, signal.SIGKILL)
                desktop.wait()


if __name__ == "__main__":
    verify(Path(sys.argv[1]).resolve(), "--attach" in sys.argv[2:])
