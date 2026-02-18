
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
	GHOST_ADMIN_API_KEY: string;
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

export type GhostLookupResult =
	| { status: "found"; member: GhostMemberData }
	| { status: "not_found" }
	| { status: "error"; message: string };
