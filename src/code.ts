import type { Env, PendingLink } from "./types";
import { json } from "./utils";
import { verifyGhostMemberJWT } from "./jwt";

/** Crockford-style alphabet (32 chars, no 0/O/1/I/L/U confusion). */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;
const CODE_TTL_SECONDS = 600;
/** An existing code is handed out again only if the member still has at least this long to use it. */
const MIN_REUSE_SECONDS = 120;
/** Scope of the token served by Ghost's `/members/api/entitlements` (vs `members:identity` for `/session`). */
const ENTITLEMENT_SCOPE = "members:entitlements:read";

/** Generates an 8-char base32 code (~40 bits of entropy) for in-Discord redemption. */
function generateCode(): string {
	const bytes = new Uint8Array(CODE_LENGTH);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => ALPHABET[b & 0x1f]).join("");
}

/**
 * CORS headers locked to the configured Ghost site. The /code endpoint is the only
 * route called from a browser; all others are server-to-server (Ghost, Discord, ops).
 */
function corsHeaders(env: Env): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": env.GHOST_URL,
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
		"Access-Control-Max-Age": "86400",
		Vary: "Origin",
	};
}

/** Parses a `code:<CODE>` KV value; returns null when missing or malformed. */
export function parsePendingLink(raw: string | null): PendingLink | null {
	if (!raw) return null;
	try {
		const v = JSON.parse(raw);
		return typeof v?.email === "string" && typeof v?.paid === "boolean" ? v : null;
	} catch {
		return null;
	}
}

/**
 * Returns the member's still-valid code (tracked under `pending:<email>`) instead of minting
 * a new one, so repeated clicks or scripted calls cost KV reads, not KV writes.
 * A code is not reused if the member's `paid` status changed since it was minted.
 */
async function findReusableCode(
	env: Env,
	email: string,
	paid: boolean,
): Promise<{ code: string; expires_in: number } | null> {
	const { value: code, metadata } = await env.GHOST_DISCORD_MAPPING.getWithMetadata<{ expiresAt: number }>(
		`pending:${email}`,
	);
	if (!code || !metadata) return null;

	const remaining = Math.floor((metadata.expiresAt - Date.now()) / 1000);
	if (remaining < MIN_REUSE_SECONDS) return null;

	const entry = parsePendingLink(await env.GHOST_DISCORD_MAPPING.get(`code:${code}`));
	if (!entry || entry.email !== email || entry.paid !== paid) return null;

	return { code, expires_in: remaining };
}

/** Responds to the CORS preflight from the Ghost site's browser JS. */
export function handleCodeOptions(env: Env): Response {
	return new Response(null, { status: 204, headers: corsHeaders(env) });
}

/**
 * POST /code — Exchanges a Ghost member entitlement JWT for a short-lived redemption code.
 * The JWT proves the caller controls the Ghost member email and carries the `paid` flag,
 * so no Admin API lookup is needed. The code is stored in KV (key `code:<code>`,
 * value `{ email, paid }` JSON) with a 10-minute TTL and is single-use.
 * Each member has at most one live code; the optional CODE_RATE_LIMITER binding caps calls per email.
 */
export async function handleCodePost(request: Request, env: Env): Promise<Response> {
	const headers = corsHeaders(env);

	let body: { token?: string };
	try {
		body = await request.json();
	} catch {
		return json({ error: "Invalid JSON" }, 400, headers);
	}

	if (!body.token) {
		return json({ error: "Missing token" }, 400, headers);
	}

	const claims = await verifyGhostMemberJWT(body.token, env);
	if (!claims) {
		return json({ error: "Invalid token" }, 401, headers);
	}
	if (claims.scope !== ENTITLEMENT_SCOPE || typeof claims.paid !== "boolean") {
		return json({ error: "Expected an entitlement token from /members/api/entitlements" }, 401, headers);
	}

	const email = claims.sub?.toLowerCase();
	if (!email) {
		return json({ error: "Token missing email claim" }, 400, headers);
	}

	if (env.CODE_RATE_LIMITER) {
		const { success } = await env.CODE_RATE_LIMITER.limit({ key: email });
		if (!success) {
			return json({ error: "Too many requests, please wait a minute" }, 429, { ...headers, "Retry-After": "60" });
		}
	}

	const reusable = await findReusableCode(env, email, claims.paid);
	if (reusable) {
		return json(reusable, 200, headers);
	}

	const code = generateCode();
	const pending: PendingLink = { email, paid: claims.paid };
	await env.GHOST_DISCORD_MAPPING.put(`code:${code}`, JSON.stringify(pending), {
		expirationTtl: CODE_TTL_SECONDS,
	});
	await env.GHOST_DISCORD_MAPPING.put(`pending:${email}`, code, {
		expirationTtl: CODE_TTL_SECONDS,
		metadata: { expiresAt: Date.now() + CODE_TTL_SECONDS * 1000 },
	});

	console.log(`code issued for ${email} (paid=${claims.paid})`);
	return json({ code, expires_in: CODE_TTL_SECONDS }, 200, headers);
}
