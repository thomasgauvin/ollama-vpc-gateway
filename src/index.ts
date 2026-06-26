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
		const authStart = Date.now();
		const authHeader = request.headers.get("Authorization") ?? "";
		let secret: string;
		try {
			secret = await env.OLLAMA_SECRET.get();
		} catch (err) {
			logger.error("failed_to_read_secret", { error: String(err) });
			return new Response("Internal Server Error", {
				status: 500,
				headers: { "x-request-id": logger.requestId },
			});
		}

		const expected = `Bearer ${secret}`;
		const authOk = secret && timingSafeEqual(authHeader, expected);
		const authDurationMs = Date.now() - authStart;

		logger.debug("auth_check", {
			hasAuthHeader: authHeader.length > 0,
			hasSecret: !!secret,
			authOk,
			authHeaderPrefix: authHeader.slice(0, 12) || "<none>",
			authDurationMs,
		});

		if (!authOk) {
			logger.warn("auth_failed", {
				status: 401,
				reason: !secret ? "secret_not_configured" : "bearer_mismatch",
				authDurationMs,
			});
			return new Response("Unauthorized", {
				status: 401,
				headers: { "x-request-id": logger.requestId },
			});
		}

		logger.info("auth_success", { authDurationMs });

		// ------------------------------------------------------------------
		// 2. Log the request body (JSON) without consuming the original stream.
		// ------------------------------------------------------------------
		const bodyReadStart = Date.now();
		const { freshRequest: requestWithBody, json: requestJson } =
			await logger.logRequestBody(request, {
				label: "gateway_request_body",
				maxChars: 4096,
			});
		const bodyReadMs = Date.now() - bodyReadStart;
		logger.debug("request_body_read", {
			bodyReadMs,
			parsed: requestJson !== null,
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
		const upstreamStart = Date.now();
		let upstreamResponse: Response;
		try {
			upstreamResponse = await env.OLLAMA.fetch(upstream);
		} catch (err) {
			logger.error("ollama_fetch_failed", {
				error: String(err),
				upstreamDurationMs: Date.now() - upstreamStart,
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
					headers: {
						"Content-Type": "application/json",
						"x-request-id": logger.requestId,
					},
				}
			);
		}

		const upstreamDurationMs = Date.now() - upstreamStart;
		const elapsedMs = Date.now() - startTime;

		// Detect streaming responses so we can correlate stream parsing issues.
		// Ollama streams via application/x-ndjson (NOT text/event-stream), and
		// may also signal via chunked transfer-encoding.
		const contentType = upstreamResponse.headers.get("content-type") ?? "";
		const transferEncoding = upstreamResponse.headers.get("transfer-encoding") ?? "";
		const clientRequestedStream =
			!!requestJson && (requestJson as Record<string, unknown>).stream === true;
		const isStreaming =
			contentType.includes("text/event-stream") ||
			contentType.includes("application/x-ndjson") ||
			transferEncoding.includes("chunked");

		logger.info("ollama_response_received", {
			status: upstreamResponse.status,
			statusText: upstreamResponse.statusText,
			contentType,
			contentLength: upstreamResponse.headers.get("content-length"),
			isStreaming,
			clientRequestedStream,
			transferEncoding,
			upstreamDurationMs,
			elapsedMs,
		});

		// ------------------------------------------------------------------
		// 5. Forward the response body to the client.
		//    Streaming responses are teed through a TransformStream so chunks
		//    reach the client immediately — buffering would defeat streaming and
		//    break the AI Gateway's SSE parser. Non-streaming responses are
		//    buffered so we can inspect the body for error patterns.
		// ------------------------------------------------------------------
		const shouldStream = isStreaming || clientRequestedStream;

		if (shouldStream) {
			const streamStart = Date.now();
			const streamResponse = logger.streamResponseBody(upstreamResponse, {
				label: "ollama_response_body",
				maxChars: 16384,
				onComplete: ({ chunkCount, totalBytes }) => {
					logger.info("stream_complete", {
						chunkCount,
						totalBytes,
						streamDurationMs: Date.now() - streamStart,
						elapsedMs: Date.now() - startTime,
						authDurationMs,
						bodyReadMs,
						upstreamDurationMs,
					});
				},
			});
			streamResponse.headers.set("x-request-id", logger.requestId);
			logger.logResponse(streamResponse, { elapsedMs, isStreaming: true });
			return streamResponse;
		}

		// Non-streaming: buffer for body inspection + logging.
		const responseReadStart = Date.now();
		const { text: responseBody, freshResponse } =
			await logger.logResponseBody(upstreamResponse, {
				label: "ollama_response_body",
				maxChars: 16384,
			});
		const responseReadMs = Date.now() - responseReadStart;

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
				responseReadMs,
			});
		}

		// ------------------------------------------------------------------
		// 6. Return the response to AI Gateway.
		//    Attach x-request-id so clients can correlate with Workers Logs.
		// ------------------------------------------------------------------
		freshResponse.headers.set("x-request-id", logger.requestId);

		const totalElapsedMs = Date.now() - startTime;
		logger.logResponse(freshResponse, { elapsedMs: totalElapsedMs });
		logger.info("request_complete", {
			elapsedMs: totalElapsedMs,
			authDurationMs,
			bodyReadMs,
			upstreamDurationMs,
			responseReadMs,
		});

		return freshResponse;
	},
} satisfies ExportedHandler<Env>;
