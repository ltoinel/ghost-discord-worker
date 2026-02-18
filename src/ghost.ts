import type { Env, GhostLookupResult, GhostMemberData } from "./types";
import { hexToBytes } from "./utils";

/**
 * Generates a short-lived HS256 JWT (5 min) for Ghost Admin API authentication.
 * The API key format is "id:hex_secret" — the secret is hex-decoded before signing.
 */
async function generateGhostJWT(env: Env): Promise<string> {
	const [id, secret] = env.GHOST_ADMIN_API_KEY.split(":");
	const now = Math.floor(Date.now() / 1000);

	const header = { alg: "HS256", typ: "JWT", kid: id };
	const payload = { iss: id, aud: "/admin/", iat: now, exp: now + 300 };

	const toBase64Url = (obj: unknown) =>
		btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

	const signingInput = `${toBase64Url(header)}.${toBase64Url(payload)}`;

	const key = await crypto.subtle.importKey(
		"raw",
		hexToBytes(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
	const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");

	return `${signingInput}.${sigB64}`;
}

/**
 * Looks up a Ghost member by email via the Admin API.
 * @returns "found" with member data, "not_found", or "error" with a human-readable message.
 */
export async function getGhostMember(email: string, env: Env): Promise<GhostLookupResult> {
	const jwt = await generateGhostJWT(env);
	const url = `${env.GHOST_URL}/ghost/api/admin/members/?filter=email:'${encodeURIComponent(email)}'&limit=1`;
	let res: Response;
	try {
		res = await fetch(url, {
			headers: {
				Authorization: `Ghost ${jwt}`,
				"User-Agent": "GhostDiscordWorker/1.0",
				Accept: "application/json",
			},
		});
	} catch (err) {
		console.error(`Ghost API fetch error: ${err}`);
		return { status: "error", message: "Unable to reach Ghost API." };
	}
	if (!res.ok) {
		const body = await res.text();
		console.error(`Ghost API error: ${res.status} ${body}`);
		return { status: "error", message: `Ghost API returned ${res.status}.` };
	}
	const data = (await res.json()) as { members: GhostMemberData[] };
	return data.members.length > 0
		? { status: "found", member: data.members[0] }
		: { status: "not_found" };
}
