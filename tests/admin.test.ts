import { describe, it, expect, beforeEach } from "vitest";
import {
	handleLinkPost,
	handleLinkDelete,
	handleLinkGet,
} from "../src/admin";
import { createEnv } from "./helpers";
import type { Env } from "../src/types";

function authReq(
	method: string,
	body?: unknown,
	secret = "test-admin-secret",
): Request {
	return new Request("http://test/link", {
		method,
		headers: {
			Authorization: `Bearer ${secret}`,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

describe("POST /link", () => {
	let env: Env;
	beforeEach(() => {
		env = createEnv();
	});

	it("rejects missing Authorization header", async () => {
		const res = await handleLinkPost(
			new Request("http://test/link", { method: "POST", body: "{}" }),
			env,
		);
		expect(res.status).toBe(401);
	});

	it("rejects non-Bearer scheme", async () => {
		const res = await handleLinkPost(
			new Request("http://test/link", {
				method: "POST",
				headers: { Authorization: "Basic foo" },
				body: "{}",
			}),
			env,
		);
		expect(res.status).toBe(401);
	});

	it("rejects wrong secret", async () => {
		const res = await handleLinkPost(
			authReq("POST", { email: "a@b.co", discord_user_id: "u1" }, "wrong"),
			env,
		);
		expect(res.status).toBe(401);
	});

	it("rejects invalid JSON body", async () => {
		const res = await handleLinkPost(
			new Request("http://test/link", {
				method: "POST",
				headers: { Authorization: "Bearer test-admin-secret" },
				body: "not json",
			}),
			env,
		);
		expect(res.status).toBe(400);
	});

	it("rejects missing fields", async () => {
		expect(
			(await handleLinkPost(authReq("POST", { email: "a@b.co" }), env)).status,
		).toBe(400);
		expect(
			(
				await handleLinkPost(
					authReq("POST", { discord_user_id: "u1" }),
					env,
				)
			).status,
		).toBe(400);
	});

	it("rejects bad email format", async () => {
		const res = await handleLinkPost(
			authReq("POST", { email: "not-email", discord_user_id: "u1" }),
			env,
		);
		expect(res.status).toBe(400);
	});

	it("writes both directions and lowercases email", async () => {
		const res = await handleLinkPost(
			authReq("POST", { email: "A@B.co", discord_user_id: "u1" }),
			env,
		);
		expect(res.status).toBe(200);
		expect(await env.GHOST_DISCORD_MAPPING.get("a@b.co")).toBe("u1");
		expect(await env.GHOST_DISCORD_MAPPING.get("discord:u1")).toBe("a@b.co");
	});
});

describe("DELETE /link", () => {
	let env: Env;
	beforeEach(() => {
		env = createEnv();
	});

	it("clears both directions when mapping exists", async () => {
		await env.GHOST_DISCORD_MAPPING.put("a@b.co", "u1");
		await env.GHOST_DISCORD_MAPPING.put("discord:u1", "a@b.co");
		const res = await handleLinkDelete(authReq("DELETE", { email: "a@b.co" }), env);
		expect(res.status).toBe(200);
		expect(await env.GHOST_DISCORD_MAPPING.get("a@b.co")).toBeNull();
		expect(await env.GHOST_DISCORD_MAPPING.get("discord:u1")).toBeNull();
	});

	it("is idempotent when mapping is absent", async () => {
		const res = await handleLinkDelete(
			authReq("DELETE", { email: "missing@b.co" }),
			env,
		);
		expect(res.status).toBe(200);
	});

	it("rejects bad email format", async () => {
		const res = await handleLinkDelete(authReq("DELETE", { email: "bad" }), env);
		expect(res.status).toBe(400);
	});

	it("rejects missing bearer", async () => {
		const res = await handleLinkDelete(
			new Request("http://test/link", {
				method: "DELETE",
				body: JSON.stringify({ email: "a@b.co" }),
			}),
			env,
		);
		expect(res.status).toBe(401);
	});
});

describe("GET /link/:email", () => {
	let env: Env;
	beforeEach(() => {
		env = createEnv();
	});

	it("returns the mapping when present", async () => {
		await env.GHOST_DISCORD_MAPPING.put("a@b.co", "u1");
		const res = await handleLinkGet("A@B.co", authReq("GET"), env);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			email: "a@b.co",
			discord_user_id: "u1",
		});
	});

	it("404 when missing", async () => {
		const res = await handleLinkGet("missing@b.co", authReq("GET"), env);
		expect(res.status).toBe(404);
	});

	it("rejects invalid email format", async () => {
		const res = await handleLinkGet("not-email", authReq("GET"), env);
		expect(res.status).toBe(400);
	});

	it("rejects missing bearer", async () => {
		const res = await handleLinkGet(
			"a@b.co",
			new Request("http://test/link/a", { method: "GET" }),
			env,
		);
		expect(res.status).toBe(401);
	});
});
