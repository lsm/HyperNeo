import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.request import urlopen


def verify(app, log_path):
    with tempfile.TemporaryDirectory(prefix="hn-desktop-", dir="/tmp") as run_dir:
        run = Path(run_dir)
        for name in ("home", "data", "workspace", "tmp"):
            (run / name).mkdir()
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            port = reserve.getsockname()[1]
        url = f"http://127.0.0.1:{port}/"
        env = {
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "NODE_ENV": "test",
            "HOME": str(run / "home"),
            "CFFIXED_USER_HOME": str(run / "home"),
            "TMPDIR": str(run / "tmp"),
            "HYPERNEO_DATA_DIR": str(run / "data"),
            "HYPERNEO_DESKTOP_WORKSPACE": str(run / "workspace"),
            "HYPERNEO_DESKTOP_PORT": str(port),
        }
        macos = app / "Contents" / "MacOS"
        with log_path.open("wb") as log:
            desktop = subprocess.Popen(
                [macos / "hyperneo-desktop"], env=env, cwd=run,
                start_new_session=True, stdout=log, stderr=subprocess.STDOUT,
            )
            try:
                deadline = time.monotonic() + 40
                runtime = run / "data" / "runtime.json"
                while time.monotonic() < deadline and desktop.poll() is None:
                    output = log_path.read_text(errors="replace")
                    if "daemon exited before" in output or "Process terminated with code: None" in output:
                        break
                    if runtime.is_file():
                        try:
                            pid = json.loads(runtime.read_text())["pid"]
                            parent = subprocess.check_output(
                                ["/bin/ps", "-o", "ppid=", "-p", str(pid)], text=True
                            ).strip()
                            with urlopen(url, timeout=1) as response:
                                if response.status == 200 and parent == str(desktop.pid):
                                    print(f"Desktop started its sidecar; GET {url} returned 200 (2/2)")
                                    return
                        except (URLError, json.JSONDecodeError, subprocess.CalledProcessError):
                            pass
                    time.sleep(0.25)
                version = subprocess.run(
                    [macos / "hyperneo", "--version"], env=env, cwd=run,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
                )
                raise RuntimeError(f"Desktop daemon never answered on {url}; sidecar --version exit {version.returncode}")
            finally:
                try:
                    os.killpg(desktop.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    desktop.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(desktop.pid, signal.SIGKILL)
                    desktop.wait()
                with socket.socket() as probe:
                    if probe.connect_ex(("127.0.0.1", port)) == 0:
                        raise RuntimeError(f"Desktop's daemon is still listening on port {port}")
                print(f"Desktop proof stopped; port {port} closed")


if __name__ == "__main__":
    verify(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
