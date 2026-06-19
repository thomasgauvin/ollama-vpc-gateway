# ollama-vpc-gateway

A Cloudflare Worker that securely exposes a **local Ollama** instance to **AI Gateway** as a custom provider — without ever putting Ollama on the public internet.

Ollama has no built-in authentication, so you can't safely point AI Gateway at a public tunnel hostname. This Worker solves that: it sits behind AI Gateway, validates a single bearer token (stored in AI Gateway via BYOK), and forwards requests to Ollama over a **private** [Workers VPC](https://developers.cloudflare.com/workers-vpc/) binding + [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/). Ollama only ever listens on `localhost`.

## How it works

```
client
  └─(cf-aig-authorization)──▶ AI Gateway
        └─(Authorization: Bearer SECRET, injected by BYOK)──▶ Worker  (validates + strips the token)
              └─ env.OLLAMA.fetch() ──▶ VPC Service ──▶ private Cloudflare Tunnel ──▶ localhost:11434 Ollama
```

Every hop requires a secret, and Ollama is never directly reachable from the internet:

- **client → AI Gateway** is gated by the gateway's `cf-aig-authorization` token (Authenticated Gateway).
- **AI Gateway → Worker** carries `Authorization: Bearer <SECRET>`, injected from AI Gateway's stored key (BYOK) — the client never sees it.
- **Worker → Ollama** travels over a private VPC Service binding through a Cloudflare Tunnel. The tunnel is the only ingress; Ollama stays bound to `127.0.0.1`.

Why a Worker and not Cloudflare Access? AI Gateway's BYOK injects the key as `Authorization: Bearer <value>`, which is incompatible with Access's expected credential formats. The Worker validates that bearer in code, so BYOK works cleanly.

## Features

- **Ollama never exposed publicly** — reachable only through the private VPC binding.
- **Single shared secret**, stored in AI Gateway (BYOK) — not in your client code.
- **OpenAI-compatible** — works with `/v1/chat/completions` and any other Ollama path (paths pass through verbatim).
- **Constant-time token comparison** via `crypto.subtle.timingSafeEqual`.
- **Tiny** — one file, no runtime dependencies.

## Requirements

- A Cloudflare account with AI Gateway and Workers VPC (beta) access.
- [Ollama](https://ollama.com/) running locally with at least one model pulled.
- A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) connecting your machine to Cloudflare.
- `wrangler` and `cloudflared` installed.

## Setup

### 1. Run Ollama and a tunnel

```bash
ollama serve            # listens on 127.0.0.1:11434
ollama pull gemma3:27b  # or any model
cloudflared tunnel run <your-tunnel>
```

### 2. Create a VPC Service

In the dashboard (**Workers & Pages → VPC → Create → VPC Service**), or via `wrangler`, create an **HTTP** service pointing at host `localhost`, port `11434`, through your tunnel. Copy the resulting **Service ID**.

### 3. Configure and deploy the Worker

Set your Service ID in `wrangler.jsonc` (`vpc_services[].service_id`), then:

```bash
npm install
npm run cf-typegen
npm run deploy
```

### 4. Create and bind the shared secret (Secrets Store)

Generate a strong secret (256 bits):

```bash
openssl rand -hex 32
```

Create it in [Secrets Store](https://developers.cloudflare.com/secrets-store/) with the `workers` scope, then bind it in `wrangler.jsonc` (`secrets_store_secrets[].store_id` / `secret_name`):

```bash
npx wrangler secrets-store store list                       # find your store ID
echo -n "<secret>" | npx wrangler secrets-store secret create <STORE_ID> \
  --name ollama_gateway_secret --scopes workers --remote
```

The Worker reads it at runtime via `await env.OLLAMA_SECRET.get()`.

### 5. Register the custom provider + BYOK

1. **AI Gateway → Custom Providers → Add Provider.** Set the **Base URL** to your Worker URL (e.g. `https://ollama-vpc-gateway.<subdomain>.workers.dev`). Note the slug — it becomes `custom-<slug>` in requests.
2. **Your gateway → Provider Keys → Add Key** for that provider. Paste the **same** `OLLAMA_SECRET` value. This is the BYOK key AI Gateway injects as `Authorization: Bearer …`.

> The secret on the Worker and the BYOK key in AI Gateway **must match** — that's the auth handshake.

## Usage

Once everything is wired, call your local model through AI Gateway with no provider key in the client:

```bash
curl -X POST "https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway>/custom-<slug>/v1/chat/completions" \
  -H "cf-aig-authorization: Bearer <CF_AIG_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma3:27b","messages":[{"role":"user","content":"Hello!"}]}'
```

## Development

```bash
npm install
npm run dev    # local dev (VPC bindings require remote mode / deploy)
npm test       # vitest
```

The auth layer is covered by unit tests (the 401 paths). For full local runs, create a local Secrets Store secret (omit `--remote`) so the `OLLAMA_SECRET` binding resolves in dev.

## Security notes

- Keep Ollama bound to `127.0.0.1` — never `0.0.0.0`.
- Rotate the secret by updating both the Worker secret and the BYOK key (they must stay in sync).
- Enable Authenticated Gateway on your AI Gateway so the gateway URL itself requires a token.

### Secrets Store

Both sides of the handshake live in [Cloudflare Secrets Store](https://developers.cloudflare.com/secrets-store/):

- The **Worker** reads a `workers`-scoped secret (`ollama_gateway_secret`) via its binding.
- **AI Gateway BYOK** stores its key in a separate, `ai_gateway`-scoped secret it manages automatically (named `{gateway_id}_{provider_slug}_{alias}`).

AI Gateway pins its secret to the `ai_gateway` scope, so a Worker binding cannot reuse it — the two are distinct secrets that must hold the **same value**. Rotate by updating both (the Worker's Secrets Store secret and the BYOK key).

## License

MIT
