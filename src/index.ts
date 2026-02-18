import type { Env } from "./types";
import { json } from "./utils";
import { handleWebhook, handleWebhookDeleted } from "./webhooks";
import { handleLinkPost, handleLinkDelete, handleLinkGet } from "./admin";
import { handleDiscordInteraction } from "./commands";

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
		if (path === "/webhook" && request.method === "POST") {
			return handleWebhook(request, env);
		}
		if (path === "/webhook/deleted" && request.method === "POST") {
			return handleWebhookDeleted(request, env);
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
