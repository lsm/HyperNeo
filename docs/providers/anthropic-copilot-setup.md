# Anthropic-Copilot Provider Setup

This document covers how to configure the `anthropic-copilot` provider in HyperNeo, which bridges to GitHub Copilot as an Anthropic-compatible API.

## Overview

The `anthropic-copilot` provider exposes GitHub Copilot as an Anthropic-compatible API endpoint. This allows HyperNeo to use Copilot models (like `claude-opus-4.6`, `claude-sonnet-4.6`, `gpt-5.3-codex`, `gemini-3-pro-preview`, `gpt-5-mini`) through the standard Anthropic API interface.

### What It Does

- Exposes Copilot models via an Anthropic-shaped `/v1/messages` endpoint
- Bridges tool-use/tool-result calls to Copilot's native tool system
- Supports streaming responses via Server-Sent Events (SSE)

### Provider Capability Flags

| Capability | `anthropic` | `anthropic-copilot` |
|------------|-------------|---------------------|
| Streaming | ✅ | ✅ |
| Function Calling | ✅ | ✅ |
| Vision | ✅ | ❌ |
| Extended Thinking | ✅ | ❌ |

---

## Authentication Methods

The provider discovers GitHub credentials in the following order:

1. **`~/.neokai/auth.json`** — Stored credentials from a previously completed HyperNeo GitHub OAuth device flow
2. **`COPILOT_GITHUB_TOKEN`** — Environment variable with a fine-grained PAT
3. **`GH_TOKEN`** — Environment variable (fallback)
4. **`gh auth token`** — CLI command output
5. **`~/.config/gh/hosts.yml`** — OAuth token from GitHub CLI configuration

> **Important:** The `GITHUB_TOKEN` environment variable (used by GitHub Actions) is **NOT** used — it lacks the required `copilot_requests` scope. Classic PATs (tokens starting with `ghp_`) are **hard rejected** by the Copilot CLI.

### Option 1: HyperNeo GitHub OAuth (Recommended)

HyperNeo includes a built-in GitHub OAuth device flow specifically for Copilot authentication.

**To trigger the OAuth flow:**
1. Open HyperNeo in your browser
2. Navigate to Settings → Authentication (or provider settings)
3. Look for "Connect GitHub" or similar option to initiate the OAuth flow
4. You'll receive a **device code** (e.g., `ABCD-1234`) displayed in HyperNeo
5. Visit the verification URL (typically `github.com/login/device`) and enter the device code
6. Complete the GitHub authorization in your browser
7. Return to HyperNeo — the connection should complete automatically

The OAuth token is stored in `~/.neokai/auth.json` and automatically used on subsequent sessions.

### Option 2: COPILOT_GITHUB_TOKEN Environment Variable

> **Important:** You MUST use a **fine-grained PAT**, not a classic PAT. Classic PATs (starting with `ghp_`) are hard rejected by the GitHub Copilot CLI.

Set a fine-grained Personal Access Token:

```bash
# In your shell or .env file
export COPILOT_GITHUB_TOKEN=github_pat_your_token_here
```

To create a fine-grained PAT:
1. Go to GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Generate new token with:
   - Token name: HyperNeo Copilot
   - Repository access: All repositories
   - Permissions: Copilot (Access: read/write)

> **Note:** Classic PATs (starting with `ghp_`) are NOT supported and will be rejected with the error: "Classic PATs (ghp_...) are not supported by the GitHub Copilot CLI."

### Option 3: GH_TOKEN Environment Variable

If you have a fine-grained GitHub token already set in your environment:

```bash
export GH_TOKEN=github_pat_your_token_here
```

### Option 4: gh auth login

If you have the GitHub CLI installed and authenticated:

```bash
gh auth login
```

The provider will use `gh auth token` to retrieve your authentication token. This returns an OAuth token (not a classic PAT), which is supported.

### Option 5: ~/.config/gh/hosts.yml

If you've authenticated via GitHub CLI, your OAuth token is stored in `~/.config/gh/hosts.yml`. The provider automatically reads the `oauth_token` from this file.

