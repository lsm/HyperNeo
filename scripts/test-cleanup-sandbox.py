from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent.parent


def sandbox_steps():
    lines = (ROOT / '.github/workflows/main.yml').read_text().splitlines()
    steps = []
    for index, line in enumerate(lines):
        if line.strip() != '- name: Install cleanup sandbox':
            continue
        body = []
        for command in lines[index + 2:]:
            if command and not command.startswith('          '):
                break
            body.append(command[10:])
        steps.append('\n'.join(body))
    return steps


class CleanupSandboxTests(unittest.TestCase):
    def run_setup(self, source, dns_up):
        with tempfile.TemporaryDirectory(prefix='cleanup-sandbox-') as directory:
            root = Path(directory)
            binaries = root / 'bin'
            binaries.mkdir()
            mirrors = root / 'mirrors.txt'
            mirrors.write_text('http://azure.archive.ubuntu.com/ubuntu/\n')
            log = root / 'commands.log'
            programs = {
                'getent': 'exit "$CI_TEST_DNS_STATUS"',
                'sudo': '''if [ "$1" = tee ]; then
  cat > "$CI_TEST_MIRRORS"
  exit 0
fi
if [ "$1" = sysctl ]; then exit 0; fi
exec "$@"''',
                'apt-get': '''if [ "$1" = install ] && [ "$CI_TEST_DNS_STATUS" = 1 ] && ! grep -q '^https://mirrors.mit.edu/ubuntu/' "$CI_TEST_MIRRORS"; then
  exit 100
fi
printf 'apt-get %s\\n' "$*" >> "$CI_TEST_LOG"''',
                'bwrap': '''printf 'bwrap %s\\n' "$*" >> "$CI_TEST_LOG"''',
            }
            for name, body in programs.items():
                path = binaries / name
                path.write_text('#!/bin/bash\nset -eu\n' + body + '\n')
                path.chmod(0o700)
            environment = {
                'HOME': str(root),
                'PATH': f'{binaries}:/usr/bin:/bin',
                'CI_TEST_DNS_STATUS': '0' if dns_up else '1',
                'CI_TEST_MIRRORS': str(mirrors),
                'CI_TEST_LOG': str(log),
            }
            script = source.replace('/usr/bin/bwrap', str(binaries / 'bwrap'))
            result = subprocess.run(
                ['bash', '-euo', 'pipefail', '-c', script],
                env=environment, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            commands = log.read_text()
            self.assertIn('apt-get install -y bubblewrap\n', commands)
            self.assertIn('bwrap --die-with-parent --ro-bind / / -- /bin/true\n', commands)
            return mirrors.read_text()

    def test_dns_outage_still_installs_and_checks_cleanup_sandbox(self):
        steps = sandbox_steps()
        self.assertEqual(len(steps), 2)
        for step in steps:
            with self.subTest(step=step):
                mirrors = self.run_setup(step, dns_up=False)
                self.assertIn('https://mirrors.mit.edu/ubuntu/', mirrors)
                self.assertIn('https://mirrors.edge.kernel.org/ubuntu/', mirrors)

    def test_healthy_dns_keeps_the_runner_mirror_configuration(self):
        for step in sandbox_steps():
            with self.subTest(step=step):
                mirrors = self.run_setup(step, dns_up=True)
                self.assertEqual(mirrors, 'http://azure.archive.ubuntu.com/ubuntu/\n')


if __name__ == '__main__':
    unittest.main(verbosity=2)
