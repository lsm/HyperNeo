# 04 — Headroom

**Resource:** https://github.com/chopratejas/headroom  
**Local repo:** `~/focus/tmp/token-efficiency/repos/headroom`  
**Type:** local proxy, SDK, agent wrapper, MCP/tools/hooks  
**Focus:** provider-request compression, structured JSON/log compression, cache alignment, reversible retrieval  
**License:** Apache-2.0

## Architecture

Headroom is a local context-optimization layer for LLM agents and applications. The repo exposes three main modes:

1. **SDK/library:** Python `headroom-ai` and TypeScript `headroom-ai` SDKs wrap OpenAI, Anthropic, Vercel AI, and LangChain-like clients.
2. **Proxy:** local HTTP proxy on port `8787` intercepts Anthropic/OpenAI-compatible traffic.
3. **Agent wrapper:** `headroom wrap claude|codex|cursor|aider|copilot|openclaw` starts the proxy, configures env vars, installs MCP/tools/hooks, and launches the target agent.

Core runtime is Python with Rust acceleration/migration layers. Relevant files include `pyproject.toml`, `Cargo.toml`, `headroom/cli/wrap.py`, and `headroom/cli/init.py`. Rust workspace crates include `headroom-core`, `headroom-proxy`, `headroom-py`, and `headroom-parity`; Python packaging uses maturin to ship `headroom._core`.

## Key mechanisms

Headroom’s request lifecycle is a transform pipeline:

1. cache alignment
2. content routing
3. compression
4. context fitting
5. optional memory/learning
6. provider dispatch

Major components:

- **ContentRouter:** detects content type and routes to specialized compressors.
- **SmartCrusher:** statistical JSON compressor for arrays, logs, search results, metrics, and database rows.
- **CodeCompressor:** AST-aware but conservatively gated.
- **Kompress-base:** optional ML text compression.
- **CacheAligner:** moves dynamic system-prompt fragments so provider prefix caches hit.
- **CCR (Compress-Cache-Retrieve):** stores originals locally and injects retrieval markers/tools.
- **TOIN:** telemetry feedback loop that learns which fields/tools are frequently retrieved.
- **Rolling/intelligent context:** drops or preserves messages based on budget, recency, relevance, errors, and learned retrieval patterns.

## Token-saving techniques

Headroom’s strongest technique is structure-preserving compression, not generic summarization.

For JSON arrays, SmartCrusher extracts constants, samples representative records, preserves first/last slices, and keeps errors, outliers, anomalies, and change points. For shell/tool output, Headroom can bundle or install RTK/lean-ctx-style rewriting so commands like `git status`, `git diff`, tests, logs, package installs, and GitHub queries emit compressed summaries.

The safety model is conservative:

- malformed JSON falls back to original
- parser failures fall back to original
- missing optional dependencies fall back to original
- compression that increases size falls back to original
- active source code is often passed through because stripping code details can break agents

The CCR pattern is especially relevant: compression is reversible through a local retrieval store. Instead of losing raw data, the model gets markers/tools it can use to fetch original details only when needed.

## Claude Code integration

Claude integration spans wrapper, init, hooks, MCP, and memory:

- `headroom wrap claude` starts the proxy and sets `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`.
- Wrapper can configure RTK or lean-ctx, register Headroom MCP, register Serena MCP, and enable memory or code graph features.
- `headroom init claude` writes durable Claude settings. In `headroom/cli/init.py`, `_ensure_claude_hooks` writes `ANTHROPIC_BASE_URL` into `~/.claude/settings.json` or project `.claude/settings.local.json`, then installs `SessionStart` and `PreToolUse` hooks that run `headroom init hook ensure`.
- Plugin hooks live in `plugins/headroom-agent-hooks/hooks/hooks.json`.
- MCP registration uses `claude mcp add` when available, falling back to `~/.claude/.claude.json` or `~/.claude/mcp.json`; see `headroom/mcp_registry/claude.py`.
- `headroom learn` writes learned patterns into `CLAUDE.md` and memory files using marker-delimited sections; see `headroom/learn/writer.py`.

## Effectiveness claims

README claims **60–95% fewer tokens** and a community counter of **60B+ tokens saved**.

Reported examples:

- Code search: **17,765 → 1,408 tokens**, **92%**.
- SRE incident debugging: **65,694 → 5,118**, **92%**.
- GitHub issue triage: **54,174 → 14,761**, **73%**.
- Codebase exploration: **78,502 → 41,254**, **47%**.

`wiki/LATENCY_BENCHMARKS.md` reports average **93% JSON-token reduction** and net latency wins in **11/12** scenarios against Claude Sonnet 4.5 assumptions. The file notes measurements were from v0.3.7 and may not reflect later changes.

## Stack

Primary stack:

- Python 3.10+
- FastAPI, Uvicorn, httpx, MCP, tiktoken, LiteLLM
- Optional ONNX, transformers, torch, tree-sitter, fastembed
- Rust 1.80 workspace with pyo3/maturin
- TypeScript SDK built with tsup/vitest
- Claude, Codex, Copilot, OpenClaw, and agent adapters

## Limitations

- Best for large structured outputs; plain prose gets weaker compression.
- RAG document contexts are often passed through.
- Code compression is intentionally conservative.
- ML compression can add model-load and concurrency costs.
- Cache alignment mainly helps stable system-prefix structure.
- Dynamic-content reshaping may be risky for whitespace-sensitive prompts.
- Local proxy/hook model assumes users can run background local services and safely mutate agent config.

## Actionable takeaways for HyperNeo

1. **Build a transform pipeline before provider calls.** HyperNeo can compress messages and tool outputs before they enter provider context, not only after UI compaction.
2. **Start with structured JSON/log compression.** Savings and correctness are easiest where data has schema or recurring shape.
3. **Make compression reversible.** Store raw tool outputs as artifacts and expose retrieval tools.
4. **Align provider cache prefixes.** Separate stable system prompts from dynamic runtime state so Anthropic prompt caching hits more often.
5. **Learn from retrieval behavior.** Track which compressed fields agents re-open and tune future compression.
6. **Avoid aggressive source-code compression.** Use code graph/index retrieval instead of stripping active code.
7. **Keep config writes idempotent and marker-delimited.** Headroom’s init/hook pattern is powerful but risky without clean ownership boundaries.

## Bottom line

Headroom is broader than a Claude plugin: it is a provider-facing compression proxy. HyperNeo’s strategic lesson is to add reversible, typed compression before provider dispatch, with cache-aware prompt layout and telemetry feedback.
