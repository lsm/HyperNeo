import base64
import json
from pathlib import Path
import subprocess
import sys

run, ios, simulator = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), sys.argv[3]
saved = json.loads((run / 'evidence/bundle-rpc.json').read_text())
fixture = Path(__file__).with_name('fixtures') / 'BundlePreviewProof.swift'
source = fixture.read_text().replace('__SOURCE_BASE64__', base64.b64encode(saved['source'].encode()).decode()).replace('__DOCUMENT_BASE64__', base64.b64encode(saved['prepared']['document'].encode()).decode())
target = ios / 'NeoTests/BundlePreviewProof.swift'
with target.open('x') as output:
    output.write(source)
result = run / 'ios-bundle.xcresult'
env = dict(__import__('os').environ, NEO_VERIFY_DIR=str(run / 'ios'), NEO_VERIFY_SIM=simulator)
try:
    completed = subprocess.run([str(ios / 'Tools/verify/sim.sh'), 'test', '-only-testing:NeoTests/BundlePreviewProof', '-resultBundlePath', str(result)], cwd=ios, env=env)
    summary = subprocess.check_output(['xcrun', 'xcresulttool', 'get', 'test-results', 'summary', '--path', str(result), '--compact'])
    (run / 'evidence/ios-bundle-summary.json').write_bytes(summary)
    assert completed.returncode == 0, completed.returncode
    container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', simulator, 'dev.hyperneo.neo', 'data'], text=True).strip())
    for language in ['en', 'zh-Hans']:
        for width in [320, 402]:
            name = f'bundle-{language}-{width}.png'
            (run / 'evidence' / ('ios-' + name)).write_bytes((container / 'tmp/artifact-html-evidence' / name).read_bytes())
finally:
    target.unlink()
