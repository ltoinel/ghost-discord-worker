import {
	describe,
	it,
	expect,
	beforeAll,
	beforeEach,
	afterEach,
	vi,
} from "vitest";
import { handleCodePost, handleCodeOptions } from "../src/code";
import { createEnv, signRSJWT, base64UrlEncode } from "./helpers";
import type { Env } from "../src/types";

/** Claims Ghost adds to tokens served by /members/api/entitlements. */
const ENT = { scope: "members:entitlements:read", paid: false };

let keyPair: CryptoKeyPair;
let otherKeyPair: CryptoKeyPair;
let keyPair512: CryptoKeyPair;
let jwks: { keys: any[] };

beforeAll(async () => {
	keyPair = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	);
	otherKeyPair = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	);
	keyPair512 = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-512",
		},
		true,
		["sign", "verify"],
	);
	const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
	const jwk512 = await crypto.subtle.exportKey("jwk", keyPair512.publicKey);
	jwks = {
		keys: [
			{ ...jwk, kid: "test-key-1", use: "sig", alg: "RS256" },
			{ ...jwk512, kid: "test-key-512", use: "sig", alg: "RS512" },
		],
	};
});

function postCode(body: unknown): Request {
	return new Request("http://test/code", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

describe("CORS preflight", () => {
	it("returns 204 + CORS headers locked to GHOST_URL", () => {
		const env = createEnv();
		const res = handleCodeOptions(env);
		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(env.GHOST_URL);
		expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
		expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
			"Content-Type",
		);
	});
});

describe("POST /code", () => {
	let env: Env;
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		env = createEnv();
		fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input: any) => {
				if (String(input).includes("jwks.json")) {
					return new Response(JSON.stringify(jwks), { status: 200 });
				}
				return new Response("", { status: 404 });
			});
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("rejects invalid JSON", async () => {
		const res = await handleCodePost(postCode("not json"), env);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Invalid JSON" });
	});

	it("rejects missing token", async () => {
		const res = await handleCodePost(postCode({}), env);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Missing token" });
	});

	it("rejects malformed JWT (not 3 parts)", async () => {
		const res = await handleCodePost(postCode({ token: "not.a.jwt.really" }), env);
		expect(res.status).toBe(401);
	});

	it("rejects JWT with wrong algorithm", async () => {
		const header = base64UrlEncode(
			JSON.stringify({ alg: "HS256", typ: "JWT", kid: "test-key-1" }),
		);
		const payload = base64UrlEncode(
			JSON.stringify({
				...ENT,
				sub: "a@b.co",
				iss: env.GHOST_URL,
				exp: Math.floor(Date.now() / 1000) + 3600,
			}),
		);
		const res = await handleCodePost(
			postCode({ token: `${header}.${payload}.aGVsbG8` }),
			env,
		);
		expect(res.status).toBe(401);
	});

	it("rejects expired JWT", async () => {
		const token = await signRSJWT(keyPair.privateKey, {
			...ENT,
			sub: "a@b.co",
			iss: env.GHOST_URL,
			exp: Math.floor(Date.now() / 1000) - 60,
		});
		expect((await handleCodePost(postCode({ token }), env)).status).toBe(401);
	});

	it("rejects JWT signed by unknown key (signature mismatch)", async () => {
		const token = await signRSJWT(otherKeyPair.privateKey, {
			...ENT,
			sub: "a@b.co",
			iss: env.GHOST_URL,
			exp: Math.floor(Date.now() / 1000) + 3600,
		});
		expect((await handleCodePost(postCode({ token }), env)).status).toBe(401);
	});

	it("rejects JWT with wrong issuer", async () => {
		const token = await signRSJWT(keyPair.privateKey, {
			...ENT,
			sub: "a@b.co",
			iss: "https://evil.example",
			exp: Math.floor(Date.now() / 1000) + 3600,
		});
		expect((await handleCodePost(postCode({ token }), env)).status).toBe(401);
	});

	it("rejects iss that prefix-matches GHOST_URL but is a different host", async () => {
		// GHOST_URL = https://ghost.test → "https://ghost.test.attacker.com" used to pass with startsWith.
		const token = await signRSJWT(keyPair.privateKey, {
			...ENT,
			sub: "a@b.co",
			iss: `${env.GHOST_URL}.attacker.com`,
			exp: Math.floor(Date.now() / 1000) + 3600,
		});
		expect((await handleCodePost(postCode({ token }), env)).status).toBe(401);
	});

	it("accepts iss with trailing slash matching GHOST_URL origin", async () => {
		const token = await signRSJWT(keyPair.privateKey, {
			...ENT,
			sub: "a@b.co",
			iss: `${env.GHOST_URL}/`,
			exp: Math.floor(Date.now() / 1000) + 3600,
		});
		expect((await handleCodePost(postCode({ token }), env)).status).toBe(200);
	});

	it("rejects JWT without a kid header", async () => {
		// Sign with empty kid — verifyGhostMemberJWT must reject before key lookup.
		const token = await signRSJWT(
			keyPair.privateKey,
			{
				...ENT,
				sub: "a@b.co",
				iss: env.GHOST_URL,
				exp: Math.floor(Date.now() / 1000) + 3600,
			},
			"", // empty kid
		);
		expect((await handleCodePost(postCode({ token }), env)).status).toBe(401);
	});

	it("accepts RS512-signed JWTs (Ghost's default algorithm)", async () => {
		const token = await signRSJWT(
			keyPair512.privateKey,
			{
				...ENT,
				sub: "ghost-user@example.com",
				iss: `${env.GHOST_URL}/members/api`,
				exp: Math.floor(Date.now() / 1000) + 600,
			},
			"test-key-512",
			"RS512",
		);
		const res = await handleCodePost(postCode({ token }), env);
		expect(res.status).toBe(200);
		const body: any = await res.json();
		expect(body.code).toMatch(/^[0-9A-Z]{8}$/);
		expect(await env.GHOST_DISCORD_MAPPING.get(`code:${body.code}`)).toBe(
			JSON.stringify({ email: "ghost-user@example.com", paid: false }),
		);
	});

	it("mints code for a valid entitlement JWT", async () => {
		const token = await signRSJWT(keyPair.privateKey, {
			...ENT,
			sub: "a@b.co",
			iss: env.GHOST_URL,
			exp: Math.floor(Date.now() / 1000) + 3600,
		});
		const res = await handleCodePost(postCode({ token }), env);
		expect(res.status).toBe(200);
		const headers = res.headers;
		expect(headers.get("Access-Control-Allow-Origin")).toBe(env.GHOST_URL);

		const body: any = await res.json();
		expect(body.code).toMatch(/^[0-9A-Z]{8}$/);
		expect(body.expires_in).toBe(600);
		expect(await env.GHOST_DISCORD_MAPPING.get(`code:${body.code}`)).toBe(
			JSON.stringify({ email: "a@b.co", paid: false }),
		);
	});

	it("lowercases the email from sub", async () => {
		const token = await signRSJWT(keyPair.privateKey, {
			...ENT,
			sub: "USER@B.CO",
			iss: env.GHOST_URL,
			exp: Math.floor(Date.now() / 1000) + 3600,
		});
		const res = await handleCodePost(postCode({ token }), env);
		const body: any = await res.json();
		expect(await env.GHOST_DISCORD_MAPPING.get(`code:${body.code}`)).toBe(
			JSON.stringify({ email: "user@b.co", paid: false }),
		);
	});

	it("stores paid=true from the entitlement token", async () => {
		const token = await signRSJWT(keyPair.privateKey, {
			...ENT,
			paid: true,
			sub: "a@b.co",
			iss: env.GHOST_URL,
			exp: Math.floor(Date.now() / 1000) + 3600,
		});
		const body: any = await (await handleCodePost(postCode({ token }), env)).json();
		expect(await env.GHOST_DISCORD_MAPPING.get(`code:${body.code}`)).toBe(
			JSON.stringify({ email: "a@b.co", paid: true }),
		);
	});

	it("rejects identity tokens (members:identity scope from /members/api/session)", async () => {
		const token = await signRSJWT(keyPair.privateKey, {
			scope: "members:identity",
			sub: "a@b.co",
			iss: env.GHOST_URL,
			exp: Math.floor(Date.now() / 1000) + 3600,
		});
		expect((await handleCodePost(postCode({ token }), env)).status).toBe(401);
	});

	it("rejects entitlement tokens without a boolean paid claim", async () => {
		const token = await signRSJWT(keyPair.privateKey, {
			scope: "members:entitlements:read",
			sub: "a@b.co",
			iss: env.GHOST_URL,
			exp: Math.floor(Date.now() / 1000) + 3600,
		});
		expect((await handleCodePost(postCode({ token }), env)).status).toBe(401);
	});

	it("generated codes differ across calls", async () => {
		const token = await signRSJWT(keyPair.privateKey, {
			...ENT,
			sub: "a@b.co",
			iss: env.GHOST_URL,
			exp: Math.floor(Date.now() / 1000) + 3600,
		});
		const codes = new Set<string>();
		for (let i = 0; i < 5; i++) {
			const res = await handleCodePost(postCode({ token }), env);
			const body: any = await res.json();
			codes.add(body.code);
		}
		expect(codes.size).toBe(5);
	});
});
