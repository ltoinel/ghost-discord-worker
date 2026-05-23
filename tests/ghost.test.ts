import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getGhostMember } from "../src/ghost";
import { createEnv } from "./helpers";
import type { Env } from "../src/types";

describe("getGhostMember", () => {
	let env: Env;
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		env = createEnv();
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("escapes single quotes in the email to prevent NQL filter injection", async () => {
		fetchSpy.mockResolvedValue(
			new Response(JSON.stringify({ members: [] }), { status: 200 }),
		);
		await getGhostMember("evil'or'1=1@x.co", env);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const url = String(fetchSpy.mock.calls[0][0]);
		// After Ghost URL-decodes the query string, the filter value must contain
		// escaped quotes (`\'`), not bare `'` that would close the NQL string early.
		const decoded = decodeURIComponent(url);
		expect(decoded).toContain("email:'evil\\'or\\'1=1@x.co'");
	});

	it("escapes backslashes too (NQL escape character)", async () => {
		fetchSpy.mockResolvedValue(
			new Response(JSON.stringify({ members: [] }), { status: 200 }),
		);
		await getGhostMember("a\\b@x.co", env);
		const url = String(fetchSpy.mock.calls[0][0]);
		const decoded = decodeURIComponent(url);
		// Single backslash in email → double backslash in filter value.
		expect(decoded).toContain("email:'a\\\\b@x.co'");
	});

	it("does not alter plain emails", async () => {
		fetchSpy.mockResolvedValue(
			new Response(JSON.stringify({ members: [{ email: "a@b.co", status: "free" }] }), { status: 200 }),
		);
		await getGhostMember("a@b.co", env);
		const url = String(fetchSpy.mock.calls[0][0]);
		expect(url).toContain("filter=email:'a%40b.co'");
	});

	it("returns 'found' when a member matches", async () => {
		fetchSpy.mockResolvedValue(
			new Response(
				JSON.stringify({ members: [{ email: "a@b.co", status: "paid" }] }),
				{ status: 200 },
			),
		);
		const res = await getGhostMember("a@b.co", env);
		expect(res.status).toBe("found");
		if (res.status === "found") {
			expect(res.member.email).toBe("a@b.co");
			expect(res.member.status).toBe("paid");
		}
	});

	it("returns 'not_found' when the members array is empty", async () => {
		fetchSpy.mockResolvedValue(
			new Response(JSON.stringify({ members: [] }), { status: 200 }),
		);
		const res = await getGhostMember("missing@b.co", env);
		expect(res.status).toBe("not_found");
	});

	it("returns 'error' on non-2xx response from Ghost", async () => {
		fetchSpy.mockResolvedValue(new Response("server died", { status: 500 }));
		const res = await getGhostMember("a@b.co", env);
		expect(res.status).toBe("error");
	});

	it("returns 'error' on network failure", async () => {
		fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
		const res = await getGhostMember("a@b.co", env);
		expect(res.status).toBe("error");
	});
});
