"""Serve GLiNER2.5-Decide or Laya behind the Jev/Kev /v1/systemone request format.

Only `choice` questions are supported. Usage:
    python encoder_server.py --model laya --port 8011
    python encoder_server.py --model gliner --port 8012
"""

import argparse
import time

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


class ChoiceQuestion(BaseModel):
    type: str
    instructions: str = ""
    criteria: dict[str, str]


class SystemOneRequest(BaseModel):
    state: str
    model: str | None = None
    questions: dict[str, ChoiceQuestion]


def load_laya(max_len: int):
    import laya

    agent = laya.load("convaiinnovations/laya-multilingual")

    def predict(req: SystemOneRequest):
        questions = {name: q.model_dump() for name, q in req.questions.items()}
        result = agent.predict(req.state, questions, max_len=max_len)
        answers = {}
        for name, answer in result["answers"].items():
            probs = answer.get("probabilities") or {}
            answers[name] = {
                "type": "choice",
                "choice": answer["choice"],
                "confidence": answer.get("confidence"),
                "probabilities": probs,
            }
        tokens = len(agent.tokenizer(req.state)["input_ids"]) if hasattr(agent, "tokenizer") else None
        return answers, tokens

    return predict


def load_gliner(max_len: int):
    from gliner2 import AutoExtractor

    model = AutoExtractor.from_pretrained("fastino/GLiNER2.5-Decide")
    try:
        import torch

        if torch.cuda.is_available():
            model = model.to("cuda")
    except Exception:
        pass

    def predict(req: SystemOneRequest):
        answers = {}
        for name, q in req.questions.items():
            task = {name: {"labels": dict(q.criteria)}}
            result = model.classify_text(f"{q.instructions}\n\n{req.state}", task, include_confidence=True)
            raw = result[name]
            if isinstance(raw, dict):
                choice, confidence = raw.get("label"), raw.get("confidence")
            elif isinstance(raw, list) and raw and isinstance(raw[0], dict):
                choice, confidence = raw[0].get("label"), raw[0].get("confidence")
            else:
                choice, confidence = raw, None
            answers[name] = {"type": "choice", "choice": choice, "confidence": confidence}
        return answers, None

    return predict


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", choices=["laya", "gliner"], required=True)
    ap.add_argument("--port", type=int, default=8011)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--max-len", type=int, default=8192)
    args = ap.parse_args()
    predict = (load_laya if args.model == "laya" else load_gliner)(args.max_len)
    app = FastAPI()

    @app.post("/v1/systemone")
    def systemone(req: SystemOneRequest):
        for q in req.questions.values():
            if q.type != "choice":
                raise HTTPException(422, "only choice questions are supported")
        started = time.perf_counter()
        answers, tokens = predict(req)
        return {
            "answers": answers,
            "usage": {"input_tokens": tokens},
            "latency_ms": round((time.perf_counter() - started) * 1000, 1),
        }

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
