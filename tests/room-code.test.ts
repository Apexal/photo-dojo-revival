import { describe, expect, it } from "vitest";
import { ROOM_CODE_ALPHABET, generateRoomCode, isValidRoomCode, normalizeRoomCode } from "../src/shared/room-code";

describe("room codes", () => {
  it("generates 6-char codes from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode();
      expect(code).toMatch(/^[A-Z2-9]{6}$/);
      expect(code).not.toMatch(/[01OI]/);
      expect(isValidRoomCode(code)).toBe(true);
    }
    expect(ROOM_CODE_ALPHABET).toHaveLength(32);
  });

  it("uses the random source", () => {
    expect(generateRoomCode(() => new Uint8Array([0, 1, 2, 31, 32, 255]))).toBe("ABC9A9");
  });

  it("validates and normalizes", () => {
    expect(normalizeRoomCode(" abc234 ")).toBe("ABC234");
    expect(normalizeRoomCode("ABC10O")).toBeNull();
    expect(normalizeRoomCode("ABCDE")).toBeNull();
    expect(normalizeRoomCode(null)).toBeNull();
    expect(isValidRoomCode("ABCDEFG")).toBe(false);
  });
});
