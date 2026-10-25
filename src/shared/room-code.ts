/** Unambiguous alphabet: no 0/O or 1/I. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 6;

export function generateRoomCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  // 256 is a multiple of 32, so a byte modulo the alphabet length is unbiased.
  return Array.from(random(ROOM_CODE_LENGTH), (b) => ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length]).join("");
}

/** Uppercases and trims user input; returns null if it isn't a valid code. */
export function normalizeRoomCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const code = input.trim().toUpperCase();
  return isValidRoomCode(code) ? code : null;
}

export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/**
 * The phone camera page a studio's QR opens: `/capture?room=CODE`. `site` is
 * the page's origin and base path (passed in: the Worker shares this module
 * and has neither).
 */
export function captureUrl(roomCode: string, site: { origin: string; base: string }): string {
  return `${site.origin}${site.base}capture?room=${roomCode}`;
}
