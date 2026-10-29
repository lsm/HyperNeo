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
    for platform, expected in [('Linux', 65), ('Darwin', 78)]:
        case = root / platform
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
            'node-probe': '#!/bin/sh\nprintf "seed reached\\n" > '
            + shlex.quote(str(marker)) + '\nexit 65\n',
        }
        for name, text in probes.items():
            path = commands / name
            path.write_text(text)
            path.chmod(0o755)
        environment = {
            **os.environ,
            'PATH': str(commands) + os.pathsep + os.environ['PATH'],
            'VERIFY_NODE': str(commands / 'node-probe'),
        }
        result = subprocess.run(
            ['bash', str(runner), str(case / 'evidence')],
            env=environment, capture_output=True, text=True, timeout=30,
        )
        observed = {'simulatedPlatform': platform, 'exitCode': result.returncode,
                    'journeySetupReached': marker.exists()}
        results.append(observed)
        assert result.returncode == expected, (observed, result.stdout, result.stderr)
        assert marker.exists() == (platform == 'Linux'), observed
print(json.dumps({'passed': True, 'nativeLinuxCoverage': False, 'cases': results}))
