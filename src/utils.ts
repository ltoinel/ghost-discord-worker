import type { MemberStatus } from "./types";

/**
 * Compares two strings in constant time to prevent timing attacks.
 * Iterates over the max length and XORs lengths to avoid leaking secret size.
 */
export function timingSafeEqual(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const bufA = encoder.encode(a);
	const bufB = encoder.encode(b);
	const maxLen = Math.max(bufA.length, bufB.length);
	let result = bufA.length ^ bufB.length;
	for (let i = 0; i < maxLen; i++) {
		result |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
	}
	return result === 0;
}

const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/** Validates email format against RFC 5322 and enforces the RFC 5321 max length of 254 characters. */
export function isValidEmail(email: string): boolean {
	return EMAIL_REGEX.test(email) && email.length <= 254;
}

/** Converts a hexadecimal string to its byte representation. */
export function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
	}
	return bytes;
}

/** Creates a JSON Response with the appropriate Content-Type header. */
export function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Returns true for "paid" and "comped" statuses, which both grant premium access. */
export function isPaid(status: MemberStatus): boolean {
	return status === "paid" || status === "comped";
}
