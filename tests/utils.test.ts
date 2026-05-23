import { describe, it, expect } from "vitest";
import {
	timingSafeEqual,
	isValidEmail,
	hexToBytes,
	isPaid,
	json,
} from "../src/utils";

describe("timingSafeEqual", () => {
	it("returns true for equal strings", () => {
		expect(timingSafeEqual("abc", "abc")).toBe(true);
		expect(timingSafeEqual("", "")).toBe(true);
	});

	it("returns false for different strings of equal length", () => {
		expect(timingSafeEqual("abc", "abd")).toBe(false);
	});

	it("returns false for different lengths", () => {
		expect(timingSafeEqual("abc", "abcd")).toBe(false);
		expect(timingSafeEqual("", "a")).toBe(false);
	});
});

describe("isValidEmail", () => {
	it.each([
		"a@b.co",
		"user.name+tag@example.com",
		"x@x.x",
	])("accepts %s", (e) => {
		expect(isValidEmail(e)).toBe(true);
	});

	it.each([
		"no-at-sign",
		"a@",
		"@b.co",
		"a b@c.co",
		"a@.co",
	])("rejects %s", (e) => {
		expect(isValidEmail(e)).toBe(false);
	});

	it("rejects > 254 chars", () => {
		const long = "a".repeat(250) + "@b.co";
		expect(isValidEmail(long)).toBe(false);
	});
});

describe("hexToBytes", () => {
	it("decodes valid hex (lowercase + uppercase)", () => {
		expect(Array.from(hexToBytes("deadbeef"))).toEqual([
			0xde, 0xad, 0xbe, 0xef,
		]);
		expect(Array.from(hexToBytes("DEADBEEF"))).toEqual([
			0xde, 0xad, 0xbe, 0xef,
		]);
	});

	it("decodes empty input to empty array", () => {
		expect(Array.from(hexToBytes(""))).toEqual([]);
	});

	it("throws on odd length", () => {
		expect(() => hexToBytes("abc")).toThrow("Invalid hex string");
	});

	it("throws on non-hex chars", () => {
		expect(() => hexToBytes("zz")).toThrow("Invalid hex string");
	});
});

describe("isPaid", () => {
	it("treats paid and comped as premium", () => {
		expect(isPaid("paid")).toBe(true);
		expect(isPaid("comped")).toBe(true);
	});

	it("treats free as non-premium", () => {
		expect(isPaid("free")).toBe(false);
	});
});

describe("json", () => {
	it("serializes body with default 200 + Content-Type", async () => {
		const res = json({ ok: true });
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/json");
		expect(await res.json()).toEqual({ ok: true });
	});

	it("honors custom status", () => {
		expect(json({}, 418).status).toBe(418);
	});

	it("merges extra headers", () => {
		const res = json({}, 200, {
			"Access-Control-Allow-Origin": "https://x.test",
		});
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
			"https://x.test",
		);
		expect(res.headers.get("Content-Type")).toBe("application/json");
	});
});
