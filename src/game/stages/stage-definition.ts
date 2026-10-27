import type Phaser from "phaser";
import type { FighterState } from "../../simulation/fighter-state-machine";
import type { TopEdge } from "../render/top-edge";

/**
 * A place to fight. Stages are scenery only: the fight's floor, walls and
 * width are the same everywhere (see render/stage.ts), so a stage can't change
 * the rules. To add one: write a StageDefinition in its own file in this
 * folder and list it in STAGES (stages.ts). Images and sounds go in
 * public/stages/<id>/ and are queued in `preload`; a soundtrack only needs
 * `music` (stage-music.ts loads and plays it). Weather that touches the
 * fighters goes in `effects`.
 */
export interface StageDefinition {
  /** Stable id: kept in the match setup and as the last pick. Never reuse or rename one. */
  readonly id: string;
  /** Shown on the stage select screen. */
  readonly name: string;
  /**
   * Looping soundtrack for fights here (and the stage select preview). `files`
   * are file names in the music folder (see music-url.ts: public/music/ in dev,
   * the R2 bucket in production); list several formats and the browser plays
   * the first it can. `volume` (0..1, default 1)
   * balances tracks against each other; the player's Music volume applies on top.
   * `credit` ("Title by Artist") shows on the stage select; also add the track
   * to the credits on the About page.
   */
  readonly music?: { readonly files: readonly string[]; readonly volume?: number; readonly credit?: string };
  /** Queue this stage's assets (scene.load.*); runs in the preload of any scene that shows it. */
  preload?(scene: Phaser.Scene): void;
  /**
   * Draw the backdrop into `layer`, in screen space: GAME_WIDTH × GAME_HEIGHT,
   * the floor's far edge at FLOOR_BACK_Y (the feet stand lower, at FLOOR_SCREEN_Y,
   * so they're on the floor, not its edge). Everything goes under the fighters. Runs
   * once per scene; animate with scene tweens if you like.
   */
  build(scene: Phaser.Scene, layer: Phaser.GameObjects.Container): void;
  /**
   * Optional effects over and around the fighters, in scenes that show a bout
   * (the fight, the title demo). Render only, like everything else here: they
   * read the fighters and never change them. Draw at `depths.under` (over the
   * backdrop, under the fighters and their shadows) or `depths.over` (over the
   * fighters, under the HUD), in the same screen space as `build`.
   */
  effects?(scene: Phaser.Scene, depths: { readonly under: number; readonly over: number }): StageEffects;
}

/** A stage's live effects (StageDefinition.effects). */
export interface StageEffects {
  /** Every rendered frame, after the fighters are drawn, with both of them as shown. */
  update(fighters: readonly StageFighter[]): void;
}

/** A fighter as a stage's effects see it. */
export interface StageFighter {
  readonly state: FighterState;
  /** Their top edge on screen as just drawn (FighterSpriteView.topEdge); null while tipped over. */
  topEdge(): TopEdge | null;
}
