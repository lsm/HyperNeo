import argparse
import datetime
import ipaddress
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time
import urllib.request


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def connection(address, port):
    try:
        with socket.create_connection((address, port), timeout=2):
            return "accepted"
    except ConnectionRefusedError:
        return "refused"


def run_case(repo, root, bun, lan, port, explicit):
    case = root / ("explicit" if explicit else "default")
    case.mkdir()
    (case / "home").mkdir()
    (case / "workspace").mkdir()
    with socket.socket() as preflight:
        preflight.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        preflight.bind(("0.0.0.0", port))
    args = [bun, "packages/cli/main.ts", "--port", str(port), "--db-path", str(case / "synthetic.db")]
    if explicit:
        args.extend(["--host", "0.0.0.0"])
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(case / "home"),
        "NODE_ENV": "test",
        "HYPERNEO_DATA_DIR": str(case / "data"),
        "HYPERNEO_WORKSPACE_PATH": str(case / "workspace"),
    }
    result = {"startedAt": now(), "args": args, "nodeEnv": "test", "port": port}
    with (case / "daemon.log").open("w") as log:
        child = subprocess.Popen(args, cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT)
        result["pid"] = child.pid
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            for _ in range(300):
                if child.poll() is not None:
                    raise RuntimeError("Owned daemon exited before readiness; inspect daemon.log")
                try:
                    with opener.open(f"http://127.0.0.1:{port}/", timeout=0.5) as response:
                        result["loopbackHttpStatus"] = response.status
                        break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("Owned daemon did not become ready")
            listing = subprocess.run(
                ["lsof", "-nP", "-a", "-p", str(child.pid), f"-iTCP:{port}", "-sTCP:LISTEN"],
                capture_output=True, text=True, check=True,
            )
            (case / "listener.txt").write_text(listing.stdout)
            result["listener"] = listing.stdout
            result["loopbackConnection"] = connection("127.0.0.1", port)
            result["lanConnection"] = connection(lan, port)
            result["passed"] = (
                result["loopbackHttpStatus"] == 200
                and result["loopbackConnection"] == "accepted"
                and result["lanConnection"] == ("accepted" if explicit else "refused")
                and (f"*:{port}" if explicit else f"127.0.0.1:{port}") in listing.stdout
            )
        finally:
            child.terminate()
            try:
                result["shutdownExitCode"] = child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                child.kill()
                result["shutdownExitCode"] = child.wait()
                result["forcedStop"] = True
            result["stoppedAt"] = now()
            (case / "observed.json").write_text(json.dumps(result, indent=2) + "\n")
    assert result["shutdownExitCode"] == 0, result
    stopped = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"], capture_output=True, text=True)
    assert stopped.returncode == 1 and not stopped.stdout, stopped.stdout
    assert connection("127.0.0.1", port) == "refused"
    return result


parser = argparse.ArgumentParser()
parser.add_argument("run", type=Path)
parser.add_argument("--lan-address", required=True)
parser.add_argument("--port", type=int, default=9389)
options = parser.parse_args()
assert options.port not in (8398, 8399) and 1024 <= options.port < 65535
lan = ipaddress.IPv4Address(options.lan_address)
assert not lan.is_loopback and not lan.is_unspecified
repo = Path(__file__).resolve().parents[3]
root = options.run.resolve()
root.mkdir(exist_ok=False)
bun = shutil.which("bun")
assert bun
results = {
    "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(),
    "lanAddress": str(lan),
    "syntheticOnly": True,
    "cases": [],
}
try:
    for explicit in (False, True):
        results["cases"].append(run_case(repo, root, bun, str(lan), options.port + int(explicit), explicit))
finally:
    (root / "observed.json").write_text(json.dumps(results, indent=2) + "\n")
assert len(results["cases"]) == 2 and all(case["passed"] for case in results["cases"]), results
print("PASS: default accepts loopback and refuses LAN; --host 0.0.0.0 accepts both; owned daemons stopped")
