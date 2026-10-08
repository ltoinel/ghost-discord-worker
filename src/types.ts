
export interface Env {
	GHOST_DISCORD_MAPPING: KVNamespace;
	WEBHOOK_SECRET: string;
	ADMIN_SECRET: string;
	DISCORD_BOT_TOKEN: string;
	DISCORD_GUILD_ID: string;
	DISCORD_ROLE_MEMBER: string;
	DISCORD_ROLE_PREMIUM: string;
	DISCORD_PUBLIC_KEY: string;
	GHOST_URL: string;
}

export type MemberStatus = "free" | "paid" | "comped";

export interface GhostMemberData {
	id?: string;
	email: string;
	name?: string;
	status: MemberStatus;
}

export interface GhostWebhookPayload {
	member: {
		current: GhostMemberData;
		previous?: Partial<GhostMemberData>;
	};
}

/** Value stored under `code:<CODE>` in KV, captured from the entitlement JWT at mint time. */
export interface PendingLink {
	email: string;
	paid: boolean;
}
