import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent.parent
MIRROR = "https://mirrors.edge.kernel.org/ubuntu"


class CleanupSandboxInstallTests(unittest.TestCase):
    def scripts(self):
        workflow = (ROOT / ".github/workflows/main.yml").read_text()
        blocks = re.findall(
            r"      - name: Install cleanup sandbox\n        run: \|\n((?:          .*\n)+)",
            workflow,
        )
        self.assertEqual(len(blocks), 2)
        return ["\n".join(line[10:] for line in block.splitlines()) for block in blocks]

    def run_install(self, script, scenario):
        with tempfile.TemporaryDirectory() as directory:
            case = Path(directory)
            binaries = case / "bin"
            binaries.mkdir()
            mirrors = case / "mirrors"
            mirrors.write_text("http://azure.archive.ubuntu.com/ubuntu\n")
            stubs = {
                "sudo": 'exec "$@"\n',
                "sysctl": 'printf "sysctl\\n" >> "$CASE_ROOT/log"\n',
                "apt-get": r'''printf 'apt-get %s\n' "$*" >> "$CASE_ROOT/log"
if grep -q azure "$CASE_ROOT/mirrors"; then
  if [ "$SCENARIO" = update_failure ] && [ "$1" = update ]; then exit 100; fi
  if [ "$SCENARIO" = install_failure ] && [ "$1" = install ]; then exit 100; fi
fi
if [ "$SCENARIO" = unavailable ] && [ "$1" = install ]; then exit 100; fi
if [ "$1" = install ]; then touch "$CASE_ROOT/installed"; fi
''',
                "bwrap": r'''printf 'bwrap %s\n' "$*" >> "$CASE_ROOT/log"
test -f "$CASE_ROOT/installed" || exit 7
if [ "$SCENARIO" = sandbox_failure ]; then exit 7; fi
''',
            }
            for name, content in stubs.items():
                path = binaries / name
                path.write_text("#!/bin/sh\n" + content)
                path.chmod(0o700)
            self.assertIn("/usr/bin/bwrap --die-with-parent --ro-bind / / -- /bin/true", script)
            script = script.replace("/etc/apt/apt-mirrors.txt", str(mirrors))
            script = script.replace("/usr/bin/bwrap", str(binaries / "bwrap"))
            result = subprocess.run(
                ["bash", "-e", "-o", "pipefail", "-c", script],
                env={
                    "HOME": directory,
                    "NODE_ENV": "test",
                    "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
                    "CASE_ROOT": directory,
                    "SCENARIO": scenario,
                },
                capture_output=True,
                text=True,
            )
            return result.returncode, (case / "log").read_text(), mirrors.read_text()

    def test_primary_install_runs_sandbox_check(self):
        for script in self.scripts():
            with self.subTest(script=script):
                code, log, mirror = self.run_install(script, "primary")
                self.assertEqual(code, 0)
                self.assertEqual(log.count("apt-get install"), 1)
                self.assertEqual(log.count("bwrap"), 1)
                self.assertNotIn(MIRROR, mirror)

    def test_dns_failure_uses_one_mirror_fallback(self):
        for script in self.scripts():
            for scenario in ("update_failure", "install_failure"):
                with self.subTest(scenario=scenario, script=script):
                    code, log, mirror = self.run_install(script, scenario)
                    self.assertEqual(code, 0)
                    self.assertEqual(log.count("bwrap"), 1)
                    self.assertEqual(mirror.strip(), MIRROR)

    def test_failed_fallback_stops_before_sandbox(self):
        for script in self.scripts():
            with self.subTest(script=script):
                code, log, mirror = self.run_install(script, "unavailable")
                self.assertNotEqual(code, 0)
                self.assertEqual(log.count("apt-get install"), 2)
                self.assertNotIn("bwrap", log)
                self.assertEqual(mirror.strip(), MIRROR)

    def test_sandbox_failure_fails_the_step(self):
        for script in self.scripts():
            with self.subTest(script=script):
                code, log, _ = self.run_install(script, "sandbox_failure")
                self.assertEqual(code, 7)
                self.assertEqual(log.count("bwrap"), 1)


if __name__ == "__main__":
    unittest.main()
