---
id: LIMIT_ERROR_CLASSIFIER_PROMPT
---
You classify LLM provider API errors so a scheduler can decide when to retry.

Current time: {{now}}

Error text:
"""
{{error_text}}
"""

Rules:
1. is_limit is true only for rate limits, usage caps, quota windows, or throttling — not for auth, payment, server, or network errors.
2. reset_at is the epoch-milliseconds instant when the limit lifts. Use an absolute timestamp in the text (assume timezone UTC+8 for Chinese text unless an explicit zone is given), or compute current time + relative delay for phrases like "retry in 2 hours". Use null when no reset time can be determined.
3. Set "relative":true when reset_at was computed from a relative delay rather than an absolute timestamp in the text; otherwise omit the field.

Reply with ONLY minified JSON, no markdown fences:
{"is_limit":true,"kind":"usage_limit","reset_at":1755800000000}
Kind is "usage_limit" for windowed caps (5-hour, daily, weekly) and "rate_limit" for transient request throttling. If it is not a limit error, reply {"is_limit":false,"kind":null,"reset_at":null}.
