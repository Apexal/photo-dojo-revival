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

/** "3:12" — time left before a room code refreshes (rounded up to the second). */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
