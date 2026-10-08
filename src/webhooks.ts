import type { Env, GhostWebhookPayload } from "./types";
import { json, timingSafeEqual, isPaid } from "./utils";
import { addRole, removeRole } from "./discord";

/** Validated and resolved webhook data ready for business logic processing. */
interface WebhookContext {
	email: string;
	discordUserId: string;
	member: GhostWebhookPayload["member"];
}

/**
 * Verifies the X-Ghost-Signature HMAC-SHA256 header.
 * Ghost signs the raw request body with the webhook secret and sends:
 *   X-Ghost-Signature: sha256=<hex_digest>, t=<timestamp>
 * @returns The raw body string on success, or null on failure.
 */
async function verifyGhostSignature(request: Request, env: Env): Promise<string | null> {
	const signature = request.headers.get("X-Ghost-Signature");
	if (!signature) return null;

	// Parse "sha256=<hex>, t=<timestamp>"
	const parts: Record<string, string> = {};
	for (const part of signature.split(",")) {
		const [k, v] = part.trim().split("=", 2);
		if (k && v) parts[k] = v;
	}
	const receivedHex = parts.sha256;
	const timestamp = parts.t;
	if (!receivedHex || !timestamp) return null;

	// Ghost uses Date.now() (milliseconds) for the timestamp.
	// Reject requests older than 5 minutes to prevent replay attacks.
	const ts = parseInt(timestamp, 10);
	const now = Date.now();
	if (Number.isNaN(ts) || Math.abs(now - ts) > 5 * 60 * 1000) return null;

	const body = await request.text();

	// Ghost signs `${jsonPayload}${timestamp}` — body concatenated with the ts value.
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(env.WEBHOOK_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body + timestamp));
	const computedHex = Array.from(new Uint8Array(mac))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	if (!timingSafeEqual(computedHex, receivedHex)) return null;

	return body;
}

type WebhookEvent = "added" | "updated" | "deleted";

/**
 * Deletes the member's pending linking code, if any. A code carries the `paid` flag captured
 * when it was minted; once the status changes (or the member is deleted), redeeming it would
 * grant roles the member no longer has, e.g. Premium regained right after cancelling.
 */
async function invalidatePendingCode(env: Env, email: string): Promise<void> {
	const code = await env.GHOST_DISCORD_MAPPING.get(`pending:${email}`);
	if (!code) return;
	await env.GHOST_DISCORD_MAPPING.delete(`code:${code}`);
	await env.GHOST_DISCORD_MAPPING.delete(`pending:${email}`);
	console.log(`pending code invalidated for ${email}`);
}

/**
 * Authenticates the webhook signature, parses the JSON payload, and resolves the Discord user mapping.
 * For delete events, the email is in member.previous (member.current is empty).
 * Status changes and deletions invalidate the member's pending code, linked or not.
 * @returns A WebhookContext on success, or an error Response on failure (auth, parse, or missing mapping).
 */
async function parseWebhookRequest(request: Request, env: Env, event: WebhookEvent): Promise<WebhookContext | Response> {
	const body = await verifyGhostSignature(request, env);
	if (body === null) {
		return json({ error: "Unauthorized" }, 401);
	}

	let payload: GhostWebhookPayload;
	try {
		payload = JSON.parse(body);
	} catch {
		return json({ error: "Invalid JSON" }, 400);
	}

	const { member } = payload;
	const source = event === "deleted" ? member?.previous : member?.current;
	if (!source?.email) {
		return json({ error: "Invalid payload: missing member email" }, 400);
	}

	const email = source.email.toLowerCase();

	const statusChanged =
		event === "updated" && member.previous?.status !== undefined && member.previous.status !== member.current?.status;
	if (event === "deleted" || statusChanged) {
		await invalidatePendingCode(env, email);
	}

	const discordUserId = await env.GHOST_DISCORD_MAPPING.get(email);
	if (!discordUserId) {
		console.warn(`No Discord mapping found for email: ${email}`);
		return json({ ok: true, skipped: true, reason: "no_mapping" });
	}

	return { email, discordUserId, member };
}

/**
 * Handles Ghost member.added webhook events (POST /webhook/added).
 * Assigns the Member role, plus Premium if the new member is paid or comped.
 */
export async function handleMemberAdded(request: Request, env: Env): Promise<Response> {
	const result = await parseWebhookRequest(request, env, "added");
	if (result instanceof Response) return result;

	const { email, discordUserId, member } = result;
	console.log(`member.added: ${email} (${member.current.status})`);
	await addRole(env, discordUserId, env.DISCORD_ROLE_MEMBER);
	if (isPaid(member.current.status)) {
		await addRole(env, discordUserId, env.DISCORD_ROLE_PREMIUM);
	}

	return json({ ok: true });
}

/**
 * Handles Ghost member.updated webhook events (POST /webhook/updated).
 * Syncs the Premium role on status transitions; paid↔comped and same-status updates are no-ops.
 */
export async function handleMemberUpdated(request: Request, env: Env): Promise<Response> {
	const result = await parseWebhookRequest(request, env, "updated");
	if (result instanceof Response) return result;

	const { email, discordUserId, member } = result;

	if (!member.previous?.status || member.previous.status === member.current.status) {
		return json({ ok: true });
	}

	if (!isPaid(member.previous.status) && isPaid(member.current.status)) {
		console.log(`member.updated (free->paid): ${email}`);
		await addRole(env, discordUserId, env.DISCORD_ROLE_PREMIUM);
	} else if (isPaid(member.previous.status) && !isPaid(member.current.status)) {
		console.log(`member.updated (paid->free): ${email}`);
		await removeRole(env, discordUserId, env.DISCORD_ROLE_PREMIUM);
	}

	return json({ ok: true });
}

/**
 * Handles Ghost member.deleted webhook events (POST /webhook/deleted).
 * Removes both the Member and Premium roles from the linked Discord user.
 * The KV mapping itself is preserved so re-subscriptions reuse the existing link.
 */
export async function handleMemberDeleted(request: Request, env: Env): Promise<Response> {
	const result = await parseWebhookRequest(request, env, "deleted");
	if (result instanceof Response) return result;

	const { email, discordUserId } = result;
	console.log(`member.deleted: ${email}`);
	await removeRole(env, discordUserId, env.DISCORD_ROLE_MEMBER);
	await removeRole(env, discordUserId, env.DISCORD_ROLE_PREMIUM);

	return json({ ok: true });
}
