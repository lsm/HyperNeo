# Runs

Each run writes `results/<machine>-<candidate>.jsonl`, one line per case. Fields:

| field | meaning |
|---|---|
| `caseId`, `kind`, `source`, `followUp`, `expected` | the case |
| `predicted` | the destination the candidate chose |
| `confidence` | decision models only |
| `latencyMs` | wall clock |
| `serverLatencyMs` | encoder adapter only |
| `inputTokens`, `cachedInputTokens`, `outputTokens` | tokens used |
| `servedModel`, `thinkingBlocks`, `rawAnswer` | LLM runs after #5721 |
| `error` | set when the call failed |

Commands are run from the repo root; `R=scripts/neo-route-eval/results`.

## Software

| component | version |
|---|---|
| HyperNeo | `dev` at 7939a6f1a (2026-10-05); the harness imports the production `buildNeoRoutePrompt` and provider configs |
| Claude Agent SDK CLI | 2.1.268 |
| Kev | jaredpalmer/kev @ 5e42a7a, weights `jaredpalmer/kev-0.8b@v1.0`, `jaredpalmer/kev-4b@v1.0`; MLX via mlx-lm 0.31.3 |
| llama.cpp | release b11433 (prebuilt `ubuntu-cuda-12.8-x64` with cudart on ai0, `macos-x64` on tts); GGUFs `ggml-org/Kev-0.8B-GGUF:Q8_0`, `ggml-org/Kev-4B-GGUF:Q4_K_M` |
| GLiNER2 | gliner2 2.0.0, `fastino/GLiNER2.5-Decide` |
| Laya | laya 0.3.28, `convaiinnovations/laya-multilingual`, `max_len=8192` |
| Python stack (ai0) | torch 2.14.1+cu130, transformers 5.18.0; NVIDIA driver 580.178.04 |

## LLM runs (Agent SDK path, as the production classifier calls it)

| file | command |
|---|---|
| `macbook-llm-haiku-deployed-{message-only,context}` | `bun scripts/neo-route-eval/run.ts --backend sdk --provider anthropic --prompt <p> --out $R/...` |
| `macbook-llm-haiku-lean-{message-only,context}` | same plus `--shape lean` |
| `tts-llm-glm-deployed-{message-only,context}` | `--backend sdk --provider glm --prompt <p>` (GLM-5-Turbo; thinking on, see README finding 3) |
| `tts-llm-glm-lean-context` | `--backend sdk --provider glm --prompt context --shape lean` (thinking on) |
| `tts-llm-glm-lean-thinkingon-rerun-message-only` | same, `message-only`, with `thinking: disabled` injected by the harness proxy; ignored on 47 of 105 |
| `tts-llm-glm-flash-lean-{message-only,context}` | `--backend sdk --provider glm-flash --shape lean` with the proxy; ignored on 65–66 of 105 |
| `tts-llm-deepseek-lean-{message-only,context}` | `--backend sdk --provider deepseek --shape lean` (`deepseek-flash`; proxy forces `thinking: disabled`, honored) |
| `tts-llm-luna-lean-{message-only,context}` | `--backend sdk --provider codex --shape lean` (`gpt-5.6-luna` through HyperNeo's Codex bridge; harness forces `reasoning.effort: none`) |

## LLM runs (native API)

| file | command |
|---|---|
| `tts-llm-glm-native-{message-only,context}` | `--backend glm-native --prompt <p>` (GLM-5-Turbo, `thinking: disabled`; 0 reasoning) |
| `tts-llm-glm-flash-native-{message-only,context}` | `--backend glm-native --model glm-5.3-flash --prompt <p>` (`reasoning_effort: low`) |

## Decision models (`/v1/systemone`, context input)

| file | server | client |
|---|---|---|
| `macbook-kev-0.8b-mlx` | `uv run --extra serve python -m kev.serve --run jaredpalmer/kev-0.8b@v1.0 --port 8009` | `--backend systemone --url http://127.0.0.1:8009 --warmup 3` |
| `macbook-kev-4b-mlx` | same with `kev-4b@v1.0` | same |
| `ai0-kev-0.8b-q8-llamacpp-cuda` | `llama-server -hf ggml-org/Kev-0.8B-GGUF:Q8_0 -ngl 99 -c 16384 -np 1`, `LD_LIBRARY_PATH` = release dir + cudart dir | `--url http://ai0:8021` from the MacBook |
| `ai0-kev-4b-q4km-llamacpp-cuda` | same with `Kev-4B-GGUF:Q4_K_M` | `--url http://ai0:8022` |
| `tts-kev-{0.8b-q8,4b-q4km}-llamacpp-cpu` | `llama-server -hf ggml-org/Kev-…-GGUF:… -c 16384 -np 1` (CPU) | on tts, `--url http://127.0.0.1:8031` |
| `ai0-gliner2.5-decide-torch-cuda` | `python adapters/encoder_server.py --model gliner --port 8012` | `--url http://ai0:8012` |
| `ai0-laya-multilingual-torch-cuda` | `python adapters/encoder_server.py --model laya --port 8011` | `--url http://ai0:8011` |

Option-order checks (`--reverse-options`, logs not kept): GLiNER's synthetic picks moved from
`pr-812` (first listed, 70 of 105) to `main` (first after reversal, 72 of 105). Laya stayed on
`pr-812` (63 of 105) and scored 16 of 105.

## Setup notes

- **llama.cpp's CUDA backend loads silently or not at all.** On ai0 the first start ran on the
  CPU (about 2 s per route) because the CUDA runtime libraries sit in a separate `cudart-…`
  folder. Add it to `LD_LIBRARY_PATH` and check with `llama-server --list-devices`.
- **GLiNER needs a nearly free GPU.** With Kev-0.8B also loaded it ran out of memory on 32
  routes. Rerun alone, 8 of the longest still failed.
- **tts can't use the PyTorch build of Kev.** PyPI has no PyTorch ≥ 2.6 for Intel macOS. A
  conda-forge env (`--override-channels -c conda-forge`, PyTorch 2.8) works and was kept as a
  fallback, but the runs used llama.cpp.
- **The Codex bridge needs its credentials loaded first.** It must be started after
  `isAvailable()`, which loads them; otherwise it starts with no auth and every upstream call
  returns 401.

## Production-path runs (2026-10-06)

| file | command (on tts) |
|---|---|
| `tts-prod-<model>.jsonl` | `bun scripts/neo-route-eval/run.ts --backend prod-direct --base-url https://open.bigmodel.cn/api/anthropic --model <glm-…> --key-env GLM_API_KEY --cases synthetic,real --warmup 0 --out $R/tts-prod-<model>.jsonl` (DeepSeek: `https://api.deepseek.com/anthropic`, `DEEPSEEK_API_KEY`) |
| `tts-prod-<model>-cold.jsonl` | five separate processes of the same command with `--cases synthetic --limit 1`, appended |
| `tts-json-<model>.jsonl` | the `tts-prod` command at dev `5f08d12` (JSON answers, 512-token cap), `--out $R/tts-json-<model>.jsonl` |

`prod-direct` builds each case's prompt with `renderNeoRouteContext` and `buildNeoRoutePrompt`,
and sends it with `neoRouteHttpCall`, so it matches what production sends; it can't run the
embedding fallback. Each log line also records `thinkingBlocks`, `stopReason` and `unparsed`.
The thinking-off, cap and JSON experiments in [`production-path.md`](production-path.md) ran
from one-off probe scripts; only their summary counts were kept. The shipped JSON format was
then re-run through `prod-direct` with per-route logs (`tts-json-*`). `rawAnswer` keeps the first
200 characters of each reply.
