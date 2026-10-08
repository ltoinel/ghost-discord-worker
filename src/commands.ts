import type { Env } from "./types";
import { json } from "./utils";
import { verifyDiscordSignature, addRole, removeRole } from "./discord";
import { parsePendingLink } from "./code";

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 } as const;

/** The subset of a Discord interaction payload this Worker reads. */
interface DiscordInteraction {
	type: number;
	data?: { name?: string; options?: { name: string; value: unknown }[] };
	/** Set for guild interactions. */
	member?: { user?: { id?: string } };
	/** Set for DM / user-app interactions. */
	user?: { id?: string };
}
const MessageFlags = { EPHEMERAL: 64 } as const;

/** Creates a Discord ephemeral reply visible only to the invoking user. */
function ephemeralReply(content: string): Response {
	return json({ type: 4, data: { content, flags: MessageFlags.EPHEMERAL } });
}

/**
 * Entry point for Discord interactions (POST /discord).
 * Verifies the Ed25519 signature, then dispatches to the appropriate slash command handler.
 */
export async function handleDiscordInteraction(request: Request, env: Env): Promise<Response> {
	const body = await verifyDiscordSignature(request, env.DISCORD_PUBLIC_KEY);
	if (!body) {
		return json({ error: "Invalid signature" }, 401);
	}

	const interaction = JSON.parse(body) as DiscordInteraction;

	if (interaction.type === InteractionType.PING) {
		return json({ type: InteractionType.PING });
	}

	if (interaction.type === InteractionType.APPLICATION_COMMAND) {
		const commandName = interaction.data?.name;
		// Guild interactions expose member.user.id; DM/user-app interactions use user.id.
		const userId = interaction.member?.user?.id ?? interaction.user?.id;
		if (!userId) {
			return ephemeralReply("Unable to identify your Discord account. Please try again from a server channel.");
		}

		if (commandName === "link") {
			return handleLinkCommand(interaction, userId, env);
		}

		if (commandName === "unlink") {
			return handleUnlinkCommand(userId, env);
		}

		return ephemeralReply("Unknown command.");
	}

	return json({ error: "Unknown interaction type" }, 400);
}

/**
 * Handles the /link <code> slash command.
 * Redeems a single-use code (minted by POST /code after Ghost entitlement JWT verification),
 * enforces 1:1 mapping between email and Discord account, stores the bidirectional
 * mapping, and assigns Discord roles from the `paid` flag captured with the code.
 */
async function handleLinkCommand(interaction: DiscordInteraction, userId: string, env: Env): Promise<Response> {
	const rawCode = interaction.data?.options?.[0]?.value;
	if (!rawCode) {
		return ephemeralReply("Please provide your linking code. Visit your Ghost site to generate one.");
	}

	const code = String(rawCode).trim().toUpperCase();
	const pending = parsePendingLink(await env.GHOST_DISCORD_MAPPING.get(`code:${code}`));
	if (!pending) {
		return ephemeralReply("Invalid or expired code. Visit your Ghost site to generate a new one.");
	}
	const { email, paid } = pending;

	const existingUserId = await env.GHOST_DISCORD_MAPPING.get(email);
	if (existingUserId && existingUserId !== userId) {
		return ephemeralReply("This email is already linked to another Discord account.");
	}

	const existingEmail = await env.GHOST_DISCORD_MAPPING.get(`discord:${userId}`);
	if (existingEmail && existingEmail !== email) {
		return ephemeralReply(`Your Discord account is already linked to **${existingEmail}**. Use \`/unlink\` first.`);
	}

	// Consume the code before writing the mapping so a concurrent redemption of the same code
	// fails its lookup instead of linking a second Discord account.
	await env.GHOST_DISCORD_MAPPING.delete(`code:${code}`);
	await env.GHOST_DISCORD_MAPPING.put(email, userId);
	await env.GHOST_DISCORD_MAPPING.put(`discord:${userId}`, email);

	const errors: string[] = [];
	const err1 = await addRole(env, userId, env.DISCORD_ROLE_MEMBER);
	if (err1) errors.push(err1);
	if (paid) {
		const err2 = await addRole(env, userId, env.DISCORD_ROLE_PREMIUM);
		if (err2) errors.push(err2);
	}

	if (errors.length > 0) {
		console.error(`Role assignment errors for ${email}: ${errors.join("; ")}`);
		return ephemeralReply(`Your email **${email}** has been linked, but roles could not be assigned. Please contact an administrator.`);
	}

	return ephemeralReply(`Your email **${email}** has been linked to your Discord account.`);
}

/**
 * Handles the /unlink slash command.
 * Removes the Member and Premium roles, then the bidirectional email ↔ Discord mapping.
 * Roles go first: once unlinked, webhooks can no longer revoke them, so keeping them would
 * let one membership grant roles to any number of Discord accounts (link, unlink, repeat).
 */
async function handleUnlinkCommand(userId: string, env: Env): Promise<Response> {
	const email = await env.GHOST_DISCORD_MAPPING.get(`discord:${userId}`);
	if (!email) {
		return ephemeralReply("No email is linked to your Discord account.");
	}

	const errors: string[] = [];
	const err1 = await removeRole(env, userId, env.DISCORD_ROLE_MEMBER);
	if (err1) errors.push(err1);
	const err2 = await removeRole(env, userId, env.DISCORD_ROLE_PREMIUM);
	if (err2) errors.push(err2);

	if (errors.length > 0) {
		console.error(`Role removal errors for ${email}: ${errors.join("; ")}`);
		return ephemeralReply("Your roles could not be removed, so your account is still linked. Please try again later or contact an administrator.");
	}

	await env.GHOST_DISCORD_MAPPING.delete(email);
	await env.GHOST_DISCORD_MAPPING.delete(`discord:${userId}`);

	return ephemeralReply(`Your email **${email}** has been unlinked from your Discord account and your roles have been removed.`);
}
