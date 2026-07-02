# Ollama provider setup

HyperNeo supports both local Ollama and Ollama Cloud as model providers.

## Ollama (Local)

1. Install Ollama from <https://ollama.com/download>.
2. Pull a chat model, for example:

   ```sh
   ollama pull llama3.2
   ```

3. Start Ollama. HyperNeo uses `http://localhost:11434` by default.

Optional configuration:

| Variable | Description |
| --- | --- |
| `OLLAMA_BASE_URL` | Override the local Ollama base URL. Defaults to `http://localhost:11434`. |
| `OLLAMA_API_KEY` | Optional bearer token for protected local deployments. |

HyperNeo lists local models with `GET /api/tags` and sends chat requests to `POST /api/chat` with streaming enabled.

## Ollama Cloud

1. Create an Ollama API key at <https://ollama.com/settings/keys>.
2. Export the key before starting HyperNeo:

   ```sh
   export OLLAMA_CLOUD_API_KEY=your_api_key
   ```

Optional configuration:

| Variable | Description |
| --- | --- |
| `OLLAMA_CLOUD_API_KEY` | Required bearer token for direct Ollama Cloud API access. |
| `OLLAMA_CLOUD_BASE_URL` | Override the cloud API base URL. Defaults to `https://ollama.com`. |

HyperNeo lists cloud models with `GET https://ollama.com/api/tags` and sends chat requests to `POST https://ollama.com/api/chat` using `Authorization: Bearer $OLLAMA_CLOUD_API_KEY`.

## Notes and limitations

- Ollama responses are bridged into the Anthropic-compatible streaming format used by HyperNeo's existing model path.
- Text streaming is supported for both local and cloud providers.
- Tool schemas are forwarded to Ollama's native `tools` field, but full multi-turn tool-call continuation depends on the selected Ollama model's native support.
- Context-window metadata is not returned by `/api/tags`, so HyperNeo uses a conservative default until richer metadata is available.
