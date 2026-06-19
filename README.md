# ollama-vpc-gateway

A Cloudflare Worker that exposes a **local Ollama** instance to **AI Gateway** as a custom provider — without ever putting Ollama on the public internet.

Ollama has no authentication, so you can't safely point AI Gateway at a public tunnel hostname. This Worker sits behind AI Gateway, validates a bearer token (stored via BYOK), and forwards requests to Ollama over a **private** [Workers VPC](https://developers.cloudflare.com/workers-vpc/) binding + [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/). Ollama only ever listens on `localhost`.

## How it works

```
client ─(cf-aig-authorization)─▶ AI Gateway
   ─(Authorization: Bearer SECRET, injected by BYOK)─▶ Worker (validates + strips token)
      ─ env.OLLAMA.fetch() ─▶ VPC Service ─▶ private Tunnel ─▶ localhost:11434 Ollama
```

Every hop needs a secret and Ollama is never directly reachable. (A Worker is required because BYOK injects `Authorization: Bearer <value>`, which Cloudflare Access can't parse — so the Worker validates the bearer in code instead.)

## Requirements

- A Cloudflare account with AI Gateway and Workers VPC (beta).
- [Ollama](https://ollama.com/) running locally, e.g. `ollama run gemma4:26b-mlx`.
- A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) to your machine, plus `wrangler` and `cloudflared`.

## Setup

1. **Run Ollama + tunnel** (Ollama listens on `127.0.0.1:11434`):
   ```bash
   ollama run gemma4:26b-mlx
   cloudflared tunnel run <your-tunnel>
   ```

2. **Create a VPC Service** (dashboard: *VPC → Create → VPC Service*, or `wrangler`): HTTP, host `localhost`, port `11434`, via your tunnel. Set the resulting Service ID in `wrangler.jsonc` (`vpc_services[].service_id`).

3. **Create + bind the secret** in [Secrets Store](https://developers.cloudflare.com/secrets-store/) (the Worker reads it via `await env.OLLAMA_SECRET.get()`):
   ```bash
   npx wrangler secrets-store store list   # find your store ID
   echo -n "$(openssl rand -hex 32)" | npx wrangler secrets-store secret create <STORE_ID> \
     --name ollama_gateway_secret --scopes workers --remote
   ```
   Set `store_id` / `secret_name` in `wrangler.jsonc` (`secrets_store_secrets`), then deploy:
   ```bash
   npm install && npm run cf-typegen && npm run deploy
   ```

4. **Register the provider + BYOK:**
   - *AI Gateway → Custom Providers → Add Provider* — Base URL = your Worker URL. The slug becomes `custom-<slug>`.
   - *Your gateway → Provider Keys → Add Key* — paste the **same** secret value (this is the BYOK key). It must match the Worker's secret.

## Usage

Call your local model through AI Gateway with no provider key in the client:

```bash
curl -X POST "https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway>/custom-<slug>/v1/chat/completions" \
  -H "cf-aig-authorization: Bearer <CF_AIG_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma4:26b-mlx","messages":[{"role":"user","content":"Hello!"}]}'
```

## Development

```bash
npm install
npm test       # vitest (covers the 401 auth paths)
npm run dev    # VPC bindings require remote mode / deploy
```

## Notes

- Keep Ollama on `127.0.0.1` — never `0.0.0.0`. Enable Authenticated Gateway so the gateway URL itself requires a token.
- The secret lives in Secrets Store twice: a `workers`-scoped secret for the Worker, and an `ai_gateway`-scoped one AI Gateway manages for BYOK. AI Gateway pins its scope, so they can't be merged — keep both in sync when rotating.

## License

MIT
