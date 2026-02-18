import type { Env } from "./types";
import { json, isValidEmail, isPaid } from "./utils";
import { verifyDiscordSignature, addRole } from "./discord";
import { getGhostMember } from "./ghost";

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 } as const;
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

	const interaction = JSON.parse(body);

	if (interaction.type === InteractionType.PING) {
		return json({ type: InteractionType.PING });
	}

	if (interaction.type === InteractionType.APPLICATION_COMMAND) {
		const commandName = interaction.data?.name;
		const userId = interaction.member?.user?.id;

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
 * Handles the /link slash command.
 * Verifies the email exists in Ghost, enforces 1:1 mapping between email and Discord account,
 * stores the bidirectional mapping, and assigns the appropriate Discord roles.
 */
async function handleLinkCommand(interaction: any, userId: string, env: Env): Promise<Response> {
	const email = interaction.data.options?.[0]?.value?.toLowerCase();
	if (!email) {
		return ephemeralReply("Please provide your email.");
	}

	if (!isValidEmail(email)) {
		return ephemeralReply("Please provide a valid email address.");
	}

	const existingUserId = await env.GHOST_DISCORD_MAPPING.get(email);
	if (existingUserId && existingUserId !== userId) {
		return ephemeralReply("This email is already linked to another Discord account.");
	}

	const existingEmail = await env.GHOST_DISCORD_MAPPING.get(`discord:${userId}`);
	if (existingEmail && existingEmail !== email) {
		return ephemeralReply(`Your Discord account is already linked to **${existingEmail}**. Use \`/unlink\` first.`);
	}

	const ghostResult = await getGhostMember(email, env);
	if (ghostResult.status === "error") {
		return ephemeralReply(`An error occurred while verifying your email: ${ghostResult.message}`);
	}
	if (ghostResult.status === "not_found") {
		return ephemeralReply("This email is not associated with any Ghost membership.");
	}

	await env.GHOST_DISCORD_MAPPING.put(email, userId);
	await env.GHOST_DISCORD_MAPPING.put(`discord:${userId}`, email);

	const errors: string[] = [];
	const err1 = await addRole(env, userId, env.DISCORD_ROLE_MEMBER);
	if (err1) errors.push(err1);
	if (isPaid(ghostResult.member.status)) {
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
 * Removes the bidirectional email ↔ Discord mapping from KV.
 */
async function handleUnlinkCommand(userId: string, env: Env): Promise<Response> {
	const email = await env.GHOST_DISCORD_MAPPING.get(`discord:${userId}`);
	if (!email) {
		return ephemeralReply("No email is linked to your Discord account.");
	}

	await env.GHOST_DISCORD_MAPPING.delete(email);
	await env.GHOST_DISCORD_MAPPING.delete(`discord:${userId}`);

	return ephemeralReply(`Your email **${email}** has been unlinked from your Discord account.`);
}
