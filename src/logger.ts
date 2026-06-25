/**
 * Structured JSON logger for Cloudflare Workers.
 *
 * All output is written via console.log() so it appears in Workers Logs /
 * wrangler tail / Dashboard Observability.  Each line is a single JSON object
 * making it easy to filter and search in the Cloudflare dashboard.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

/** Safe stringification that handles BigInt and circular references. */
function safeStringify(obj: unknown): string {
	try {
		return JSON.stringify(obj, (_key, value) => {
			if (typeof value === "bigint") return value.toString();
			if (value instanceof Error)
				return { name: value.name, message: value.message, stack: value.stack };
			return value;
		});
	} catch {
		return "[unserializable]";
	}
}

/** Redact sensitive values from a header string. */
function redactHeader(value: string | null): string | null {
	if (!value) return value;
	if (value.length <= 12) return "***";
	return value.slice(0, 6) + "..." + value.slice(-3);
}

export interface LogEntry {
	timestamp: string;
	level: LogLevel;
	message: string;
	requestId: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	[key: string]: any;
}

export class Logger {
	private readonly minLevel: LogLevel;
	private readonly context: Record<string, unknown>;
	readonly requestId: string;

	constructor(
		minLevel: LogLevel = "info",
		context: Record<string, unknown> = {}
	) {
		this.minLevel = minLevel;
		this.requestId = (context.requestId as string) ?? crypto.randomUUID();
		this.context = { ...context, requestId: this.requestId };
	}

	child(extra: Record<string, unknown>): Logger {
		return new Logger(this.minLevel, { ...this.context, ...extra });
	}

	private shouldLog(level: LogLevel): boolean {
		return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel];
	}

	private write(level: LogLevel, message: string, extra: Record<string, unknown> = {}): void {
		if (!this.shouldLog(level)) return;

		const entry: LogEntry = {
			timestamp: new Date().toISOString(),
			level,
			message,
			...this.context,
			...extra,
		};

		// Use console.log for everything so Cloudflare Workers Logs ingests it.
		console.log(safeStringify(entry));
	}

	debug(message: string, extra?: Record<string, unknown>): void {
		this.write("debug", message, extra);
	}
	info(message: string, extra?: Record<string, unknown>): void {
		this.write("info", message, extra);
	}
	warn(message: string, extra?: Record<string, unknown>): void {
		this.write("warn", message, extra);
	}
	error(message: string, extra?: Record<string, unknown>): void {
		this.write("error", message, extra);
	}

	/** Log an incoming Request (headers redacted). */
	logRequest(request: Request, extra?: Record<string, unknown>): void {
		const headers: Record<string, string> = {};
		request.headers.forEach((v, k) => {
			headers[k] = k.toLowerCase() === "authorization" ? (redactHeader(v) ?? "") : v;
		});

		// Extract Cloudflare request metadata (colo, geo) when available. On the
		// real edge `request.cf` is populated; in tests/local dev it is absent.
		const cf = (request as Request & { cf?: Record<string, unknown> }).cf;
		const cfMeta = cf
			? {
					colo: cf.colo,
					country: cf.country,
					city: cf.city,
					region: cf.region,
					asn: cf.asn,
					httpProtocol: cf.httpProtocol,
					tlsVersion: cf.tlsVersion,
					tlsCipher: cf.tlsCipher,
				}
			: undefined;

		this.info("request_received", {
			method: request.method,
			url: request.url,
			path: new URL(request.url).pathname,
			headers,
			cf: cfMeta,
			contentLength: request.headers.get("content-length"),
			...extra,
		});
	}

	/** Log an outgoing upstream Request (headers redacted). */
	logUpstreamRequest(request: Request, extra?: Record<string, unknown>): void {
		const headers: Record<string, string> = {};
		request.headers.forEach((v, k) => {
			headers[k] = k.toLowerCase() === "authorization" ? (redactHeader(v) ?? "") : v;
		});

		this.info("upstream_request", {
			method: request.method,
			url: request.url,
			path: new URL(request.url).pathname,
			headers,
			contentLength: request.headers.get("content-length"),
			...extra,
		});
	}

	/** Log a Response without consuming its body. */
	logResponse(response: Response, extra?: Record<string, unknown>): void {
		const headers: Record<string, string> = {};
		response.headers.forEach((v, k) => {
			headers[k] = v;
		});

		this.info("response_sent", {
			status: response.status,
			statusText: response.statusText,
			headers,
			...extra,
		});
	}

	/**
	 * Clone a Response, read its body for logging, and return a fresh Response
	 * with the same body so the caller can still use it.
	 */
	async logResponseBody(
		response: Response,
		options: { maxChars?: number; label?: string } = {}
	): Promise<{ text: string; freshResponse: Response }> {
		const { maxChars = 8192, label = "response_body" } = options;
		const clone = response.clone();
		let text = "";
		try {
			text = await clone.text();
		} catch (err) {
			this.warn("failed_to_read_response_body", { error: String(err) });
		}

		const truncated = text.length > maxChars;
		const preview = truncated ? text.slice(0, maxChars) + "… [truncated]" : text;

		this.debug(label, {
			bodyLength: text.length,
			truncated,
			body: preview,
		});

		// Rebuild the response so the original stream remains usable.
		const freshResponse = new Response(text, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});

		return { text, freshResponse };
	}

	/**
	 * Attempt to parse and log a JSON request body without consuming the
	 * original Request. Returns a fresh Request with the same body.
	 */
	async logRequestBody(
		request: Request,
		options: { maxChars?: number; label?: string } = {}
	): Promise<{ json: unknown | null; freshRequest: Request }> {
		const { maxChars = 4096, label = "request_body" } = options;
		const contentType = request.headers.get("content-type") ?? "";

		if (!contentType.includes("application/json")) {
			this.debug("request_body_skipped", { contentType, reason: "not_json" });
			return { json: null, freshRequest: request };
		}

		const clone = request.clone();
		let text = "";
		try {
			text = await clone.text();
		} catch (err) {
			this.warn("failed_to_read_request_body", { error: String(err) });
			return { json: null, freshRequest: request };
		}

		let json: unknown | null = null;
		try {
			json = JSON.parse(text);
		} catch {
			// Not valid JSON — still log the raw text for debugging.
		}

		const truncated = text.length > maxChars;
		const preview = truncated ? text.slice(0, maxChars) + "… [truncated]" : text;

		this.debug(label, {
			bodyLength: text.length,
			truncated,
			parsed: json !== null,
			body: json ?? preview,
		});

		const freshRequest = new Request(request.url, {
			method: request.method,
			headers: request.headers,
			body: text,
		});

		return { json, freshRequest };
	}
}
