import { describe, expect, it } from "vitest";
import { MAX_TYPED_NAME_LENGTH, tidyFighterName } from "../src/shared/fighter-model";

describe("tidyFighterName", () => {
  it("trims, collapses spaces and cuts to the typed limit", () => {
    expect(tidyFighterName("  Big   Frank \t")).toBe("Big Frank");
    expect(tidyFighterName("x".repeat(40))).toHaveLength(MAX_TYPED_NAME_LENGTH);
    // No trailing space left where the cut lands.
    expect(tidyFighterName(`${"a".repeat(MAX_TYPED_NAME_LENGTH - 1)} b`)).toBe("a".repeat(MAX_TYPED_NAME_LENGTH - 1));
  });

  it("leaves nothing for a blank name", () => {
    expect(tidyFighterName("   ")).toBe("");
  });
});
