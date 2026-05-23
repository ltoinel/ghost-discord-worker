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

function mockGhostFound(
	fetchSpy: ReturnType<typeof vi.spyOn>,
	status: "free" | "paid" | "comped",
) {
	fetchSpy.mockImplementation(async (input: any) => {
		const url = String(input);
		if (url.includes("/ghost/api/admin/members/")) {
			return new Response(
				JSON.stringify({ members: [{ email: "a@b.co", status }] }),
				{ status: 200 },
			);
		}
		return new Response(null, { status: 204 });
	});
}

function mockGhostNotFound(fetchSpy: ReturnType<typeof vi.spyOn>) {
	fetchSpy.mockImplementation(async (input: any) => {
		if (String(input).includes("/ghost/api/admin/members/")) {
			return new Response(JSON.stringify({ members: [] }), { status: 200 });
		}
		return new Response(null, { status: 204 });
	});
}

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

		const req = await signedDiscordInteraction(privateKey, {
			type: 2,
			data: { name: "unlink" },
			user: { id: "dm-user" },
		});
		const res = await handleDiscordInteraction(req, env);
		const json = (await res.json()) as any;
		expect(json.data.content).toContain("has been unlinked");
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
			await env.GHOST_DISCORD_MAPPING.put("code:ABC12345", "a@b.co");
			mockGhostFound(fetchSpy, "paid");

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
			await env.GHOST_DISCORD_MAPPING.put("code:CODE0001", "a@b.co");
			mockGhostFound(fetchSpy, "free");

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
			await env.GHOST_DISCORD_MAPPING.put("code:ABC12345", "a@b.co");
			mockGhostFound(fetchSpy, "free");

			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "link", options: [{ value: "  abc12345  " }] },
				member: { user: { id: "u1" } },
			});
			const json = (await (await handleDiscordInteraction(req, env)).json()) as any;
			expect(json.data.content).toContain("has been linked");
		});

		it("rejects when email is linked to a different Discord user", async () => {
			await env.GHOST_DISCORD_MAPPING.put("code:CODE0001", "a@b.co");
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
				"a@b.co",
			);
		});

		it("rejects when Discord user is already linked to a different email", async () => {
			await env.GHOST_DISCORD_MAPPING.put("code:CODE0001", "new@b.co");
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
			await env.GHOST_DISCORD_MAPPING.put("code:CODE0001", "a@b.co");
			await env.GHOST_DISCORD_MAPPING.put("a@b.co", "u1");
			await env.GHOST_DISCORD_MAPPING.put("discord:u1", "a@b.co");
			mockGhostFound(fetchSpy, "free");

			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "link", options: [{ value: "CODE0001" }] },
				member: { user: { id: "u1" } },
			});
			const json = (await (await handleDiscordInteraction(req, env)).json()) as any;
			expect(json.data.content).toContain("has been linked");
		});

		it("rejects when Ghost no longer recognizes the email", async () => {
			await env.GHOST_DISCORD_MAPPING.put("code:CODE0001", "a@b.co");
			mockGhostNotFound(fetchSpy);

			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "link", options: [{ value: "CODE0001" }] },
				member: { user: { id: "u1" } },
			});
			const json = (await (await handleDiscordInteraction(req, env)).json()) as any;
			expect(json.data.content).toContain("no longer associated");
		});

		it("warns when role assignment fails", async () => {
			await env.GHOST_DISCORD_MAPPING.put("code:CODE0001", "a@b.co");
			fetchSpy.mockImplementation(async (input: any) => {
				const url = String(input);
				if (url.includes("/ghost/api/admin/members/")) {
					return new Response(
						JSON.stringify({ members: [{ email: "a@b.co", status: "free" }] }),
						{ status: 200 },
					);
				}
				return new Response("forbidden", { status: 403 });
			});

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

		it("removes both directions", async () => {
			await env.GHOST_DISCORD_MAPPING.put("a@b.co", "u1");
			await env.GHOST_DISCORD_MAPPING.put("discord:u1", "a@b.co");

			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "unlink" },
				member: { user: { id: "u1" } },
			});
			const json = (await (await handleDiscordInteraction(req, env)).json()) as any;
			expect(json.data.content).toContain("has been unlinked");
			expect(await env.GHOST_DISCORD_MAPPING.get("a@b.co")).toBeNull();
			expect(await env.GHOST_DISCORD_MAPPING.get("discord:u1")).toBeNull();
		});

		it("does NOT call Discord API", async () => {
			await env.GHOST_DISCORD_MAPPING.put("a@b.co", "u1");
			await env.GHOST_DISCORD_MAPPING.put("discord:u1", "a@b.co");

			const req = await signedDiscordInteraction(privateKey, {
				type: 2,
				data: { name: "unlink" },
				member: { user: { id: "u1" } },
			});
			await handleDiscordInteraction(req, env);
			expect(fetchSpy).not.toHaveBeenCalled();
		});
	});
});
