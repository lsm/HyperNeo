#!/usr/bin/python3
import fcntl
import json
import os
import sys


def emit(**frame):
    print(json.dumps({"jsonrpc": "2.0", **frame}), flush=True)


if sys.argv[1:] == ['--help']:
    print('Usage: dsh [--profile] <name> [options]')
    sys.exit(0)

assert sys.argv[1:] == ['--profile', 'sdk']
if os.path.exists('verify-model-provider'):
    assert 'OPENCODE_API_KEY' not in os.environ
    assert os.environ.get('DEEPSEEK_API_KEY') == 'synthetic-route-proof'
    assert os.environ.get('DEEPSEEK_BASE_URL') == 'https://opencode.ai/inference/go'
    home = os.environ['DSH_HOME']
    assert home == os.path.join(os.path.dirname(os.environ['HOME']), 'data/oap/dsh')
    assert os.path.isdir(home)
    assert not os.path.lexists(os.path.join(home, '.credentials.yaml'))
else:
    assert os.environ.get('DEEPSEEK_API_KEY') == 'synthetic-deepseek-proof'

lease = None
use_lease = os.path.exists("verify-native-lease")


def acquire_lease(session_id):
    global lease
    candidate = open(f"{session_id}.lock", "a")
    try:
        fcntl.flock(candidate, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        candidate.close()
        return False
    lease = candidate
    return True


for line in sys.stdin:
    request = json.loads(line)
    method = request["method"]
    if method == "initialize":
        assert request["params"]["provider"] == "deepseek-official"
        model = request["params"]["model"]
        assert request["params"]["cwd"] == os.getcwd()
        emit(id=request["id"], result={
            "serverInfo": {"name": "deepseek-harness-sdk-runtime", "version": "0.0.1"}
        })
    elif method == "session/resume":
        if os.path.exists("verify-refuse-reopen"):
            emit(id=request["id"], error={"code": -32000, "message": "session is unavailable"})
        elif use_lease and not acquire_lease(request["params"]["sessionId"]):
            open("verify-native-lease-refused", "w").close()
            emit(id=request["id"], error={"code": -32000, "message": "session is already open"})
        else:
            emit(id=request["id"], result={})
    elif method == "session/prompt":
        if os.path.exists("verify-native-prompt-count"):
            with open("verify-native-prompt-count", "a") as counter:
                counter.write("1")
        session_id = request["params"]["sessionId"]
        if use_lease and lease is None:
            assert acquire_lease(session_id)
        blocks = request["params"]["contentBlocks"]
        after_restart = any(
            block.get("text") in ("Message after hub restart", "Verify model after hub restart")
            for block in blocks
        )
        turn_id = 2 if after_restart else 1
        user_message = {
            "id": f"user-{turn_id}", "role": "user", "source": {"kind": "user"},
            "content": blocks,
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
        emit(id=request["id"], result={"messageId": user_message["id"]})
        status("running")
        event(2, "turn/start", {"turn": 1})
        event(3, "step/start", {"step": 1, "turn": 1})
        event(4, "user/message", user_message, surfaceOp="append")
        reply = "Synthetic DeepSeek reply after restart" if after_restart else "Synthetic DeepSeek reply"
        if any(block.get("text", "").startswith("Verify model") for block in user_message["content"]):
            images = [block for block in user_message["content"] if block["type"] == "image"]
            details = {"model": model, "images": images}
            if after_restart:
                details["reopened"] = True
            reply = json.dumps(details, separators=(",", ":"))
        event(5, "assistant/message", {
            "message": {
                "id": f"assistant-{turn_id}", "role": "assistant",
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
