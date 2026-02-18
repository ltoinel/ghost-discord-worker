import type { Env } from "./types";
import { hexToBytes } from "./utils";

const DISCORD_API = "https://discord.com/api/v10";

/**
 * Verifies the Ed25519 signature of a Discord interaction request.
 * Consumes the request body stream during verification.
 * @returns The raw body string on success (for subsequent parsing), null on failure.
 */
export async function verifyDiscordSignature(request: Request, publicKey: string): Promise<string | null> {
	const signature = request.headers.get("X-Signature-Ed25519");
	const timestamp = request.headers.get("X-Signature-Timestamp");
	if (!signature || !timestamp) return null;

	const body = await request.text();
	const key = await crypto.subtle.importKey(
		"raw",
		hexToBytes(publicKey),
		{ name: "Ed25519", namedCurve: "Ed25519" },
		false,
		["verify"],
	);

	const message = new TextEncoder().encode(timestamp + body);
	const isValid = await crypto.subtle.verify("Ed25519", key, hexToBytes(signature), message);

	return isValid ? body : null;
}

/**
 * Adds or removes a role from a guild member via the Discord API.
 * @returns An error description on failure, null on success.
 */
async function modifyMemberRole(env: Env, userId: string, roleId: string, method: "PUT" | "DELETE"): Promise<string | null> {
	const res = await fetch(
		`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${userId}/roles/${roleId}`,
		{
			method,
			headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
		},
	);
	if (!res.ok) {
		const body = await res.text();
		console.error(`Discord ${method} role ${roleId} failed: ${res.status} ${body}`);
		return `${method} role ${roleId}: ${res.status} ${body}`;
	}
	return null;
}

/** Assigns a Discord role to a guild member. Returns an error description on failure. */
export function addRole(env: Env, userId: string, roleId: string): Promise<string | null> {
	return modifyMemberRole(env, userId, roleId, "PUT");
}

/** Removes a Discord role from a guild member. Returns an error description on failure. */
export function removeRole(env: Env, userId: string, roleId: string): Promise<string | null> {
	return modifyMemberRole(env, userId, roleId, "DELETE");
}
