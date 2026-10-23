import type Phaser from "phaser";
import { getSetting, setSetting } from "../shared/fighter-storage";
import { DEFAULT_KEY_BINDINGS, isKeyBindings, setKeyBindings, type KeyBindings } from "./input/key-bindings";

/** Player-facing settings; each is saved under its own key in the settings store. */
export interface GameOptions {
  /** 0..1: bundled game sounds (hits, blocks, the clock). */
  gameVolume: number;
  /** 0..1: the fighters' voices. */
  voiceVolume: number;
  screenShake: boolean;
  rumble: boolean;
}

export const DEFAULT_OPTIONS: Readonly<GameOptions> = Object.freeze({ gameVolume: 0.8, voiceVolume: 1, screenShake: true, rumble: true });

const REGISTRY_KEY = "options";

/** Boot: read the saved options and key bindings (missing or malformed values fall back to the defaults). */
export async function loadOptions(registry: Phaser.Data.DataManager): Promise<void> {
  const options = { ...DEFAULT_OPTIONS };
  for (const key of Object.keys(DEFAULT_OPTIONS) as (keyof GameOptions)[]) {
    const value = await getSetting(key);
    if (typeof value === typeof DEFAULT_OPTIONS[key]) (options as Record<string, unknown>)[key] = value;
  }
  registry.set(REGISTRY_KEY, options);
  const bindings = await getSetting("keyBindings");
  if (isKeyBindings(bindings)) setKeyBindings(bindings);
}

export function getOptions(registry: Phaser.Data.DataManager): GameOptions {
  return registry.get(REGISTRY_KEY) ?? { ...DEFAULT_OPTIONS };
}

export function setOption<K extends keyof GameOptions>(registry: Phaser.Data.DataManager, key: K, value: GameOptions[K]): void {
  registry.set(REGISTRY_KEY, { ...getOptions(registry), [key]: value });
  void setSetting<keyof GameOptions>(key, value).catch(() => {});
}

export function saveKeyBindings(bindings: KeyBindings): void {
  setKeyBindings(bindings);
  void setSetting("keyBindings", bindings).catch(() => {});
}

export const resetKeyBindings = () => saveKeyBindings(DEFAULT_KEY_BINDINGS);
