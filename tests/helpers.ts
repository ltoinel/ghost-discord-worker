import type { Env } from "../src/types";

interface Entry {
	value: string;
	expiresAt?: number;
}

/** In-memory KV stub honoring `expirationTtl`. Sufficient for the methods this worker uses. */
export function createMockKV(): KVNamespace {
	const store = new Map<string, Entry>();
	const ns = {
		async get(key: string): Promise<string | null> {
			const entry = store.get(key);
			if (!entry) return null;
			if (entry.expiresAt && entry.expiresAt < Date.now()) {
				store.delete(key);
				return null;
			}
			return entry.value;
		},
		async put(
			key: string,
			value: string,
			options?: { expirationTtl?: number },
		): Promise<void> {
			const expiresAt = options?.expirationTtl
				? Date.now() + options.expirationTtl * 1000
				: undefined;
			store.set(key, { value, expiresAt });
		},
		async delete(key: string): Promise<void> {
			store.delete(key);
		},
		_dump: () => new Map(store),
	};
	return ns as unknown as KVNamespace;
}

export function createEnv(overrides: Partial<Env> = {}): Env {
	return {
		GHOST_DISCORD_MAPPING: createMockKV(),
		WEBHOOK_SECRET: "test-webhook-secret",
		ADMIN_SECRET: "test-admin-secret",
		DISCORD_BOT_TOKEN: "test-bot-token",
		DISCORD_GUILD_ID: "111",
		DISCORD_ROLE_MEMBER: "222",
		DISCORD_ROLE_PREMIUM: "333",
		DISCORD_PUBLIC_KEY: "00".repeat(32),
		GHOST_URL: "https://ghost.test",
		GHOST_ADMIN_API_KEY: "someid:abcd1234567890abcdef",
		...overrides,
	};
}

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
	const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return Array.from(arr)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export function base64UrlEncode(input: string | Uint8Array): string {
	const bin =
		typeof input === "string" ? input : String.fromCharCode(...input);
	return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Builds a signed Ghost webhook request (HMAC-SHA256 over `body + timestamp`). */
export async function signedGhostWebhook(
	url: string,
	body: string,
	secret: string,
	timestamp = Date.now(),
): Promise<Request> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(body + timestamp),
	);
	const sig = `sha256=${bytesToHex(mac)}, t=${timestamp}`;
	return new Request(url, {
		method: "POST",
		headers: {
			"X-Ghost-Signature": sig,
			"Content-Type": "application/json",
		},
		body,
	});
}

/** Builds a signed Discord interaction request given an Ed25519 private key. */
export async function signedDiscordInteraction(
	privateKey: CryptoKey,
	bodyObj: unknown,
	timestamp = String(Math.floor(Date.now() / 1000)),
): Promise<Request> {
	const body = JSON.stringify(bodyObj);
	const sig = await crypto.subtle.sign(
		"Ed25519",
		privateKey,
		new TextEncoder().encode(timestamp + body),
	);
	return new Request("http://test/discord", {
		method: "POST",
		headers: {
			"X-Signature-Ed25519": bytesToHex(sig),
			"X-Signature-Timestamp": timestamp,
		},
		body,
	});
}

/** Signs a JWT with the given private key. `alg` selects RS256/RS384/RS512. */
export async function signRSJWT(
	privateKey: CryptoKey,
	claims: object,
	kid = "test-key-1",
	alg: "RS256" | "RS384" | "RS512" = "RS256",
): Promise<string> {
	const header = { alg, typ: "JWT", kid };
	const headerB64 = base64UrlEncode(JSON.stringify(header));
	const payloadB64 = base64UrlEncode(JSON.stringify(claims));
	const signingInput = `${headerB64}.${payloadB64}`;
	const sig = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		privateKey,
		new TextEncoder().encode(signingInput),
	);
	return `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`;
}

/** Back-compat alias — kept so existing tests using `signRS256JWT` continue to work. */
export const signRS256JWT = signRSJWT;
