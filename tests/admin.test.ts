import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	handleLinkPost,
	handleLinkDelete,
	handleLinkGet,
} from "../src/admin";
import { createEnv } from "./helpers";
import worker from "../src/index";
import type { Env } from "../src/types";

const U1 = "123456789012345678";
const U2 = "223456789012345678";

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
			authReq("POST", { email: "A@B.co", discord_user_id: U1 }),
			env,
		);
		expect(res.status).toBe(200);
		expect(await env.GHOST_DISCORD_MAPPING.get("a@b.co")).toBe(U1);
		expect(await env.GHOST_DISCORD_MAPPING.get(`discord:${U1}`)).toBe("a@b.co");
	});

	it("rejects a discord_user_id that is not a snowflake", async () => {
		for (const id of ["u1", "123", "123456789012345678/../../x", "12345678901234567890123"]) {
			const res = await handleLinkPost(authReq("POST", { email: "a@b.co", discord_user_id: id }), env);
			expect(res.status).toBe(400);
		}
	});

	it("drops stale reverse entries when relinking", async () => {
		await env.GHOST_DISCORD_MAPPING.put("a@b.co", U1);
		await env.GHOST_DISCORD_MAPPING.put(`discord:${U1}`, "a@b.co");
		await env.GHOST_DISCORD_MAPPING.put("old@b.co", U2);
		await env.GHOST_DISCORD_MAPPING.put(`discord:${U2}`, "old@b.co");

		const res = await handleLinkPost(authReq("POST", { email: "a@b.co", discord_user_id: U2 }), env);
		expect(res.status).toBe(200);
		expect(await env.GHOST_DISCORD_MAPPING.get("a@b.co")).toBe(U2);
		expect(await env.GHOST_DISCORD_MAPPING.get(`discord:${U2}`)).toBe("a@b.co");
		expect(await env.GHOST_DISCORD_MAPPING.get(`discord:${U1}`)).toBeNull();
		expect(await env.GHOST_DISCORD_MAPPING.get("old@b.co")).toBeNull();
	});
});

describe("DELETE /link", () => {
	let env: Env;
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		env = createEnv();
		fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
	});
	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("removes both roles, then clears both directions", async () => {
		await env.GHOST_DISCORD_MAPPING.put("a@b.co", U1);
		await env.GHOST_DISCORD_MAPPING.put(`discord:${U1}`, "a@b.co");
		const res = await handleLinkDelete(authReq("DELETE", { email: "a@b.co" }), env);
		expect(res.status).toBe(200);
		expect(await env.GHOST_DISCORD_MAPPING.get("a@b.co")).toBeNull();
		expect(await env.GHOST_DISCORD_MAPPING.get(`discord:${U1}`)).toBeNull();
		const calls = fetchSpy.mock.calls.map((c) => [String(c[0]), (c[1] as RequestInit).method]);
		expect(calls).toEqual([
			[expect.stringContaining(`/members/${U1}/roles/${env.DISCORD_ROLE_MEMBER}`), "DELETE"],
			[expect.stringContaining(`/members/${U1}/roles/${env.DISCORD_ROLE_PREMIUM}`), "DELETE"],
		]);
	});

	it("keeps the mapping and returns 502 when role removal fails", async () => {
		fetchSpy.mockImplementation(async () => new Response("forbidden", { status: 403 }));
		await env.GHOST_DISCORD_MAPPING.put("a@b.co", U1);
		await env.GHOST_DISCORD_MAPPING.put(`discord:${U1}`, "a@b.co");
		const res = await handleLinkDelete(authReq("DELETE", { email: "a@b.co" }), env);
		expect(res.status).toBe(502);
		expect(await env.GHOST_DISCORD_MAPPING.get("a@b.co")).toBe(U1);
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

describe("GET /link/<malformed>", () => {
	it("returns 400 instead of throwing on bad percent-encoding", async () => {
		const res = await worker.fetch(
			new Request("http://test/link/%E0%A4%A", { headers: { Authorization: "Bearer test-admin-secret" } }),
			createEnv(),
			{} as ExecutionContext,
		);
		expect(res.status).toBe(400);
	});
});
