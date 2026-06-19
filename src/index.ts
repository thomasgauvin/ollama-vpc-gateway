/**
 * Ollama VPC Gateway
 *
 * Sits in front of a local Ollama instance (localhost:11434) that is reachable
 * only through a private Cloudflare Tunnel + Workers VPC Service binding (OLLAMA).
 *
 * Flow:
 *   client -> AI Gateway (cf-aig-authorization)
 *          -> [BYOK injects Authorization: Bearer OLLAMA_SECRET]
 *          -> this Worker (validates the bearer)
 *          -> env.OLLAMA.fetch() over the VPC Service
 *          -> localhost:11434 Ollama
 *
 * The VPC Service config pins the target to localhost:11434, so the URL host
 * below only sets the Host header (Ollama requires a localhost Host).
 */

interface Env {
	// VPC Service binding configured in wrangler.jsonc
	OLLAMA: { fetch: typeof fetch };
	// Secrets Store binding holding the shared bearer token. Must match the
	// AI Gateway BYOK key for this provider. Resolved at runtime via .get().
	OLLAMA_SECRET: { get(): Promise<string> };
}

function timingSafeEqual(a: string, b: string): boolean {
	const enc = new TextEncoder();
	const ab = enc.encode(a);
	const bb = enc.encode(b);
	if (ab.byteLength !== bb.byteLength) return false;
	return crypto.subtle.timingSafeEqual(ab, bb);
}

export default {
	async fetch(request, env): Promise<Response> {
		// 1. Enforce the shared secret (injected upstream by AI Gateway BYOK).
		const auth = request.headers.get("Authorization") ?? "";
		const secret = await env.OLLAMA_SECRET.get();
		const expected = `Bearer ${secret}`;
		if (!secret || !timingSafeEqual(auth, expected)) {
			return new Response("Unauthorized", { status: 401 });
		}

		// 2. Rebuild the request for the private Ollama service.
		//    Only the path + query matter; the VPC Service pins host:port.
		//    Host must be "localhost" so Ollama accepts it.
		const url = new URL(request.url);
		const upstreamUrl = `http://localhost${url.pathname}${url.search}`;

		const upstream = new Request(upstreamUrl, request);
		// Ollama doesn't need (and shouldn't see) the gateway secret.
		upstream.headers.delete("Authorization");

		// 3. Forward over the VPC Service binding.
		return env.OLLAMA.fetch(upstream);
	},
} satisfies ExportedHandler<Env>;
