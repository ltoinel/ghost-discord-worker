import type { Env } from "./types";
import { json, timingSafeEqual, isValidEmail } from "./utils";
import { removeRole } from "./discord";

/** Discord user IDs are snowflakes: unsigned 64-bit integers written in decimal. */
const SNOWFLAKE_REGEX = /^\d{17,20}$/;

/** Validates the Bearer token in the Authorization header against the admin secret. */
function checkAdmin(request: Request, env: Env): boolean {
	const auth = request.headers.get("Authorization");
	if (!auth || !auth.startsWith("Bearer ")) return false;
	return timingSafeEqual(auth.slice(7), env.ADMIN_SECRET);
}

/**
 * POST /link — Creates a bidirectional email ↔ discord_user_id mapping in KV.
 * Stores both directions: email→userId and discord:userId→email, and drops the stale
 * reverse entries when either side was previously linked to something else.
 */
export async function handleLinkPost(request: Request, env: Env): Promise<Response> {
	if (!checkAdmin(request, env)) {
		return json({ error: "Unauthorized" }, 401);
	}

	let body: { email?: string; discord_user_id?: string };
	try {
		body = await request.json();
	} catch {
		return json({ error: "Invalid JSON" }, 400);
	}

	if (!body.email || !body.discord_user_id) {
		return json({ error: "Missing email or discord_user_id" }, 400);
	}

	if (!isValidEmail(body.email)) {
		return json({ error: "Invalid email format" }, 400);
	}

	if (!SNOWFLAKE_REGEX.test(body.discord_user_id)) {
		return json({ error: "Invalid discord_user_id format" }, 400);
	}

	const email = body.email.toLowerCase();
	const previousUserId = await env.GHOST_DISCORD_MAPPING.get(email);
	if (previousUserId && previousUserId !== body.discord_user_id) {
		await env.GHOST_DISCORD_MAPPING.delete(`discord:${previousUserId}`);
	}
	const previousEmail = await env.GHOST_DISCORD_MAPPING.get(`discord:${body.discord_user_id}`);
	if (previousEmail && previousEmail !== email) {
		await env.GHOST_DISCORD_MAPPING.delete(previousEmail);
	}

	await env.GHOST_DISCORD_MAPPING.put(email, body.discord_user_id);
	await env.GHOST_DISCORD_MAPPING.put(`discord:${body.discord_user_id}`, email);

	return json({ ok: true, email, discord_user_id: body.discord_user_id });
}

/**
 * DELETE /link — Removes the Member and Premium roles, then the bidirectional
 * email ↔ discord_user_id mapping (same reasoning as /unlink: unlinked roles are never revoked).
 */
export async function handleLinkDelete(request: Request, env: Env): Promise<Response> {
	if (!checkAdmin(request, env)) {
		return json({ error: "Unauthorized" }, 401);
	}

	let body: { email?: string };
	try {
		body = await request.json();
	} catch {
		return json({ error: "Invalid JSON" }, 400);
	}

	if (!body.email) {
		return json({ error: "Missing email" }, 400);
	}

	if (!isValidEmail(body.email)) {
		return json({ error: "Invalid email format" }, 400);
	}

	const email = body.email.toLowerCase();
	const discordUserId = await env.GHOST_DISCORD_MAPPING.get(email);
	if (discordUserId) {
		const errors = [
			await removeRole(env, discordUserId, env.DISCORD_ROLE_MEMBER),
			await removeRole(env, discordUserId, env.DISCORD_ROLE_PREMIUM),
		].filter(Boolean);
		if (errors.length > 0) {
			return json({ error: "Role removal failed; mapping kept", details: errors }, 502);
		}
		await env.GHOST_DISCORD_MAPPING.delete(`discord:${discordUserId}`);
	}
	await env.GHOST_DISCORD_MAPPING.delete(email);

	return json({ ok: true, email });
}

/** GET /link/:email — Retrieves the discord_user_id mapped to the given email. */
export async function handleLinkGet(email: string, request: Request, env: Env): Promise<Response> {
	if (!checkAdmin(request, env)) {
		return json({ error: "Unauthorized" }, 401);
	}

	const normalizedEmail = email.toLowerCase();
	if (!isValidEmail(normalizedEmail)) {
		return json({ error: "Invalid email format" }, 400);
	}

	const discordUserId = await env.GHOST_DISCORD_MAPPING.get(normalizedEmail);

	if (!discordUserId) {
		return json({ error: "Not found" }, 404);
	}

	return json({ email: normalizedEmail, discord_user_id: discordUserId });
}
