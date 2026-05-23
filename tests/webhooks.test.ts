import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	handleMemberAdded,
	handleMemberUpdated,
	handleMemberDeleted,
} from "../src/webhooks";
import { createEnv, signedGhostWebhook } from "./helpers";
import type { Env } from "../src/types";

const URL_ADDED = "http://test/webhook/added";
const URL_UPDATED = "http://test/webhook/updated";
const URL_DELETED = "http://test/webhook/deleted";

function setupEnvAndFetch(): {
	env: Env;
	fetchSpy: ReturnType<typeof vi.spyOn>;
} {
	const env = createEnv();
	const fetchSpy = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(new Response(null, { status: 204 }));
	return { env, fetchSpy };
}

describe("handleMemberAdded", () => {
	let env: Env;
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		({ env, fetchSpy } = setupEnvAndFetch());
	});
	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("rejects missing signature", async () => {
		const res = await handleMemberAdded(
			new Request(URL_ADDED, { method: "POST", body: "{}" }),
			env,
		);
		expect(res.status).toBe(401);
	});

	it("rejects stale timestamp (>5 min)", async () => {
		const body = JSON.stringify({
			member: { current: { email: "a@b.co", status: "free" } },
		});
		const req = await signedGhostWebhook(
			URL_ADDED,
			body,
			env.WEBHOOK_SECRET,
			Date.now() - 10 * 60 * 1000,
		);
		expect((await handleMemberAdded(req, env)).status).toBe(401);
	});

	it("rejects bad HMAC", async () => {
		const body = JSON.stringify({
			member: { current: { email: "a@b.co", status: "free" } },
		});
		const req = await signedGhostWebhook(URL_ADDED, body, "wrong-secret");
		expect((await handleMemberAdded(req, env)).status).toBe(401);
	});

	it("rejects invalid JSON", async () => {
		const req = await signedGhostWebhook(URL_ADDED, "not json", env.WEBHOOK_SECRET);
		expect((await handleMemberAdded(req, env)).status).toBe(400);
	});

	it("rejects payload missing email", async () => {
		const req = await signedGhostWebhook(
			URL_ADDED,
			JSON.stringify({ member: { current: { status: "free" } } }),
			env.WEBHOOK_SECRET,
		);
		expect((await handleMemberAdded(req, env)).status).toBe(400);
	});

	it("skips when no mapping exists", async () => {
		const body = JSON.stringify({
			member: { current: { email: "a@b.co", status: "free" } },
		});
		const req = await signedGhostWebhook(URL_ADDED, body, env.WEBHOOK_SECRET);
		const res = await handleMemberAdded(req, env);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: true,
			skipped: true,
			reason: "no_mapping",
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("free → adds Member role only", async () => {
		await env.GHOST_DISCORD_MAPPING.put("a@b.co", "12345");
		const body = JSON.stringify({
			member: { current: { email: "a@b.co", status: "free" } },
		});
		const req = await signedGhostWebhook(URL_ADDED, body, env.WEBHOOK_SECRET);
		await handleMemberAdded(req, env);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(String(url)).toContain(`/roles/${env.DISCORD_ROLE_MEMBER}`);
		expect((init as RequestInit).method).toBe("PUT");
	});

	it("paid → adds Member + Premium roles", async () => {
		await env.GHOST_DISCORD_MAPPING.put("a@b.co", "12345");
		const body = JSON.stringify({
			member: { current: { email: "a@b.co", status: "paid" } },
		});
		const req = await signedGhostWebhook(URL_ADDED, body, env.WEBHOOK_SECRET);
		await handleMemberAdded(req, env);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
		expect(urls.some((u) => u.endsWith(`/roles/${env.DISCORD_ROLE_MEMBER}`))).toBe(true);
		expect(urls.some((u) => u.endsWith(`/roles/${env.DISCORD_ROLE_PREMIUM}`))).toBe(true);
	});

	it("comped → adds both roles", async () => {
		await env.GHOST_DISCORD_MAPPING.put("a@b.co", "12345");
		const body = JSON.stringify({
			member: { current: { email: "a@b.co", status: "comped" } },
		});
		const req = await signedGhostWebhook(URL_ADDED, body, env.WEBHOOK_SECRET);
		await handleMemberAdded(req, env);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("lowercases email for KV lookup", async () => {
		await env.GHOST_DISCORD_MAPPING.put("a@b.co", "12345");
		const body = JSON.stringify({
			member: { current: { email: "A@B.CO", status: "free" } },
		});
		const req = await signedGhostWebhook(URL_ADDED, body, env.WEBHOOK_SECRET);
		await handleMemberAdded(req, env);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});

describe("handleMemberUpdated", () => {
	let env: Env;
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		({ env, fetchSpy } = setupEnvAndFetch());
	});
	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("rejects missing signature", async () => {
		const res = await handleMemberUpdated(
			new Request(URL_UPDATED, { method: "POST", body: "{}" }),
			env,
		);
		expect(res.status).toBe(401);
	});

	it("free→paid → PUT premium", async () => {
		await env.GHOST_DISCORD_MAPPING.put("a@b.co", "12345");
		const body = JSON.stringify({
			member: {
				current: { email: "a@b.co", status: "paid" },
				previous: { status: "free" },
			},
		});
		const req = await signedGhostWebhook(URL_UPDATED, body, env.WEBHOOK_SECRET);
		await handleMemberUpdated(req, env);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(String(url)).toContain(`/roles/${env.DISCORD_ROLE_PREMIUM}`);
		expect((init as RequestInit).method).toBe("PUT");
	});

	it("paid→free → DELETE premium", async () => {
		await env.GHOST_DISCORD_MAPPING.put("a@b.co", "12345");
		const body = JSON.stringify({
			member: {
				current: { email: "a@b.co", status: "free" },
				previous: { status: "paid" },
			},
		});
		const req = await signedGhostWebhook(URL_UPDATED, body, env.WEBHOOK_SECRET);
		await handleMemberUpdated(req, env);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(String(url)).toContain(`/roles/${env.DISCORD_ROLE_PREMIUM}`);
		expect((init as RequestInit).method).toBe("DELETE");
	});

	it("paid↔comped → no-op", async () => {
		await env.GHOST_DISCORD_MAPPING.put("a@b.co", "12345");
		const body = JSON.stringify({
			member: {
				current: { email: "a@b.co", status: "comped" },
				previous: { status: "paid" },
			},
		});
		const req = await signedGhostWebhook(URL_UPDATED, body, env.WEBHOOK_SECRET);
		const res = await handleMemberUpdated(req, env);
		expect(res.status).toBe(200);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("same-status update → no-op", async () => {
		await env.GHOST_DISCORD_MAPPING.put("a@b.co", "12345");
		const body = JSON.stringify({
			member: {
				current: { email: "a@b.co", status: "paid" },
				previous: { status: "paid" },
			},
		});
		const req = await signedGhostWebhook(URL_UPDATED, body, env.WEBHOOK_SECRET);
		await handleMemberUpdated(req, env);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("missing previous.status → no-op", async () => {
		await env.GHOST_DISCORD_MAPPING.put("a@b.co", "12345");
		const body = JSON.stringify({
			member: {
				current: { email: "a@b.co", status: "paid" },
				previous: {},
			},
		});
		const req = await signedGhostWebhook(URL_UPDATED, body, env.WEBHOOK_SECRET);
		await handleMemberUpdated(req, env);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("skips when no mapping exists", async () => {
		const body = JSON.stringify({
			member: {
				current: { email: "a@b.co", status: "paid" },
				previous: { status: "free" },
			},
		});
		const req = await signedGhostWebhook(URL_UPDATED, body, env.WEBHOOK_SECRET);
		const res = await handleMemberUpdated(req, env);
		expect(res.status).toBe(200);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("handleMemberDeleted", () => {
	let env: Env;
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		({ env, fetchSpy } = setupEnvAndFetch());
	});
	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("uses previous.email and removes both roles", async () => {
		await env.GHOST_DISCORD_MAPPING.put("a@b.co", "12345");
		const body = JSON.stringify({
			member: { previous: { email: "a@b.co", status: "paid" } },
		});
		const req = await signedGhostWebhook(URL_DELETED, body, env.WEBHOOK_SECRET);
		const res = await handleMemberDeleted(req, env);
		expect(res.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		fetchSpy.mock.calls.forEach(([, init]) => {
			expect((init as RequestInit).method).toBe("DELETE");
		});
	});

	it("rejects payload missing previous.email", async () => {
		const body = JSON.stringify({ member: { previous: { status: "free" } } });
		const req = await signedGhostWebhook(URL_DELETED, body, env.WEBHOOK_SECRET);
		expect((await handleMemberDeleted(req, env)).status).toBe(400);
	});

	it("does NOT delete the KV mapping", async () => {
		await env.GHOST_DISCORD_MAPPING.put("a@b.co", "12345");
		const body = JSON.stringify({
			member: { previous: { email: "a@b.co", status: "paid" } },
		});
		const req = await signedGhostWebhook(URL_DELETED, body, env.WEBHOOK_SECRET);
		await handleMemberDeleted(req, env);
		expect(await env.GHOST_DISCORD_MAPPING.get("a@b.co")).toBe("12345");
	});

	it("skips when no mapping exists", async () => {
		const body = JSON.stringify({
			member: { previous: { email: "missing@b.co", status: "paid" } },
		});
		const req = await signedGhostWebhook(URL_DELETED, body, env.WEBHOOK_SECRET);
		const res = await handleMemberDeleted(req, env);
		expect(res.status).toBe(200);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
