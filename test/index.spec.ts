import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// A minimal env for the auth-gate tests. The OLLAMA VPC binding is never
// reached on the unauthorized paths, so a stub that throws is sufficient to
// prove we reject before forwarding.
const testEnv = {
	OLLAMA_SECRET: "test-secret",
	OLLAMA: {
		fetch: async () => {
			throw new Error("VPC binding should not be called on unauthorized requests");
		},
	},
} as unknown as Parameters<typeof worker.fetch>[1];

describe("auth gate", () => {
	it("returns 401 when no Authorization header is present", async () => {
		const request = new IncomingRequest("https://example.com/api/tags");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it("returns 401 when the bearer token does not match", async () => {
		const request = new IncomingRequest("https://example.com/api/tags", {
			headers: { Authorization: "Bearer wrong-secret" },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});
});
