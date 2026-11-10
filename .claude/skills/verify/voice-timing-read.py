import argparse
import json

parser = argparse.ArgumentParser()
parser.add_argument('logs', nargs='+')
parser.add_argument('--speech-id')
args = parser.parse_args()
stages = {
    'voice.input.accepted', 'voice.publication.persisted',
    'voice.speech.requested', 'voice.speech.receipt',
    'voice.tts.queued', 'voice.tts.request_started',
    'voice.tts.first_chunk', 'voice.tts.first_chunk_sent',
    'voice.tts.finished', 'voice.tts.failed',
}
keys = {'atMs', 'sessionId', 'messageId', 'requestId', 'speechId', 'publicationId', 'clientId', 'state'}
events = []
for path in args.logs:
    with open(path, encoding='utf-8') as source:
        if path.endswith('.json'):
            rows = json.load(source)
        else:
            rows = []
            for line in source:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    continue
        for row in rows:
            stage = row.get('stage', row.get('message'))
            metadata = row.get('metadata', {})
            if stage not in stages or not isinstance(metadata.get('atMs'), (int, float)):
                continue
            if args.speech_id and metadata.get('speechId') != args.speech_id:
                continue
            events.append({'stage': stage, **{key: value for key, value in metadata.items() if key in keys}})
events.sort(key=lambda event: event['atMs'])
utterances = {}
for event in events:
    speech_id = event.get('speechId')
    if not speech_id:
        continue
    timeline = utterances.setdefault(speech_id, {})
    timeline.setdefault(event['stage'], event['atMs'])
summary = []
for speech_id, timeline in utterances.items():
    intervals = {}
    for name, start, end in [
        ('synthesisQueueMs', 'voice.tts.queued', 'voice.tts.request_started'),
        ('ttsFirstChunkMs', 'voice.tts.request_started', 'voice.tts.first_chunk'),
        ('serverPushMs', 'voice.tts.first_chunk', 'voice.tts.first_chunk_sent'),
    ]:
        intervals[name] = timeline[end] - timeline[start] if start in timeline and end in timeline else None
    summary.append({'speechId': speech_id, **intervals, 'phoneFirstPlayedMs': None})
print(json.dumps({'events': events, 'utterances': summary}, indent=2))
