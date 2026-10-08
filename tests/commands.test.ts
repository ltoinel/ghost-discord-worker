import {
	describe,
	it,
	expect,
	beforeAll,
	beforeEach,
	afterEach,
	vi,
} from "vitest";
import { handleDiscordInteraction } from "../src/commands";
import {
	createEnv,
	signedDiscordInteraction,
	bytesToHex,
} from "./helpers";
import type { Env } from "../src/types";

let privateKey: CryptoKey;
let publicKeyHex: string;

beforeAll(async () => {
	const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	]);
	privateKey = pair.privateKey;
	const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
	publicKeyHex = bytesToHex(raw);
});

/** KV value written by POST /code. */
const pending = (email: string, paid = false) => JSON.stringify({ email, paid });

describe("handleDiscordInteraction", () => {
	let env: Env;
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		env = createEnv({ DISCORD_PUBLIC_KEY: publicKeyHex });
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("rejects missing signature headers", async () => {
		const res = await handleDiscordInteraction(
			new Request("http://test/discord", { method: "POST", body: "{}" }),
			env,
		);
		expect(res.status).toBe(401);
	});

	it("rejects bad signature", async () => {
		const res = await handleDiscordInteraction(
			new Request("http://test/discord", {
				method: "POST",
				headers: {
					"X-Signature-Ed25519": "00".repeat(64),
					"X-Signature-Timestamp": "0",
				},
				body: "{}",
			}),
			env,
		);
		expect(res.status).toBe(401);
	});

	it("returns 401 (not 500) when X-Signature-Ed25519 is non-hex", async () => {
		const res = await handleDiscordInteraction(
			new Request("http://test/discord", {
				method: "POST",
				headers: {
					"X-Signature-Ed25519": "not-hex-at-all-zzz",
					"X-Signature-Timestamp": "0",
				},
				body: "{}",
			}),
			env,
		);
		expect(res.status).toBe(401);
	});

	it("returns 401 (not 500) when signature has odd length", async () => {
		const res = await handleDiscordInteraction(
			new Request("http://test/discord", {
				method: "POST",
				headers: {
					"X-Signature-Ed25519": "abc",
					"X-Signature-Timestamp": "0",
				},
				body: "{}",
			}),
			env,
		);
		expect(res.status).toBe(401);
	});

	it("rejects interactions with no member.user.id or user.id", async () => {
		const req = await signedDiscordInteraction(privateKey, {
			type: 2,
			data: { name: "link", options: [{ value: "ABC12345" }] },
			// no member, no user
		});
		const res = await handleDiscordInteraction(req, env);
		const json = (await res.json()) as any;
		expect(json.data.content).toContain("Unable to identify your Discord account");
	});

	it("falls back to user.id when member is absent (user-app interaction)", async () => {
		await env.GHOST_DISCORD_MAPPING.put("discord:dm-user", "a@b.co");
		await env.GHOST_DISCORD_MAPPING.put("a@b.co", "dm-user");
		fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

		const req = await signedDiscordInteraction(privateKey, {
			type: 2,
			data: { name: "unlink" },
			user: { id: "dm-user" },
		});
		const res = await handleDiscordInteraction(req, env);
		const json = (await res.json()) as any;
		expect(json.data.content).toContain("has been unlinked");
	});

	it("rejects a validly signed interaction with a stale timestamp", async () => {
		const stale = String(Math.floor(Date.now() / 1000) - 10 * 60);
		const req = await signedDiscordInteraction(privateKey, { type: 1 }, stale);
		const res = await handleDiscordInteraction(req, env);
		expect(res.status).toBe(401);
	});

	it("responds to PING with type 1", async () => {
		const req = await signedDiscordInteraction(privateKey, { type: 1 });
		const res = await handleDiscordInteraction(req, env);
		expect(await res.json()).toEqual({ type: 1 });
	});

	it("rejects unknown interaction type", async () => {
		const req = await signedDiscordInteraction(privateKey, { type: 99 });
		const res = await handleDiscordInteraction(req, env);
		expect(res.status).toBe(400);
	});

	it("replies 'Unknown command.' for unrecognized command names", async () => {
		const req = await signedDiscordInteraction(privateKey, {
			type: 2,
			data: { name: "foobar" },
			member: { user: { id: "u1" } },
		});
		const res = await handleDiscordInteraction(req, env);
		expect((await res.json()).data.content).toBe("Unknown command.");
	});

	describe("/link <code>", () => {
		it("rejects missing code", async () => {
			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "link", options: [] },
				member: { user: { id: "u1" } },
			});
			const json = (await (await handleDiscordInteraction(req, env)).json()) as any;
			expect(json.data.content).toContain("Please provide your linking code");
		});

		it("rejects invalid code", async () => {
			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "link", options: [{ value: "BADCODE1" }] },
				member: { user: { id: "u1" } },
			});
			const json = (await (await handleDiscordInteraction(req, env)).json()) as any;
			expect(json.data.content).toContain("Invalid or expired code");
		});

		it("happy path (paid): redeems, writes mapping, assigns both roles, deletes code", async () => {
			await env.GHOST_DISCORD_MAPPING.put("code:ABC12345", pending("a@b.co", true));
			fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "link", options: [{ value: "ABC12345" }] },
				member: { user: { id: "u1" } },
			});
			const json = (await (await handleDiscordInteraction(req, env)).json()) as any;

			expect(json.data.content).toContain("has been linked");
			expect(await env.GHOST_DISCORD_MAPPING.get("a@b.co")).toBe("u1");
			expect(await env.GHOST_DISCORD_MAPPING.get("discord:u1")).toBe("a@b.co");
			expect(await env.GHOST_DISCORD_MAPPING.get("code:ABC12345")).toBeNull();

			const discordCalls = fetchSpy.mock.calls.filter((c) =>
				String(c[0]).includes("discord.com"),
			);
			expect(discordCalls).toHaveLength(2);
		});

		it("happy path (free): assigns only Member role", async () => {
			await env.GHOST_DISCORD_MAPPING.put("code:CODE0001", pending("a@b.co"));
			fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "link", options: [{ value: "CODE0001" }] },
				member: { user: { id: "u1" } },
			});
			await handleDiscordInteraction(req, env);

			const discordCalls = fetchSpy.mock.calls.filter((c) =>
				String(c[0]).includes("discord.com"),
			);
			expect(discordCalls).toHaveLength(1);
			expect(String(discordCalls[0][0])).toContain(
				`/roles/${env.DISCORD_ROLE_MEMBER}`,
			);
		});

		it("trims and uppercases the code", async () => {
			await env.GHOST_DISCORD_MAPPING.put("code:ABC12345", pending("a@b.co"));
			fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "link", options: [{ value: "  abc12345  " }] },
				member: { user: { id: "u1" } },
			});
			const json = (await (await handleDiscordInteraction(req, env)).json()) as any;
			expect(json.data.content).toContain("has been linked");
		});

		it("rejects when email is linked to a different Discord user", async () => {
			await env.GHOST_DISCORD_MAPPING.put("code:CODE0001", pending("a@b.co"));
			await env.GHOST_DISCORD_MAPPING.put("a@b.co", "other-user");

			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "link", options: [{ value: "CODE0001" }] },
				member: { user: { id: "u1" } },
			});
			const json = (await (await handleDiscordInteraction(req, env)).json()) as any;
			expect(json.data.content).toContain(
				"already linked to another Discord account",
			);
			// Code should NOT be consumed on conflict
			expect(await env.GHOST_DISCORD_MAPPING.get("code:CODE0001")).toBe(
				pending("a@b.co"),
			);
		});

		it("rejects when Discord user is already linked to a different email", async () => {
			await env.GHOST_DISCORD_MAPPING.put("code:CODE0001", pending("new@b.co"));
			await env.GHOST_DISCORD_MAPPING.put("discord:u1", "old@b.co");

			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "link", options: [{ value: "CODE0001" }] },
				member: { user: { id: "u1" } },
			});
			const json = (await (await handleDiscordInteraction(req, env)).json()) as any;
			expect(json.data.content).toContain("already linked to **old@b.co**");
		});

		it("idempotent re-link of same (email, userId) succeeds", async () => {
			await env.GHOST_DISCORD_MAPPING.put("code:CODE0001", pending("a@b.co"));
			await env.GHOST_DISCORD_MAPPING.put("a@b.co", "u1");
			await env.GHOST_DISCORD_MAPPING.put("discord:u1", "a@b.co");
			fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "link", options: [{ value: "CODE0001" }] },
				member: { user: { id: "u1" } },
			});
			const json = (await (await handleDiscordInteraction(req, env)).json()) as any;
			expect(json.data.content).toContain("has been linked");
		});

		it("consumes the code before writing the mapping", async () => {
			await env.GHOST_DISCORD_MAPPING.put("code:CODE0001", pending("a@b.co"));
			fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
			const order: string[] = [];
			const kv = env.GHOST_DISCORD_MAPPING;
			vi.spyOn(kv, "delete").mockImplementation(async function (this: unknown, key: string) {
				order.push(`delete ${key}`);
			} as any);
			const realPut = kv.put.bind(kv);
			vi.spyOn(kv, "put").mockImplementation((async (key: string, value: string) => {
				order.push(`put ${key}`);
				return realPut(key, value);
			}) as any);

			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "link", options: [{ value: "CODE0001" }] },
				member: { user: { id: "u1" } },
			});
			await handleDiscordInteraction(req, env);
			expect(order).toEqual(["delete code:CODE0001", "put a@b.co", "put discord:u1"]);
		});

		it("rejects malformed code entries", async () => {
			await env.GHOST_DISCORD_MAPPING.put("code:CODE0001", "a@b.co");

			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "link", options: [{ value: "CODE0001" }] },
				member: { user: { id: "u1" } },
			});
			const json = (await (await handleDiscordInteraction(req, env)).json()) as any;
			expect(json.data.content).toContain("Invalid or expired code");
		});

		it("does not call the Ghost Admin API", async () => {
			await env.GHOST_DISCORD_MAPPING.put("code:CODE0001", pending("a@b.co", true));
			fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "link", options: [{ value: "CODE0001" }] },
				member: { user: { id: "u1" } },
			});
			await handleDiscordInteraction(req, env);
			const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
			expect(urls.every((u) => u.includes("discord.com"))).toBe(true);
		});

		it("warns when role assignment fails", async () => {
			await env.GHOST_DISCORD_MAPPING.put("code:CODE0001", pending("a@b.co"));
			fetchSpy.mockImplementation(async () => new Response("forbidden", { status: 403 }));

			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "link", options: [{ value: "CODE0001" }] },
				member: { user: { id: "u1" } },
			});
			const json = (await (await handleDiscordInteraction(req, env)).json()) as any;
			expect(json.data.content).toContain("roles could not be assigned");
			// Mapping still written
			expect(await env.GHOST_DISCORD_MAPPING.get("a@b.co")).toBe("u1");
		});
	});

	describe("/unlink", () => {
		it("replies 'No email is linked' when no mapping", async () => {
			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "unlink" },
				member: { user: { id: "u1" } },
			});
			const json = (await (await handleDiscordInteraction(req, env)).json()) as any;
			expect(json.data.content).toContain("No email is linked");
		});

		it("removes both roles, then both directions", async () => {
			await env.GHOST_DISCORD_MAPPING.put("a@b.co", "u1");
			await env.GHOST_DISCORD_MAPPING.put("discord:u1", "a@b.co");
			fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "unlink" },
				member: { user: { id: "u1" } },
			});
			const json = (await (await handleDiscordInteraction(req, env)).json()) as any;
			expect(json.data.content).toContain("has been unlinked");
			expect(json.data.content).toContain("roles have been removed");
			expect(await env.GHOST_DISCORD_MAPPING.get("a@b.co")).toBeNull();
			expect(await env.GHOST_DISCORD_MAPPING.get("discord:u1")).toBeNull();

			const calls = fetchSpy.mock.calls.map((c) => [String(c[0]), (c[1] as RequestInit).method]);
			expect(calls).toEqual([
				[expect.stringContaining(`/members/u1/roles/${env.DISCORD_ROLE_MEMBER}`), "DELETE"],
				[expect.stringContaining(`/members/u1/roles/${env.DISCORD_ROLE_PREMIUM}`), "DELETE"],
			]);
		});

		it("unlinks when the member already left the guild (404)", async () => {
			await env.GHOST_DISCORD_MAPPING.put("a@b.co", "u1");
			await env.GHOST_DISCORD_MAPPING.put("discord:u1", "a@b.co");
			fetchSpy.mockResolvedValue(new Response("Unknown Member", { status: 404 }));

			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "unlink" },
				member: { user: { id: "u1" } },
			});
			const json = (await (await handleDiscordInteraction(req, env)).json()) as any;
			expect(json.data.content).toContain("has been unlinked");
			expect(await env.GHOST_DISCORD_MAPPING.get("discord:u1")).toBeNull();
		});

		it("keeps the link when roles cannot be removed", async () => {
			await env.GHOST_DISCORD_MAPPING.put("a@b.co", "u1");
			await env.GHOST_DISCORD_MAPPING.put("discord:u1", "a@b.co");
			fetchSpy.mockImplementation(async () => new Response("forbidden", { status: 403 }));

			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "unlink" },
				member: { user: { id: "u1" } },
			});
			const json = (await (await handleDiscordInteraction(req, env)).json()) as any;
			expect(json.data.content).toContain("still linked");
			expect(await env.GHOST_DISCORD_MAPPING.get("a@b.co")).toBe("u1");
			expect(await env.GHOST_DISCORD_MAPPING.get("discord:u1")).toBe("a@b.co");
		});

		it("link → unlink → link with another account leaves no roles on the first", async () => {
			fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
			const run = async (userId: string, data: object) =>
				handleDiscordInteraction(
					await signedDiscordInteraction(privateKey, { type: 2, data, member: { user: { id: userId } } }),
					env,
				);

			await env.GHOST_DISCORD_MAPPING.put("code:CODE0001", pending("a@b.co", true));
			await run("u1", { name: "link", options: [{ value: "CODE0001" }] });
			await run("u1", { name: "unlink" });
			await env.GHOST_DISCORD_MAPPING.put("code:CODE0002", pending("a@b.co", true));
			await run("u2", { name: "link", options: [{ value: "CODE0002" }] });

			const u1Calls = fetchSpy.mock.calls
				.filter((c) => String(c[0]).includes("/members/u1/"))
				.map((c) => (c[1] as RequestInit).method);
			// Two PUTs on link, then two DELETEs on unlink: u1 ends with no roles.
			expect(u1Calls).toEqual(["PUT", "PUT", "DELETE", "DELETE"]);
		});
	});
});
