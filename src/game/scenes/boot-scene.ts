import Phaser from "phaser";
import { SOUND_IDS } from "../../shared/fighter-model";
import { getSetting, onDbBlocked, openFighterDb } from "../../shared/fighter-storage";
import { loadLibrary } from "../fighter-library";
import { GAME_SOUND_IDS, gameSoundKey } from "../game-sounds";
import { preloadAnnouncer } from "../announcer";
import { loadOptions } from "../options";
import { loadFighterRecords } from "../fighter-records";
import { loadPlayedFighters } from "../played-fighters";
import { fallbackSoundKey } from "../render/fighter-sprite-view";
import { GAME_HEIGHT, GAME_WIDTH } from "../render/stage";
import { COLOR, displayText } from "../render/theme";

export const REGISTRY = { library: "library", debugHitboxes: "debugHitboxes", lastStage: "lastStage", series: "series" } as const;

/**
 * Where the game opens: the title, or fighter select for `/?to=select` (the
 * studio's "Back to the game"). The parameter is dropped from the address, so
 * a reload opens the title again.
 */
function firstScene(): "title" | "character-select" {
  const params = new URLSearchParams(location.search);
  if (params.get("to") !== "select") return "title";
  params.delete("to");
  const query = params.toString();
  history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
  return "character-select";
}

/** Opens IndexedDB, loads settings and the fighter library (fresh on every page load: the studio saves into it). */
export class BootScene extends Phaser.Scene {
  constructor() {
    super("boot");
  }

  preload(): void {
    for (const id of SOUND_IDS) this.load.audio(fallbackSoundKey(id), `${import.meta.env.BASE_URL}sounds/${id}.wav`);
    for (const id of GAME_SOUND_IDS) this.load.audio(gameSoundKey(id), `${import.meta.env.BASE_URL}sounds/${id}.wav`);
    preloadAnnouncer(this);
  }

  create(): void {
    const text = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2, "Loading…", displayText(32, COLOR.fg)).setOrigin(0.5);
    // An older Foto Fighter tab holding the database open stalls the upgrade until it closes.
    const offBlocked = onDbBlocked(() => text.setText("Close other Foto Fighter tabs\nto finish loading.").setAlign("center"));
    void (async () => {
      try {
        try {
          await openFighterDb();
        } finally {
          offBlocked();
        }
        text.setText("Loading…");
        this.registry.set(REGISTRY.debugHitboxes, (await getSetting("debugHitboxes")) ?? false);
        await loadOptions(this.registry);
        await loadPlayedFighters(this.registry);
        await loadFighterRecords(this.registry);
      } catch (err) {
        console.error("[boot] IndexedDB unavailable; fighters won't be saved", err);
      }
      try {
        this.registry.set(REGISTRY.library, await loadLibrary());
        // Menu music on fighter select waits for the first key press there: browsers hold sound back until a gesture.
        this.scene.start(firstScene());
      } catch (err) {
        text.setText(`Couldn't load fighters:\n${(err as Error).message}`).setAlign("center");
      }
    })();
  }
}
