/**
 * Room codes.
 *
 * A code is the only secret in the system, and it does two jobs at once:
 *
 *   - hashed, it becomes the room identifier published to a public relay, so a
 *     relay operator sees an opaque id and never the code itself;
 *   - raw, it becomes the encryption password, so the handshake is end-to-end
 *     encrypted on infrastructure we do not control.
 *
 * The alphabet is Crockford base32, which drops I, L, O and U. That removes the
 * 0/O and 1/I/l confusions outright, and lets us accept those characters on
 * input by folding them to the digit a reader meant.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const CODE_LENGTH = 8;

/**
 * A random code. 32^8 is about 1.1e12, which is far past guessing range for a
 * casual game — and guessing is the only way in, since the code is never
 * published anywhere.
 */
export function generateCode(length = CODE_LENGTH): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  // 256 is an exact multiple of 32, so the modulo introduces no bias.
  let code = '';
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
  return code;
}

/**
 * Clean up a typed or pasted code: strip separators, uppercase, and fold the
 * characters Crockford excludes onto the digits they resemble.
 */
export function normalizeCode(input: string): string {
  let out = '';
  for (const raw of input.toUpperCase()) {
    const ch = raw === 'O' ? '0' : raw === 'I' || raw === 'L' ? '1' : raw;
    if (ALPHABET.includes(ch)) out += ch;
  }
  return out;
}

export function isValidCode(input: string): boolean {
  return normalizeCode(input).length === CODE_LENGTH;
}

/** Group a code for display: 4K9M8HQ2 reads better as 4K9M-8HQ2. */
export function formatCode(code: string): string {
  const clean = normalizeCode(code);
  const half = Math.ceil(clean.length / 2);
  return `${clean.slice(0, half)}-${clean.slice(half)}`;
}

/**
 * The public room identifier: a truncated SHA-256 of the code.
 *
 * Deriving rather than using the code directly is what keeps the shared secret
 * off the relay, since the relay must see the room id to route the handshake.
 */
export async function roomIdFor(code: string): Promise<string> {
  const data = new TextEncoder().encode(`twixt-room:${normalizeCode(code)}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** A link that opens the app straight into this room. */
export function shareLink(code: string, base?: string): string {
  const href = base ?? (typeof location === 'undefined' ? '' : location.href);
  const url = new URL(href || 'https://example.invalid/');
  // The code rides in the fragment, which browsers never send to the server —
  // so even the static host that served the page never learns it.
  url.hash = `r=${normalizeCode(code)}`;
  return url.toString();
}

/** Pull a room code out of a URL fragment, if there is one. */
export function codeFromHash(hash: string): string | null {
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(trimmed);
  const code = params.get('r');
  if (!code) return null;
  return isValidCode(code) ? normalizeCode(code) : null;
}
