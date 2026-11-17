import json
import re
import sys


def normalize(path):
    with open(path) as source:
        replies = json.load(source)
    ids = {}

    def visit(value, key=''):
        if isinstance(value, dict):
            return {k: visit(v, k) for k, v in value.items()}
        if isinstance(value, list):
            return [visit(item) for item in value]
        if key in ('createdAt', 'updatedAt') and isinstance(value, int):
            return '<timestamp>'
        if isinstance(value, str):
            def replace(match):
                identifier = match.group(0)
                return ids.setdefault(identifier, f'<id-{len(ids) + 1}>')
            return re.sub(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', replace, value)
        return value

    return visit(replies)


base, changed = map(normalize, sys.argv[1:])
if base != changed:
    print(json.dumps({'base': base, 'changed': changed}, indent=2))
    sys.exit(1)
print(f'ok: {len(base)} normalized RPC replies match')
