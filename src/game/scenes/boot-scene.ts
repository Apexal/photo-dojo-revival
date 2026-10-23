import Phaser from "phaser";
import { SOUND_IDS } from "../../shared/fighter-model";
import { getSetting, openFighterDb } from "../../shared/fighter-storage";
import { loadLibrary, type LibraryEntry } from "../fighter-library";
import { HostSession } from "../host-session";
import { GAME_SOUND_IDS, gameSoundKey } from "../game-sounds";
import { loadOptions } from "../options";
import { loadPlayedFighters } from "../played-fighters";
import { fallbackSoundKey } from "../render/fighter-sprite-view";
import { GAME_HEIGHT, GAME_WIDTH } from "../render/stage";

export const REGISTRY = { library: "library", debugHitboxes: "debugHitboxes", host: "host", lastStage: "lastStage" } as const;

/** Opens IndexedDB, loads settings and the fighter library. */
export class BootScene extends Phaser.Scene {
  constructor() {
    super("boot");
  }

  preload(): void {
    for (const id of SOUND_IDS) this.load.audio(fallbackSoundKey(id), `${import.meta.env.BASE_URL}sounds/${id}.wav`);
    for (const id of GAME_SOUND_IDS) this.load.audio(gameSoundKey(id), `${import.meta.env.BASE_URL}sounds/${id}.wav`);
  }

  create(): void {
    const text = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2, "Loading…", { fontSize: "32px", color: "#f3efe6" }).setOrigin(0.5);
    void (async () => {
      try {
        await openFighterDb();
        this.registry.set(REGISTRY.debugHitboxes, (await getSetting("debugHitboxes")) ?? false);
        await loadOptions(this.registry);
        await loadPlayedFighters(this.registry);
      } catch (err) {
        console.error("[boot] IndexedDB unavailable; fighters won't be saved", err);
      }
      try {
        this.registry.set(REGISTRY.library, await loadLibrary());
        this.startHosting();
        this.scene.start("title");
      } catch (err) {
        text.setText(`Couldn't load fighters:\n${(err as Error).message}`).setAlign("center");
      }
    })();
  }

  /** One room for the whole session; received fighters join the library even mid-fight. */
  private startHosting(): void {
    const host = new HostSession();
    host.subscribe(() => {}, (fighter) => {
      const library: LibraryEntry[] = this.registry.get(REGISTRY.library) ?? [];
      this.registry.set(REGISTRY.library, [{ fighter, builtIn: false }, ...library.filter((e) => e.fighter.fighterId !== fighter.fighterId)]);
    });
    this.registry.set(REGISTRY.host, host);
    void host.start();
  }
}
