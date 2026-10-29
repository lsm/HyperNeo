import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile


verify = Path(__file__).resolve().parent
runner = verify / 'preview-html-viewer-check.sh'
results = []
with tempfile.TemporaryDirectory(prefix='preview-preflight-') as temporary:
    root = Path(temporary)
    for name, platform, expected in [('Linux', 'Linux', 65), ('Darwin', 'Darwin', 78),
                                     ('CopyFailure', 'Linux', 74)]:
        case = root / name
        commands = case / 'bin'
        commands.mkdir(parents=True)
        marker = case / 'journey-started'
        probes = {
            'uname': '#!/bin/sh\nprintf "%s\\n" ' + shlex.quote(platform) + '\n',
            'memory_pressure': '#!/bin/sh\n' + (
                'echo "memory_pressure unavailable on Linux" >&2\nexit 127\n'
                if platform == 'Linux' else
                'echo "System-wide memory free percentage: 24%"\n'
            ),
            'node-probe': '#!/bin/sh\nprobe_run=${HOME%/home}\nprintf "%s" "$probe_run" > '
            + shlex.quote(str(marker)) + '\nmkdir -p "$probe_run/evidence"\n'
            + 'printf "retained canary" > "$probe_run/evidence/canary"\nexit 65\n',
        }
        if name == 'CopyFailure':
            probes['cp'] = '#!/bin/sh\necho "synthetic evidence copy failure" >&2\nexit 74\n'
        for command, text in probes.items():
            path = commands / command
            path.write_text(text)
            path.chmod(0o755)
        environment = {
            **os.environ,
            'PATH': str(commands) + os.pathsep + os.environ['PATH'],
            'VERIFY_NODE': str(commands / 'node-probe'),
            'TMPDIR': str(case / 'tmp'),
        }
        (case / 'tmp').mkdir()
        result = subprocess.run(
            ['bash', str(runner), str(case / 'evidence')],
            env=environment, capture_output=True, text=True, timeout=30,
        )
        observed = {'case': name, 'simulatedPlatform': platform, 'exitCode': result.returncode,
                    'journeySetupReached': marker.exists()}
        if name == 'CopyFailure':
            run = Path(marker.read_text())
            observed['sourceEvidenceRetained'] = (run / 'evidence/canary').exists()
            observed['sourceStatusRetained'] = (run / 'evidence/run-status.json').exists()
        results.append(observed)
        assert result.returncode == expected, (observed, result.stdout, result.stderr)
        assert marker.exists() == (platform == 'Linux'), observed
        if name == 'CopyFailure':
            assert observed['sourceEvidenceRetained'] and observed['sourceStatusRetained'], observed
            assert json.loads((run / 'evidence/run-status.json').read_text())['exitCode'] == 65
print(json.dumps({'passed': True, 'nativeLinuxCoverage': False, 'cases': results}))
