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

import { Logger } from "./logger";

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
		const startTime = Date.now();
		const logger = new Logger("debug");
		logger.logRequest(request);

		// ------------------------------------------------------------------
		// 1. Validate the shared secret (injected upstream by AI Gateway BYOK).
		// ------------------------------------------------------------------
		const authHeader = request.headers.get("Authorization") ?? "";
		let secret: string;
		try {
			secret = await env.OLLAMA_SECRET.get();
		} catch (err) {
			logger.error("failed_to_read_secret", { error: String(err) });
			return new Response("Internal Server Error", { status: 500 });
		}

		const expected = `Bearer ${secret}`;
		const authOk = secret && timingSafeEqual(authHeader, expected);

		logger.debug("auth_check", {
			hasAuthHeader: authHeader.length > 0,
			hasSecret: !!secret,
			authOk,
			authHeaderPrefix: authHeader.slice(0, 12) || "<none>",
		});

		if (!authOk) {
			logger.warn("auth_failed", {
				status: 401,
				reason: !secret ? "secret_not_configured" : "bearer_mismatch",
			});
			return new Response("Unauthorized", { status: 401 });
		}

		logger.info("auth_success");

		// ------------------------------------------------------------------
		// 2. Log the request body (JSON) without consuming the original stream.
		// ------------------------------------------------------------------
		const { freshRequest: requestWithBody, json: requestJson } =
			await logger.logRequestBody(request, {
				label: "gateway_request_body",
				maxChars: 4096,
			});

		if (requestJson) {
			logger.debug("request_json_preview", {
				model: (requestJson as Record<string, unknown>)?.model,
				stream: (requestJson as Record<string, unknown>)?.stream,
				messageCount: Array.isArray(
					(requestJson as Record<string, unknown>)?.messages
				)
					? (requestJson as Record<string, unknown>).messages?.length
					: undefined,
			});
		}

		// ------------------------------------------------------------------
		// 3. Rebuild the request for the private Ollama service.
		//    Only the path + query matter; the VPC Service pins host:port.
		//    Host must be "localhost" so Ollama accepts it.
		// ------------------------------------------------------------------
		const url = new URL(requestWithBody.url);
		const upstreamUrl = `http://localhost${url.pathname}${url.search}`;

		const upstream = new Request(upstreamUrl, requestWithBody);
		// Ollama doesn't need (and shouldn't see) the gateway secret.
		upstream.headers.delete("Authorization");
		// Ensure Ollama sees a localhost Host header.
		upstream.headers.set("Host", "localhost");

		logger.logUpstreamRequest(upstream, {
			originalPath: url.pathname,
			originalQuery: url.search,
		});

		// ------------------------------------------------------------------
		// 4. Forward over the VPC Service binding.
		// ------------------------------------------------------------------
		let upstreamResponse: Response;
		try {
			upstreamResponse = await env.OLLAMA.fetch(upstream);
		} catch (err) {
			logger.error("ollama_fetch_failed", {
				error: String(err),
				elapsedMs: Date.now() - startTime,
			});
			return new Response(
				JSON.stringify({
					error: {
						message: "Failed to reach Ollama via VPC Service",
						type: "vpc_service_error",
					},
				}),
				{
					status: 502,
					headers: { "Content-Type": "application/json" },
				}
			);
		}

		const elapsedMs = Date.now() - startTime;

		logger.info("ollama_response_received", {
			status: upstreamResponse.status,
			statusText: upstreamResponse.statusText,
			contentType: upstreamResponse.headers.get("content-type"),
			contentLength: upstreamResponse.headers.get("content-length"),
			elapsedMs,
		});

		// ------------------------------------------------------------------
		// 5. Log the response body so we can debug "Failed to parse model output".
		//    We clone + read the body, then rebuild the response for the client.
		// ------------------------------------------------------------------
		const { text: responseBody, freshResponse } =
			await logger.logResponseBody(upstreamResponse, {
				label: "ollama_response_body",
				maxChars: 16384,
			});

		// Try to detect common error patterns in the body.
		let bodyErrorHint: string | undefined;
		if (!responseBody.trim().startsWith("{") && !responseBody.trim().startsWith("[")) {
			bodyErrorHint = "response_not_json";
		} else if (upstreamResponse.status >= 400) {
			bodyErrorHint = "ollama_returned_error_status";
		}

		if (bodyErrorHint) {
			logger.warn("suspicious_ollama_response", {
				hint: bodyErrorHint,
				status: upstreamResponse.status,
				bodyPreview: responseBody.slice(0, 500),
			});
		}

		// ------------------------------------------------------------------
		// 6. Return the (rebuilt) response to AI Gateway.
		// ------------------------------------------------------------------
		logger.logResponse(freshResponse, { elapsedMs });
		logger.info("request_complete", { elapsedMs });

		return freshResponse;
	},
} satisfies ExportedHandler<Env>;
