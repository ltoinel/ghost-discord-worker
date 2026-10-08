import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { createEnv, signRSJWT } from "./helpers";

const CLAIMS = {
	scope: "members:entitlements:read",
	paid: false,
	sub: "a@b.co",
	iss: "https://ghost.test/members/api",
	aud: "https://ghost.test/members/api",
};

let oldKey: CryptoKeyPair;
let newKey: CryptoKeyPair;
let oldJwk: JsonWebKey;
let newJwk: JsonWebKey;

const genKey = () =>
	crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-512" },
		true,
		["sign", "verify"],
	);

beforeAll(async () => {
	oldKey = await genKey();
	newKey = await genKey();
	oldJwk = { ...(await crypto.subtle.exportKey("jwk", oldKey.publicKey)), kid: "old" } as JsonWebKey;
	newJwk = { ...(await crypto.subtle.exportKey("jwk", newKey.publicKey)), kid: "new" } as JsonWebKey;
});

describe("JWKS key rotation", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	let published: JsonWebKey[];
	let verify: typeof import("../src/jwt").verifyGhostMemberJWT;

	beforeEach(async () => {
		vi.resetModules(); // fresh per-isolate JWKS cache
		verify = (await import("../src/jwt")).verifyGhostMemberJWT;
		published = [oldJwk];
		fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response(JSON.stringify({ keys: published }), { status: 200 }));
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		vi.useRealTimers();
	});

	const sign = (pair: CryptoKeyPair, kid: string) =>
		signRSJWT(pair.privateKey, { ...CLAIMS, exp: Math.floor(Date.now() / 1000) + 300 }, kid, "RS512");

	it("refetches the JWKS when a token uses a kid published after the cache was filled", async () => {
		const env = createEnv();
		expect(await verify(await sign(oldKey, "old"), env)).not.toBeNull();

		published = [oldJwk, newJwk]; // Ghost rotates its signing key
		expect(await verify(await sign(newKey, "new"), env)).not.toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("forces at most one refetch per minute for unknown kids", async () => {
		const env = createEnv();
		await verify(await sign(oldKey, "old"), env);
		await verify(await sign(newKey, "unknown-1"), env);
		await verify(await sign(newKey, "unknown-2"), env);
		await verify(await sign(newKey, "unknown-3"), env);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});
});
