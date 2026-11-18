import json
import sys
from pathlib import Path


def normalize(value):
    if isinstance(value, dict):
        return {key: normalize(item) for key, item in value.items() if key != 'createdAt'}
    if isinstance(value, list):
        return [normalize(item) for item in value]
    return value


base, changed = (json.loads(Path(path).read_text()) for path in sys.argv[1:])
assert normalize(base) == normalize(changed), 'Publication replies differ'
print(f'Publication replies match: {len(base)} cases')
