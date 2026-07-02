# OpenRouter Provider Setup

HyperNeo supports OpenRouter through Claude Code's Anthropic-compatible request path.

## Setup

Create an OpenRouter API key, then start HyperNeo with:

```bash
export OPENROUTER_API_KEY=sk-or-...
hyperneo
```

Open **Settings -> Providers** to confirm OpenRouter is authenticated. OpenRouter models appear in new-session and runtime model selectors when the key is present.

## Model Names

OpenRouter model IDs use `provider/model` names. Examples:

- `anthropic/claude-sonnet-4.6`
- `anthropic/claude-opus-4.7`
- `anthropic/claude-haiku-4.5`
- `openrouter/auto`
- `openai/gpt-5.4`

NeoKai sends the selected OpenRouter ID through Claude Code's model tier environment variables so Claude Code still starts with its supported `default` model identifier while OpenRouter receives the selected model.

## Compatibility Notes

Research findings from OpenRouter's Claude Code integration docs:

- Claude Code should use `ANTHROPIC_BASE_URL=https://openrouter.ai/api` for OpenRouter's Anthropic-compatible API.
- The OpenRouter key is passed as the Anthropic auth token: `ANTHROPIC_AUTH_TOKEN=$OPENROUTER_API_KEY`.
- `ANTHROPIC_API_KEY` should be explicitly blank while routing through OpenRouter to avoid conflicts with direct Anthropic credentials.
- OpenRouter's model listing API is under the OpenAI-compatible base URL, `https://openrouter.ai/api/v1/models`, and uses `Authorization: Bearer <OPENROUTER_API_KEY>`.
- Claude Code compatibility is strongest with Anthropic models on OpenRouter. Other OpenRouter models may not support every Claude Code feature, especially extended thinking and native tool-use behavior.

Sources:

- OpenRouter Claude Code integration: https://openrouter.ai/docs/guides/coding-agents/claude-code-integration
- OpenRouter authentication: https://openrouter.ai/docs/api-reference/authentication
- OpenRouter model listing: https://openrouter.ai/docs/api/api-reference/models/get-models
