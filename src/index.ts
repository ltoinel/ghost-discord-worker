import type { Env } from "./types";
import { json } from "./utils";
import {
	handleMemberAdded,
	handleMemberUpdated,
	handleMemberDeleted,
} from "./webhooks";
import { handleLinkPost, handleLinkDelete, handleLinkGet } from "./admin";
import { handleDiscordInteraction } from "./commands";
import { handleCodePost, handleCodeOptions } from "./code";

/**
 * Cloudflare Worker entry point.
 * Routes incoming requests to the appropriate handler based on path and HTTP method.
 */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		if (path === "/discord" && request.method === "POST") {
			return handleDiscordInteraction(request, env);
		}
		if (path === "/code" && request.method === "POST") {
			return handleCodePost(request, env);
		}
		if (path === "/code" && request.method === "OPTIONS") {
			return handleCodeOptions(env);
		}
		if (path === "/webhook/added" && request.method === "POST") {
			return handleMemberAdded(request, env);
		}
		if (path === "/webhook/updated" && request.method === "POST") {
			return handleMemberUpdated(request, env);
		}
		if (path === "/webhook/deleted" && request.method === "POST") {
			return handleMemberDeleted(request, env);
		}
		if (path === "/link" && request.method === "POST") {
			return handleLinkPost(request, env);
		}
		if (path === "/link" && request.method === "DELETE") {
			return handleLinkDelete(request, env);
		}
		if (path.startsWith("/link/") && request.method === "GET") {
			const email = decodeURIComponent(path.slice(6));
			return handleLinkGet(email, request, env);
		}

		return json({ error: "Not found" }, 404);
	},
} satisfies ExportedHandler<Env>;
