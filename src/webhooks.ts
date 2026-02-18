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
 * Authenticates the webhook secret, parses the JSON payload, and resolves the Discord user mapping.
 * @returns A WebhookContext on success, or an error Response on failure (auth, parse, or missing mapping).
 */
async function parseWebhookRequest(request: Request, env: Env): Promise<WebhookContext | Response> {
	const url = new URL(request.url);
	const secret = url.searchParams.get("secret");

	if (!secret || !timingSafeEqual(secret, env.WEBHOOK_SECRET)) {
		return json({ error: "Unauthorized" }, 401);
	}

	let payload: GhostWebhookPayload;
	try {
		payload = await request.json();
	} catch {
		return json({ error: "Invalid JSON" }, 400);
	}

	const { member } = payload;
	if (!member?.current?.email) {
		return json({ error: "Invalid payload: missing member.current.email" }, 400);
	}

	const email = member.current.email.toLowerCase();
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
	const result = await parseWebhookRequest(request, env);
	if (result instanceof Response) return result;

	const { email, discordUserId } = result;
	console.log(`member.deleted: ${email}`);
	await removeRole(env, discordUserId, env.DISCORD_ROLE_MEMBER);
	await removeRole(env, discordUserId, env.DISCORD_ROLE_PREMIUM);

	return json({ ok: true });
}
