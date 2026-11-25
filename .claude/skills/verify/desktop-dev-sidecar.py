from contextlib import contextmanager
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
from threading import Event, Thread
import time
from urllib.error import URLError
from urllib.request import urlopen


class ReadyDaemon(BaseHTTPRequestHandler):
    def do_GET(self):
        device = SimpleCookie(self.headers.get("Cookie", "")).get("hyperneo_device")
        if device is not None and device.value == self.server.expected_device:
            self.server.device_received.set()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, _format, *_args):
        pass


@contextmanager
def target(run, attach_host):
    if attach_host:
        with ThreadingHTTPServer(("127.0.0.1", 0), ReadyDaemon) as daemon:
            port = daemon.server_port
            url = f"http://{attach_host}:{port}"
            daemon.expected_device = None
            daemon.device_received = Event()
            credential_path = run / "data" / "local-rpc.credential"
            if attach_host == "127.0.0.1":
                daemon.expected_device = secrets.token_urlsafe(32)
                descriptor = os.open(credential_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                with os.fdopen(descriptor, "w") as credential:
                    credential.write(daemon.expected_device)
            (run / "data" / "runtime.json").write_text(
                json.dumps({"pid": os.getpid(), "port": port, "url": url})
            )
            thread = Thread(target=daemon.serve_forever)
            thread.start()
            try:
                yield port, f"{url}/", daemon.device_received
            finally:
                daemon.shutdown()
                thread.join()
                credential_path.unlink(missing_ok=True)
    else:
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            port = reserve.getsockname()[1]
        yield port, f"http://127.0.0.1:{port}/", None


def verify(run, attach_host):
    run.mkdir()
    for name in ("home", "data", "workspace"):
        (run / name).mkdir()
    with target(run, attach_host) as (port, url, device_received):
        launch(run, attach_host, port, url, device_received)


def launch(run, attach_host, port, url, device_received):
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
            attached_at = None
            while time.monotonic() < deadline:
                status = desktop.poll()
                if status is not None:
                    raise RuntimeError(f"cargo tauri dev exited {status}")
                try:
                    with urlopen(url, timeout=2) as response:
                        code = response.status
                except (URLError, socket.timeout):
                    code = None
                output = (run / "desktop.log").read_text(errors="replace")
                if attach_host and code == 200 and "Attaching to the running daemon" in output:
                    if attach_host == "127.0.0.1":
                        if device_received.is_set():
                            print("Tauri attached to 127.0.0.1 and sent the WebView device cookie (2/2)")
                            return
                        attached_at = attached_at or time.monotonic()
                        if time.monotonic() - attached_at > 10:
                            raise RuntimeError("The attached WebView did not send the device cookie")
                    elif "Automatic sign-in skipped for the advertised daemon host" in output:
                        print("Tauri attached to localhost and reported manual pairing (2/2)")
                        return
                    elif "No local device credential found" in output:
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
    mode = sys.argv[2] if len(sys.argv) > 2 else ""
    attach_hosts = {"--attach": "localhost", "--attach-loopback": "127.0.0.1"}
    verify(Path(sys.argv[1]).resolve(), attach_hosts.get(mode))
