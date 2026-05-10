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
	const receivedHex = parts["sha256"];
	const timestamp = parts["t"];
	if (!receivedHex || !timestamp) return null;

	// Ghost uses Date.now() (milliseconds) for the timestamp.
	// Reject requests older than 5 minutes to prevent replay attacks.
	const ts = parseInt(timestamp, 10);
	const now = Date.now();
	if (isNaN(ts) || Math.abs(now - ts) > 5 * 60 * 1000) return null;

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

/**
 * Authenticates the webhook signature, parses the JSON payload, and resolves the Discord user mapping.
 * For delete events, the email is in member.previous (member.current is empty).
 * @returns A WebhookContext on success, or an error Response on failure (auth, parse, or missing mapping).
 */
async function parseWebhookRequest(request: Request, env: Env, deleted = false): Promise<WebhookContext | Response> {
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
	const source = deleted ? member?.previous : member?.current;
	if (!source?.email) {
		return json({ error: "Invalid payload: missing member email" }, 400);
	}

	const email = source.email.toLowerCase();
	const discordUserId = await env.GHOST_DISCORD_MAPPING.get(email);
	if (!discordUserId) {
		console.warn(`No Discord mapping found for email: ${email}`);
		return json({ ok: true, skipped: true, reason: "no_mapping" });
	}

	return { email, discordUserId, member };
}

/**
 * Handles Ghost member.added and member.updated webhook events.
 * - member.added: assigns "Membre" role + "Membre Premium" if paid/comped.
 * - member.updated: syncs the premium role on status transitions.
 */
export async function handleWebhook(request: Request, env: Env): Promise<Response> {
	const result = await parseWebhookRequest(request, env);
	if (result instanceof Response) return result;

	const { email, discordUserId, member } = result;
	const hasPrevious = member.previous && Object.keys(member.previous).length > 0;

	if (!hasPrevious) {
		console.log(`member.added: ${email} (${member.current.status})`);
		await addRole(env, discordUserId, env.DISCORD_ROLE_MEMBER);
		if (isPaid(member.current.status)) {
			await addRole(env, discordUserId, env.DISCORD_ROLE_PREMIUM);
		}
	} else if (member.previous?.status && member.previous.status !== member.current.status) {
		if (!isPaid(member.previous.status) && isPaid(member.current.status)) {
			console.log(`member.updated (free->paid): ${email}`);
			await addRole(env, discordUserId, env.DISCORD_ROLE_PREMIUM);
		} else if (isPaid(member.previous.status) && !isPaid(member.current.status)) {
			console.log(`member.updated (paid->free): ${email}`);
			await removeRole(env, discordUserId, env.DISCORD_ROLE_PREMIUM);
		}
	}

	return json({ ok: true });
}

/**
 * Handles Ghost member.deleted webhook events.
 * Removes both "Membre" and "Membre Premium" roles from the linked Discord user.
 */
export async function handleWebhookDeleted(request: Request, env: Env): Promise<Response> {
	const result = await parseWebhookRequest(request, env, true);
	if (result instanceof Response) return result;

	const { email, discordUserId } = result;
	console.log(`member.deleted: ${email}`);
	await removeRole(env, discordUserId, env.DISCORD_ROLE_MEMBER);
	await removeRole(env, discordUserId, env.DISCORD_ROLE_PREMIUM);

	return json({ ok: true });
}