---

## Step-by-Step Setup

### Step 1: Choose Your Authentication Method

For most users, **Option 1 (HyperNeo GitHub OAuth)** is recommended:
1. Open HyperNeo settings and initiate the GitHub OAuth flow
2. Authorize HyperNeo to access your GitHub account for Copilot
3. Credentials are stored automatically

### Alternative: Using GitHub CLI

1. Install GitHub CLI if not installed: `brew install gh`
2. Authenticate: `gh auth login`
3. Ensure Copilot is enabled in your GitHub account settings
4. The provider will automatically discover your token

### Step 2: Verify Configuration

Start HyperNeo and check the provider status in the UI. You should see Copilot models available when:
- The provider indicator shows green (authenticated)
- Copilot models appear in the model picker

---

## Troubleshooting

### Classic PAT Rejection

**Symptom:** Authentication fails with error: "Classic PATs (ghp_...) are not supported by the GitHub Copilot CLI."

**Cause:** You're using a classic PAT (token starting with `ghp_`). Classic PATs are hard rejected by Copilot.

**Solution:**
1. Go to GitHub Settings → Developer settings → Personal access tokens
2. Delete any classic PATs you may have created
3. Create a **fine-grained token** instead:
   - Token name: HyperNeo Copilot
   - Repository access: All repositories
   - Permissions: Copilot (Access: read/write)
4. Use the new fine-grained token (starts with `github_pat_`, not `ghp_`)

### Token Validation Failures

**Symptom:** "Token validation failed" or similar authentication error

**Cause:** Tokens obtained via `gh auth token` or `~/.config/gh/hosts.yml` are OAuth tokens that must be exchanged for a Copilot session token.

**Solution:**
- The provider automatically performs this exchange for tokens from sources 4 and 5
- For enterprise GitHub accounts, ensure Copilot is enabled in your organization

### Enterprise GitHub

**Symptom:** Authentication works but returns no models or "Copilot not enabled"

**Cause:** Your GitHub Enterprise organization may have Copilot disabled or require additional permissions.

**Solution:**
1. Contact your organization admin to enable Copilot
2. Ensure you have Copilot access granted in your organization settings
3. For enterprise-managed users, you may need to use a fine-grained PAT with organization-specific scopes

### Linux Specific: Node.js Version

**Symptom:** Provider fails to start on Linux with "node:sqlite" module error

**Cause:** The Copilot CLI subprocess requires Node.js >= 22.5.0 with `node:sqlite` support.

**Solution:**
- On Linux, ensure Node.js 22 LTS or Node.js 24 is installed and available on PATH
- On macOS, this is handled automatically by Bun

---

## Known Limitations

### No Vision Support

The Copilot bridge does **not** support image input or multimodal content. Attempting to send images will result in an error.

### No Extended Thinking

Extended thinking (thinking blocks in API responses) is not supported by Copilot and therefore not available through this bridge.

### Heuristic Token Counting

Token usage (`input_tokens`, `output_tokens`) is estimated based on character count (1 token ≈ 4 characters) rather than actual counts from Copilot. This is due to SDK limitations.

### Text-Flattened Conversation Semantics

The Copilot bridge flattens the full block-structured Anthropic conversation to plain text rather than preserving the structured message format. This means:
- Multi-message conversations are converted to a single text prompt
- Role information is preserved through bracketed prefixes (e.g., `[User]:`, `[Assistant]:`)
- Some semantic nuances of structured messages may be lost

### tool_choice Limitations

The `tool_choice` parameter is accepted for API compatibility but is **not honored** by the Copilot bridge. The model will decide which tool to use regardless of the parameter value.

### Request Parameter Restrictions

The following Anthropic API parameters are not forwarded to Copilot:
- `temperature`, `top_p`, `top_k`
- `stop_sequences`
- Advanced sampling controls

### Non-Streaming Not Supported

The bridge requires `stream=true`. Requests with `stream=false` will receive a 400 error.
