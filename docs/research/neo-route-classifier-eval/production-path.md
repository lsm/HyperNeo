# Follow-up: the production route path (2026-10-06)

The first round ([README](README.md)) compared models on a harness prompt. This round measures
what production sends after #5714 and #5720:

- the prompt from `renderNeoRouteContext` + `buildNeoRoutePrompt`;
- the direct streamed call from `neoRouteHttpCall`, with `thinking: {type: "disabled"}` and, at
  the time, a 32-token answer cap.

All runs were on tts against the same 105 cases. They led to four changes:

- the routing timeout became a setting, default 15 s (#5748);
- the answer cap went from 32 to 512 tokens (#5754);
- route answers became structured JSON (#5762);
- the recommended routing model is now glm-4.7.

## 1. Production path, 32-token cap

Command: `run.ts --backend prod-direct --base-url <endpoint> --model <id> --key-env <env>`.
Each model got 5 cold calls (a fresh process each, one case) plus a full 105-case run with no
warm-up. "Cold first calls" covers those 5 calls and the first call of the full run. Raw logs:
`results/tts-prod-<model>.jsonl` and `results/tts-prod-<model>-cold.jsonl`.

Endpoints: GLM through `https://open.bigmodel.cn/api/anthropic`, the subscription endpoint the
daemon uses; DeepSeek through `https://api.deepseek.com/anthropic`.

| model | accuracy (all · synthetic · real) | follow-ups → inbox | p50 / p95 ms | warm calls > 4 s | cold first calls | acc. with 4 s timeout | unparsed | thinking blocks | errors | cost / 1k |
|---|---|---|---|---|---|---|---|---|---|---|
| glm-4.7 | 92% · 91% · 94% | 0 / 74 | 1214 / 5045 | 8 / 105 | 4427 ms max, 1 / 6 over 4 s | 88% | 3 | 9 | 0 | $0.34 |
| glm-5-turbo | 88% · 84% · 94% | 2 / 74 | 1197 / 2635 | 4 / 105 | 1888 ms max, 0 / 6 over 4 s | 87% | 2 | 7 | 0 | $0.60 |
| glm-5.3-flash | 95% · 93% · 100% | 0 / 74 | 1211 / 3002 | 5 / 105 | 6094 ms max, 1 / 6 over 4 s | 93% | 9 | 12 | 0 | $0.08 |
| deepseek-flash | 86% · 79% · 100% | 1 / 74 | 968 / 1132 | 0 / 105 | 1216 ms max, 0 / 6 over 4 s | 86% | 0 | 0 | 0 | $0.13 |
| glm-4.7-flash | 61% · 56% · 71% | 5 / 74 | 3325 / 65860 | 28 / 60 | 1459 ms max, 0 / 6 over 4 s | 54% | 3 | 0 | 45 | $0.00 |
| glm-4.7-flashx | 71% · 71% · 71% | 10 / 74 | 3826 / 85815 | 51 / 103 | 13645 ms max, 1 / 6 over 4 s | 64% | 6 | 0 | 2 | $0.08 |

| model | follow up | second last | waiting yes | two waiting | one off | new subject | thanks | long dictated | mixed language | real |
|---|---|---|---|---|---|---|---|---|---|---|
| glm-4.7 | 92% | 100% | 100% | 83% | 75% | 88% | 100% | 83% | 100% | 94% |
| glm-5-turbo | 100% | 100% | 88% | 50% | 75% | 75% | 67% | 100% | 88% | 94% |
| glm-5.3-flash | 100% | 100% | 100% | 83% | 75% | 88% | 100% | 100% | 88% | 100% |
| deepseek-flash | 92% | 100% | 100% | 33% | 100% | 12% | 67% | 83% | 100% | 100% |
| glm-4.7-flash | 17% | 88% | 38% | 67% | 50% | 50% | 67% | 67% | 88% | 71% |
| glm-4.7-flashx | 83% | 88% | 88% | 50% | 100% | 25% | 17% | 100% | 75% | 71% |

- **Unparsed means an empty answer.** Every unparsed reply ended with `stop_reason: max_tokens`
  and no text: the model reasoned despite `thinking: disabled`, and the reasoning used up the 32
  tokens. Production then gets no answer and falls back to the embedding pick; the harness scores
  it as `main`. That inflates GLM-5.3-Flash's 95%, since 9 empty answers counted as correct
  wherever `main` was acceptable. The real "how about 5060 now?" case (`real-35`) came back empty
  on glm-4.7 and GLM-5.3-Flash.
- **Two variants were added without being asked for:** GLM-4.7-Flash and GLM-4.7-FlashX.
  GLM-4.7-Flash, the free tier, returned HTTP 529 "overloaded" on 45 of 105 calls, and both have
  p95 latencies of 66–86 s. Neither is usable for routing.
- **Cold calls:** 24 cold calls across the four main models took 0.65–1.9 s, except one on
  glm-4.7 (4.4 s) and one on GLM-5.3-Flash (6.1 s).
- **Timeout:** under the then-fixed 4 s timeout, glm-4.7 lost 4 points of accuracy (92% → 88%).
  This led to #5747 / #5748: a "Routing timeout" setting in Settings → Neo, default 15 s. Because
  `neo.message.send` routes before it replies, the web send now waits 90 s, covering the largest
  selectable timeout.

## 2. Can reasoning be turned off on GLM?

Zhipu's thinking-mode docs (docs.bigmodel.cn, "思考模式") say GLM-5.2, 5.1, 5 and 4.7 think by
default and that `"thinking": {"type": "disabled"}` turns it off. GLM-5.3 and GLM-5.3-Flash
force thinking, and it cannot be disabled; the native API rejects the request with "该模型始终思考，不支持关闭思考".
Measured with production's prompt and `thinking: disabled`. Only the counts below were kept,
not per-route logs.

| experiment | model | calls | reasoned | empty answers |
|---|---|---|---|---|
| `/api/anthropic`, streamed, cap 32 | glm-4.7 | 105 | 6 | 3 |
| `/api/anthropic`, not streamed, cap 32 | glm-4.7 | 105 | 8 | 1 |
| `/api/anthropic`, streamed, cap 32 | glm-5-turbo | 105 | 12 | 7 |
| `/api/anthropic`, not streamed, cap 32 | glm-5-turbo | 105 | 9 | 4 |
| `/api/coding/paas/v4` (subscription native), cap 32 | glm-4.7 | 105 | 10 | 6 |
| `/api/coding/paas/v4` (subscription native), cap 32 | glm-5-turbo | 105 | 10 | 7 |
| `/api/anthropic`, not streamed, every 3rd case | glm-4.7 / glm-5-turbo | 35 / 35 | 0 / 2 | 0 / 0 |
| `/api/paas/v4` (pay-per-token native), every 3rd case | glm-4.7 / glm-5-turbo | 35 / 35 | 0 / 0 | 0 / 0 |
| `/api/paas/v4`, all cases (first round) | glm-5-turbo | 210 | 0 | 0 |

- **The subscription endpoints ignore the setting.** Both `/api/anthropic` and
  `/api/coding/paas/v4` ignore `thinking: disabled` on roughly 6–12% of calls, whether streamed
  or not.
- **Only the pay-per-token native endpoint honored it,** and that endpoint bills per token
  rather than against the subscription.
- **Forcing a tool call didn't help.** On the 14 cases that had come back empty, a forced
  `route` tool (with `tool_choice` and an enum-constrained `id`):
  - didn't stop the reasoning;
  - was ignored by Zhipu, which still answered in plain text;
  - still returned 3 empty answers;
  - added about 3 s per call (typically about 4.5 s against about 1.5 s).

## 3. A bigger answer cap

Same production path, streamed, cap raised to 1,024 tokens:

| model | correct | reasoned | empty | largest reply | p50 / p95 ms | slowest | over 4 s |
|---|---|---|---|---|---|---|---|
| glm-4.7 | 94 / 105 (90%) | 8 | 0 | 107 tokens | 1280 / 3718 | 12947 | 5 |
| glm-5-turbo | 92 / 105 (88%) | 9 | 0 | 190 tokens | 1212 / 3410 | 19949 | 3 |

With room to finish a stray thought, no answer came back empty. #5753 / #5754 raised the cap to
512 tokens, about 2.5× the largest reply. A normal answer still stops after a few tokens.

## 4. Structured JSON answers

#5761 / #5762 changed the reply to one JSON object in the Jev / Kev / Cloudflare Clef Choice
shape, plus a Neo field:

```json
{"type": "choice", "choice": "<id>", "confidence": 0.9, "basis": "answers_waiting"}
```

`basis` is the routing rule that decided the route: `continues_turn`, `answers_waiting`,
`matches_topic`, `one_off`, `new_subject` or `unsure`. It is stored in the routing log's signal,
e.g. `classifier:answers_waiting`.

Measured with #5762's prompt and parser, the production call, and the cap lifted to 2,048 so
reply lengths were not truncated:

| model | correct | parsed | with confidence | empty | reasoned | output tokens p50 / p95 / max | p50 / p95 / max ms |
|---|---|---|---|---|---|---|---|
| glm-4.7 | 100 / 105 (95%) | 105 | 105 | 0 | 30 | 46 / 114 / 152 | 2158 / 4419 / 7044 |
| glm-5-turbo | 99 / 105 (94%) | 105 | 105 | 0 | 32 | 49 / 119 / 195 | 2325 / 4973 / 9872 |
| GLM-5.3-Flash | 99 / 105 (94%) | 105 | 105 | 0 | 41 | 50 / 135 / 214 | 2355 / 6208 / 9115 |
| DeepSeek Flash | 89 / 105 (85%) | 105 | 105 | 0 | 0 | 48 / 95 / 114 | 1208 / 2063 / 2377 |

- **Every reply parsed** and carried a confidence.
- **Accuracy rose for every GLM model:** glm-4.7 went from 90% to 95%, glm-5-turbo from 88% to
  94%. DeepSeek stayed about level (86% → 85%).
- **Models reasoned more often in this format** (30–41 calls against 6–12), but the larger cap
  absorbed it. The longest reply, reasoning included, was 214 tokens, so the 512 cap stays.
- **The cost is about 1 s per route,** from the longer reply.
- **`basis` was often missing** (it appeared on 20–32 of 105 replies). A missing basis is
  recorded as plain `classifier`.

Only the summary counts of this run were kept. Section 5 repeats it on the shipped code with
per-route logs.

## 5. JSON answers on the shipped code, with per-route logs

The section 4 run repeated on dev `5f08d12`, the code that shipped: #5762's prompt and parser, the
512-token cap and the direct streamed call, through `prod-direct`, with no warm-up. Raw logs:
`results/tts-json-<model>.jsonl`. Each line holds the parsed `confidence` and `basis`. In real
rows, the model's explanation after the basis rule is removed, because it paraphrases the
user's messages.

| model | correct (all · synthetic · real) | follow-ups → inbox | parsed | with confidence | basis exact · rule + explanation · none | empty | reasoned | output tokens p50 / p95 / max | p50 / p95 / max ms | calls > 4 s · > 15 s | cost / 1k |
|---|---|---|---|---|---|---|---|---|---|---|---|
| glm-4.7 | 100 / 105 (95%) · 97% · 91% | 0 / 74 | 105 | 105 | 25 · 63 · 17 | 0 | 31 | 45 / 111 / 207 | 2132 / 5718 / 28210 | 15 · 1 | $0.42 |
| glm-5-turbo | 97 / 105 (92%) · 91% · 94% | 0 / 74 | 105 | 105 | 20 · 67 · 18 | 0 | 30 | 48 / 114 / 327 | 2255 / 5799 / 11770 | 14 · 0 | $0.83 |
| GLM-5.3-Flash | 101 / 105 (96%) · 96% · 97% | 0 / 74 | 105 | 105 | 19 · 72 · 14 | 0 | 31 | 46 / 107 / 261 | 2242 / 7734 / 13963 | 18 · 0 | $0.10 |
| DeepSeek Flash | 91 / 105 (87%) · 83% · 94% | 1 / 74 | 105 | 105 | 23 · 50 · 32 | 0 | 0 | 48 / 91 / 128 | 1088 / 1393 / 1547 | 0 · 0 | $0.06 |

| model | follow up | second last | waiting yes | two waiting | one off | new subject | thanks | long dictated | mixed language | real |
|---|---|---|---|---|---|---|---|---|---|---|
| glm-4.7 | 100% | 100% | 100% | 83% | 100% | 88% | 100% | 100% | 100% | 91% |
| glm-5-turbo | 100% | 100% | 100% | 33% | 100% | 75% | 100% | 100% | 100% | 94% |
| GLM-5.3-Flash | 100% | 100% | 100% | 83% | 100% | 88% | 100% | 83% | 100% | 97% |
| DeepSeek Flash | 100% | 100% | 100% | 33% | 100% | 25% | 83% | 83% | 100% | 94% |

| model | mean confidence, correct | mean confidence, wrong | routes under 0.6 | wrong among them |
|---|---|---|---|---|
| glm-4.7 | 0.86 | 0.57 | 7 | 1 |
| glm-5-turbo | 0.88 | 0.64 | 6 | 3 |
| GLM-5.3-Flash | 0.86 | 0.86 | 6 | 0 |
| DeepSeek Flash | 0.85 | 0.73 | 8 | 2 |

- **Section 4 holds on the shipped code.** Every reply parsed, none came back empty, and the
  largest reply was 327 tokens, inside the 512 cap. glm-4.7 scored 95% again; GLM-5.3-Flash
  96%; DeepSeek Flash 87%.
- **One glm-4.7 call took 28 s,** over the 15 s default timeout. Production would have fallen
  back to the embedding pick for that route. 15 of 105 glm-4.7 calls took over 4 s.
- **Most `basis` values were lost.** Only 19–25 of 105 replies gave the bare rule; 50–72 wrote
  the rule followed by an explanation (`"continues_turn: …"`), which the exact-match parser
  dropped. #5771 / #5772 accept a rule followed by an explanation. The remaining 14–32 gave
  prose with no rule.
- **Confidence separates right from wrong on glm-4.7** (0.86 against 0.57) but not on
  GLM-5.3-Flash. Under 0.6 is too rare (6–8 routes) to act on yet.
- **The recommendation stands:** glm-4.7 on the subscription. GLM-5.3-Flash matches it on
  accuracy but always reasons and has the slowest p95.

## 6. Asking for the bare basis rule

Section 5 found that most replies explained the rule after its name, and 14–32 gave prose with
no rule. The prompt now says `basis is the name of the rule below, exactly as written, with no
explanation.` Same 105 cases, same production path, on the branch for that change. Raw logs:
`results/tts-basis-<model>.jsonl`.

| model | correct (all · synthetic · real) | follow-ups → inbox | basis exact | invalid choice | reasoned | output tokens p50 / p95 / max | p50 / p95 / max ms | calls > 4 s · > 15 s | cost / 1k |
|---|---|---|---|---|---|---|---|---|---|
| glm-4.7 | 100 / 105 (95%) · 94% · 97% | 0 / 74 | 105 | 0 | 41 | 26 / 88 / 161 | 1839 / 4924 / 7683 | 8 · 0 | $0.41 |
| glm-5-turbo | 97 / 105 (92%) · 94% · 89% | 0 / 74 | 105 | 0 | 39 | 26 / 88 / 175 | 1936 / 5286 / 11664 | 12 · 0 | $0.79 |
| GLM-5.3-Flash | 96 / 105 (91%) · 89% · 97% | 0 / 74 | 105 | 1 | 42 | 26 / 105 / 256 | 1759 / 5701 / 20629 | 9 · 1 | $0.09 |
| DeepSeek Flash | 95 / 105 (90%) · 90% · 91% | 0 / 74 | 104 | 1 | 0 | 24 / 27 / 29 | 868 / 1138 / 1317 | 0 · 0 | $0.08 |

| model | follow up | second last | waiting yes | two waiting | one off | new subject | thanks | long dictated | mixed language | real |
|---|---|---|---|---|---|---|---|---|---|---|
| glm-4.7 | 100% | 100% | 100% | 83% | 75% | 88% | 100% | 100% | 100% | 97% |
| glm-5-turbo | 100% | 100% | 100% | 67% | 100% | 75% | 100% | 100% | 100% | 89% |
| GLM-5.3-Flash | 100% | 100% | 100% | 50% | 75% | 75% | 100% | 100% | 88% | 97% |
| DeepSeek Flash | 92% | 100% | 100% | 50% | 100% | 75% | 83% | 100% | 100% | 91% |

- **The basis now survives.** 104–105 of 105 replies gave the exact rule, against 19–25 before.
- **Replies got shorter and faster.** Median output fell from about 46 to 26 tokens. glm-4.7's
  p50 went from 2.1 s to 1.8 s, its slowest call from 28 s to 7.7 s, and calls over 4 s from 15
  to 8.
- **Accuracy held on glm-4.7 (95%) and rose on DeepSeek Flash (87% → 90%).** GLM-5.3-Flash fell
  from 96% to 91%. At 105 cases, a few points is 3–5 routes.
- **"Invalid choice" replies parsed but named no listed id:** GLM-5.3-Flash put the rule name in
  `choice` once, and DeepSeek Flash gave a truncated topic id once. Production treats both as no
  answer and falls back to the embedding pick.
- glm-4.7 stays the recommendation.

## Recommendation

Use **glm-4.7** as the routing model on the GLM subscription, in Settings → Neo → Routing model:

- it is covered by the subscription;
- it scored 95% with JSON answers, twice (sections 4 and 5);
- Zhipu documents a thinking-off switch for it.

Any reasoning that leaks through is absorbed by the 512-token cap and the 15 s timeout.
DeepSeek Flash is the most predictable (no reasoning, p95 about 2 s) but scores 10 points lower
and is billed per token. GLM-5.3-Flash always reasons.

Prices behind the cost column, per million tokens:

| model | input | cached input | output | source |
|---|---|---|---|---|
| GLM-4.7 | ¥2 | ¥0.4 | ¥8 | bigmodel.cn, input under 32K and output under 200 tokens |
| GLM-4.7-FlashX | ¥0.5 | ¥0.1 | ¥3 | bigmodel.cn |
| GLM-4.7-Flash | free | free | free | bigmodel.cn |

Other prices are as in the README. CNY is converted at ¥6.714 per USD.
