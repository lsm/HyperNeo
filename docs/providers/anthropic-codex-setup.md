# Anthropic-Codex Provider Setup

This document covers how to configure the `anthropic-codex` provider in HyperNeo. The provider exposes OpenAI/Codex-family models through an Anthropic-compatible local `/v1/messages` bridge backed by the OpenAI Responses API.

## Overview

The `anthropic-codex` provider lets HyperNeo use Codex models such as `gpt-5.3-codex`, `gpt-5.5`, and `gpt-5.4-mini` through the same Anthropic-shaped SDK path used by other bridge providers.

### What It Does

- Exposes OpenAI/Codex models via an Anthropic-shaped `/v1/messages` endpoint
- Translates Anthropic tool-use/tool-result blocks to OpenAI Responses function calls
- Supports streaming responses via Server-Sent Events (SSE)
- Supports OpenAI Responses reasoning events as Anthropic thinking blocks
- Uses per-session bridge routes so tool-call continuations and reasoning state remain isolated

### Provider Capability Flags

| Capability | `anthropic` | `anthropic-codex` |
|------------|-------------|-------------------|
| Streaming | Yes | Yes |
| Function Calling | Yes | Yes |
| Vision | Yes | No |
| Extended Thinking | Yes | Yes |

---

## Authentication Methods

The provider discovers OpenAI credentials in the following priority order:

1. **`OPENAI_API_KEY`** — Environment variable for direct OpenAI Responses API calls
2. **`~/.hyperneo/auth.json`** — Stored credentials from a previously completed HyperNeo OAuth flow
3. **Legacy OAuth import** — One-time import from `~/.codex/auth.json` for users who previously ran `codex login`

### Option 1: OPENAI_API_KEY

Set your OpenAI API key directly:

```bash
# In your shell or .env file
export OPENAI_API_KEY=sk-your-key-here
```

### Option 2: HyperNeo OAuth (ChatGPT Plus/Pro)

If you have a ChatGPT Plus or Pro subscription:

1. Open HyperNeo in your browser
2. Navigate to Settings → Authentication
3. Log in with your ChatGPT account

The OAuth flow uses a PKCE + redirect flow with a callback server on port 1455. Ensure this port is available before initiating the flow.

### Option 3: Legacy `codex login` Import

Users who previously ran `codex login` may have credentials stored in `~/.codex/auth.json`. HyperNeo imports these credentials once into `~/.hyperneo/auth.json` for first-time use. Runtime requests do not depend on the Codex CLI or the legacy app-server adapter.

---

## Step-by-Step Setup

### Step 1: Configure Authentication

Choose one of the authentication methods above:

#### Option A: Using OPENAI_API_KEY

```bash
# Add to .env or export in shell
OPENAI_API_KEY=sk-your-openai-key
```

#### Option B: Using HyperNeo OAuth

1. Open HyperNeo in your browser
2. Navigate to Settings → Authentication
3. Log in with your ChatGPT account

### Step 2: Verify Configuration

Start HyperNeo and check the provider status in the UI. You should see Codex models available when:

- The provider indicator shows green (authenticated)
- Codex models appear in the model picker

---

## Troubleshooting

### OAuth Token Refresh

**Symptom:** Authentication was working but now fails with "Invalid credentials" or "Token expired".

**Cause:** OAuth tokens may expire over time.

**Solution:** Re-authenticate through HyperNeo's authentication flow. For ChatGPT Plus/Pro, log out and log back in through Settings → Authentication.

### API Key Not Recognized

**Symptom:** "Invalid API key" error despite setting `OPENAI_API_KEY`.

**Solution:**

1. Verify the key is set correctly:
   ```bash
   echo $OPENAI_API_KEY
   ```
2. Ensure there are no extra spaces or quotes in your environment variable
3. Check that you're using a valid API key from [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys)

---

## Known Limitations

### No Vision Support

The OpenAI Responses bridge currently accepts text and tool/function-call traffic only for HyperNeo's Anthropic-compatible SDK path. Image input is not exposed through this provider.

### Heuristic Token Counting

The bridge implements a deterministic local token estimator for `/v1/messages/count_tokens` so SDK context growth remains visible before upstream Responses usage is available.

### Streaming-Only Response

The bridge supports streaming responses only. Requests with `stream=false` are rejected because HyperNeo's SDK integration expects SSE streaming.
