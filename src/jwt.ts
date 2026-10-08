import type { Env } from "./types";

interface JWK {
	kty: string;
	e: string;
	n: string;
	kid?: string;
	alg?: string;
	use?: string;
}

interface JWKS {
	keys: JWK[];
}

export interface MemberClaims {
	/** The member's email (Ghost puts it in `sub`; there is no separate `email` claim). */
	sub: string;
	iss?: string;
	aud?: string | string[];
	exp: number;
	iat?: number;
	/** `members:identity` or `members:entitlements:read` — both are signed with the same key. */
	scope?: string;
	/** Entitlement tokens only: true when the member's status is not `free` (paid or comped). */
	paid?: boolean;
}

/**
 * Per-isolate JWKS cache. Ghost rotates keys infrequently; 1-hour TTL is a safe default.
 * Cleared on isolate eviction — no need for invalidation logic.
 */
let jwksCache: { jwks: JWKS; expiresAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

/**
 * An unknown `kid` forces a refetch (Ghost rotates its signing keys), at most once per
 * minute so forged tokens with random kids cannot turn the Worker into a JWKS hammer.
 */
let lastForcedRefresh = 0;
const FORCED_REFRESH_INTERVAL_MS = 60 * 1000;

async function fetchJWKS(env: Env, force = false): Promise<JWKS> {
	const now = Date.now();
	if (!force && jwksCache && jwksCache.expiresAt > now) return jwksCache.jwks;

	const res = await fetch(`${env.GHOST_URL}/members/.well-known/jwks.json`);
	if (!res.ok) {
		throw new Error(`JWKS fetch failed: ${res.status}`);
	}
	const jwks = (await res.json()) as JWKS;
	jwksCache = { jwks, expiresAt: now + JWKS_TTL_MS };
	return jwks;
}

function base64UrlToBytes(s: string): Uint8Array {
	const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
	const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function base64UrlToString(s: string): string {
	return new TextDecoder().decode(base64UrlToBytes(s));
}

/** Supported RSA signing algorithms. Ghost emits RS512 by default; RS256/RS384 are accepted for forward-compat. */
const ALG_HASH: Record<string, string> = {
	RS256: "SHA-256",
	RS384: "SHA-384",
	RS512: "SHA-512",
};

/**
 * Verifies a Ghost-issued member JWT (RS256/RS384/RS512, signed by the site's private key).
 * Validates signature against JWKS, then checks `exp` and the `iss` / `aud` origins.
 * @returns The decoded claims on success, or null on any verification failure.
 */
export async function verifyGhostMemberJWT(token: string, env: Env): Promise<MemberClaims | null> {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const [headerB64, payloadB64, sigB64] = parts;

	let header: { alg: string; kid?: string };
	let payload: MemberClaims;
	try {
		header = JSON.parse(base64UrlToString(headerB64));
		payload = JSON.parse(base64UrlToString(payloadB64));
	} catch {
		return null;
	}

	const hash = ALG_HASH[header.alg];
	if (!hash) return null;
	if (!header.kid) return null;

	let jwk: JWK | undefined;
	try {
		jwk = (await fetchJWKS(env)).keys.find((k) => k.kid === header.kid);
		if (!jwk && Date.now() - lastForcedRefresh > FORCED_REFRESH_INTERVAL_MS) {
			lastForcedRefresh = Date.now();
			jwk = (await fetchJWKS(env, true)).keys.find((k) => k.kid === header.kid);
		}
	} catch (err) {
		console.error(`JWKS fetch error: ${err}`);
		return null;
	}
	if (!jwk) return null;

	let key: CryptoKey;
	try {
		key = await crypto.subtle.importKey(
			"jwk",
			jwk as JsonWebKey,
			{ name: "RSASSA-PKCS1-v1_5", hash },
			false,
			["verify"],
		);
	} catch {
		return null;
	}

	const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	let sig: Uint8Array;
	try {
		sig = base64UrlToBytes(sigB64);
	} catch {
		return null;
	}
	const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
	if (!ok) return null;

	const now = Math.floor(Date.now() / 1000);
	if (!payload.exp || now > payload.exp) return null;
	// Ghost always sets both to `<site>/members/api`; require them rather than trust their absence.
	if (!payload.iss || !sameOrigin(payload.iss, env.GHOST_URL)) return null;
	const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
	if (!audiences.some((a) => typeof a === "string" && sameOrigin(a, env.GHOST_URL))) return null;

	return payload;
}

/** Compares two URL strings by origin (scheme + host + port), tolerating trailing slashes and paths. */
function sameOrigin(a: string, b: string): boolean {
	try {
		return new URL(a).origin === new URL(b).origin;
	} catch {
		return false;
	}
}
