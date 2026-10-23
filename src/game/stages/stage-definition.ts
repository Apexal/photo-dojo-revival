import type Phaser from "phaser";

/**
 * A place to fight. Stages are scenery only: the fight's floor, walls and
 * width are the same everywhere (see render/stage.ts), so a stage can't change
 * the rules. To add one: write a StageDefinition in its own file in this
 * folder and list it in STAGES (stages.ts). Images and sounds go in
 * public/stages/<id>/ and are queued in `preload`; a soundtrack only needs
 * `music` (stage-music.ts loads and plays it).
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
   * the floor line at FLOOR_SCREEN_Y. Everything goes under the fighters. Runs
   * once per scene; animate with scene tweens if you like.
   */
  build(scene: Phaser.Scene, layer: Phaser.GameObjects.Container): void;
}
