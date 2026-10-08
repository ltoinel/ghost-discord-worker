import type { Env, PendingLink } from "./types";
import { json } from "./utils";
import { verifyGhostMemberJWT } from "./jwt";

/** Crockford-style alphabet (32 chars, no 0/O/1/I/L/U confusion). */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;
const CODE_TTL_SECONDS = 600;
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

/** Responds to the CORS preflight from the Ghost site's browser JS. */
export function handleCodeOptions(env: Env): Response {
	return new Response(null, { status: 204, headers: corsHeaders(env) });
}

/**
 * POST /code — Exchanges a Ghost member entitlement JWT for a short-lived redemption code.
 * The JWT proves the caller controls the Ghost member email and carries the `paid` flag,
 * so no Admin API lookup is needed. The code is stored in KV (key `code:<code>`,
 * value `{ email, paid }` JSON) with a 10-minute TTL and is single-use.
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

	const code = generateCode();
	const pending: PendingLink = { email, paid: claims.paid };
	await env.GHOST_DISCORD_MAPPING.put(`code:${code}`, JSON.stringify(pending), {
		expirationTtl: CODE_TTL_SECONDS,
	});

	console.log(`code issued for ${email} (paid=${claims.paid})`);
	return json({ code, expires_in: CODE_TTL_SECONDS }, 200, headers);
}
