#!/usr/bin/python3
import json
import os
import sys


def emit(**frame):
    print(json.dumps({"jsonrpc": "2.0", **frame}), flush=True)


assert sys.argv[1:] == ['--profile', 'sdk']
assert 'DEEPSEEK_API_KEY' not in os.environ

for line in sys.stdin:
    request = json.loads(line)
    method = request["method"]
    if method == "initialize":
        assert request["params"]["provider"] == "deepseek-official"
        model = request["params"]["model"]
        assert model in ("deepseek-v4-pro", "deepseek-v4-flash")
        assert request["params"]["cwd"] == os.getcwd()
        emit(id=request["id"], result={
            "serverInfo": {"name": "deepseek-harness-sdk-runtime", "version": "0.0.1"}
        })
    elif method == "session/prompt":
        session_id = request["params"]["sessionId"]
        user_message = {
            "id": "user-1", "role": "user", "source": {"kind": "user"},
            "content": request["params"]["contentBlocks"],
        }

        def status(value):
            emit(method="session.status", params={"sessionId": session_id, "status": value})

        def event(seq, kind, data, **fields):
            emit(method="session.event", params={"sessionId": session_id, "event": {
                "seq": seq, "time": seq, "type": kind, "data": data, **fields,
            }})

        event(1, "agent/inbox/spliced", {
            "inserted": [user_message], "start": 0, "target": "next-turn",
        })
        emit(id=request["id"], result={"messageId": "user-1"})
        status("running")
        event(2, "turn/start", {"turn": 1})
        event(3, "step/start", {"step": 1, "turn": 1})
        event(4, "user/message", user_message, surfaceOp="append")
        reply = f"Synthetic DeepSeek reply from {model}"
        event(5, "assistant/message", {
            "message": {
                "id": "assistant-1", "role": "assistant",
                "source": {
                    "kind": "model", "model": model, "provider": "deepseek-official",
                },
                "content": [{"type": "text", "text": reply}],
            },
            "stream": [{
                "type": "chunk", "time": 5,
                "chunk": {"type": "text-delta", "index": 0, "text": reply},
            }],
            "step": 1, "turn": 1, "usage": {"inputTokens": 1, "outputTokens": 2},
        }, surfaceOp="append")
        event(6, "step/end", {"step": 1, "turn": 1})
        event(7, "turn/end", {"reason": {"kind": "completed"}, "turn": 1})
        status("idle")
    elif method == "shutdown":
        emit(id=request["id"], result={})
        break
    else:
        raise ValueError(method)
