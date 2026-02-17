interface Env {
	GHOST_DISCORD_MAPPING: KVNamespace;
	WEBHOOK_SECRET: string;
	ADMIN_SECRET: string;
	DISCORD_BOT_TOKEN: string;
	DISCORD_GUILD_ID: string;
	DISCORD_ROLE_MEMBER: string;
	DISCORD_ROLE_PREMIUM: string;
}

interface GhostMemberData {
	id?: string;
	email: string;
	name?: string;
	status: "free" | "paid" | "comped";
}

interface GhostWebhookPayload {
	member: {
		current: GhostMemberData;
		previous?: Partial<GhostMemberData>;
	};
}

// Timing-safe string comparison to prevent timing attacks
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	const encoder = new TextEncoder();
	const bufA = encoder.encode(a);
	const bufB = encoder.encode(b);
	let result = 0;
	for (let i = 0; i < bufA.length; i++) {
		result |= bufA[i] ^ bufB[i];
	}
	return result === 0;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

// Discord API helpers
const DISCORD_API = "https://discord.com/api/v10";

async function addRole(env: Env, userId: string, roleId: string): Promise<void> {
	const res = await fetch(
		`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${userId}/roles/${roleId}`,
		{
			method: "PUT",
			headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
		}
	);
	if (!res.ok) {
		const body = await res.text();
		console.error(`Discord addRole failed: ${res.status} ${body}`);
	}
}

async function removeRole(env: Env, userId: string, roleId: string): Promise<void> {
	const res = await fetch(
		`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${userId}/roles/${roleId}`,
		{
			method: "DELETE",
			headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
		}
	);
	if (!res.ok) {
		const body = await res.text();
		console.error(`Discord removeRole failed: ${res.status} ${body}`);
	}
}

// Webhook handler
async function handleWebhook(request: Request, env: Env): Promise<Response> {
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
	const currentStatus = member.current.status;
	const previousStatus = member.previous?.status;

	// Lookup discord user ID from KV
	const discordUserId = await env.GHOST_DISCORD_MAPPING.get(email);
	if (!discordUserId) {
		console.warn(`No Discord mapping found for email: ${email}`);
		return json({ ok: true, skipped: true, reason: "no_mapping" });
	}

	const hasPrevious = member.previous && Object.keys(member.previous).length > 0;

	if (!hasPrevious) {
		// member.added
		console.log(`member.added: ${email} (${currentStatus})`);
		await addRole(env, discordUserId, env.DISCORD_ROLE_MEMBER);
		if (currentStatus === "paid" || currentStatus === "comped") {
			await addRole(env, discordUserId, env.DISCORD_ROLE_PREMIUM);
		}
	} else if (previousStatus && previousStatus !== currentStatus) {
		// member.updated with status change
		const isPaidNow = currentStatus === "paid" || currentStatus === "comped";
		const wasPaid = previousStatus === "paid" || previousStatus === "comped";

		if (!wasPaid && isPaidNow) {
			// free → paid
			console.log(`member.updated (free→paid): ${email}`);
			await addRole(env, discordUserId, env.DISCORD_ROLE_PREMIUM);
		} else if (wasPaid && !isPaidNow) {
			// paid → free
			console.log(`member.updated (paid→free): ${email}`);
			await removeRole(env, discordUserId, env.DISCORD_ROLE_PREMIUM);
		}
	}
	// If previous exists but status didn't change, nothing to do for roles

	return json({ ok: true });
}

// Webhook handler for member.deleted
async function handleWebhookDeleted(request: Request, env: Env): Promise<Response> {
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

	console.log(`member.deleted: ${email}`);
	await removeRole(env, discordUserId, env.DISCORD_ROLE_MEMBER);
	await removeRole(env, discordUserId, env.DISCORD_ROLE_PREMIUM);

	return json({ ok: true });
}

// Admin auth check
function checkAdmin(request: Request, env: Env): boolean {
	const auth = request.headers.get("Authorization");
	if (!auth) return false;
	const token = auth.replace("Bearer ", "");
	return timingSafeEqual(token, env.ADMIN_SECRET);
}

// Link handlers
async function handleLinkPost(request: Request, env: Env): Promise<Response> {
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

	const email = body.email.toLowerCase();
	await env.GHOST_DISCORD_MAPPING.put(email, body.discord_user_id);

	return json({ ok: true, email, discord_user_id: body.discord_user_id });
}

async function handleLinkDelete(request: Request, env: Env): Promise<Response> {
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

	const email = body.email.toLowerCase();
	await env.GHOST_DISCORD_MAPPING.delete(email);

	return json({ ok: true, email });
}

async function handleLinkGet(email: string, request: Request, env: Env): Promise<Response> {
	if (!checkAdmin(request, env)) {
		return json({ error: "Unauthorized" }, 401);
	}

	const normalizedEmail = email.toLowerCase();
	const discordUserId = await env.GHOST_DISCORD_MAPPING.get(normalizedEmail);

	if (!discordUserId) {
		return json({ error: "Not found" }, 404);
	}

	return json({ email: normalizedEmail, discord_user_id: discordUserId });
}

// Router
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// POST /webhook — member.added or member.updated
		if (path === "/webhook" && request.method === "POST") {
			return handleWebhook(request, env);
		}

		// POST /webhook/deleted — member.deleted
		if (path === "/webhook/deleted" && request.method === "POST") {
			return handleWebhookDeleted(request, env);
		}

		// POST /link — create mapping
		if (path === "/link" && request.method === "POST") {
			return handleLinkPost(request, env);
		}

		// DELETE /link — delete mapping
		if (path === "/link" && request.method === "DELETE") {
			return handleLinkDelete(request, env);
		}

		// GET /link/:email — get mapping
		if (path.startsWith("/link/") && request.method === "GET") {
			const email = decodeURIComponent(path.slice(6));
			return handleLinkGet(email, request, env);
		}

		return json({ error: "Not found" }, 404);
	},
} satisfies ExportedHandler<Env>;
