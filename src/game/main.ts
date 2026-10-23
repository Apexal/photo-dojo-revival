import Phaser from "phaser";
import { gatePhones } from "./device-gate";
import { GAME_HEIGHT, GAME_WIDTH } from "./render/stage";
import { BootScene } from "./scenes/boot-scene";
import { CharacterSelectScene } from "./scenes/character-select-scene";
import { ControlsScene } from "./scenes/controls-scene";
import { FightScene } from "./scenes/fight-scene";
import { PauseScene } from "./scenes/pause-scene";
import { RoundResultScene } from "./scenes/round-result-scene";
import { SettingsScene } from "./scenes/settings-scene";
import { FighterStatsScene } from "./scenes/fighter-stats-scene";
import { MatchResultScene } from "./scenes/match-result-scene";
import { StageSelectScene } from "./scenes/stage-select-scene";
import { TitleScene } from "./scenes/title-scene";
import { TournamentScene } from "./scenes/tournament-scene";
import { KingOfTheHillScene } from "./scenes/king-of-the-hill-scene";
import { SeriesSetupScene } from "./scenes/series-setup-scene";

/**
 * Phaser keeps gamepads in an array indexed by pad number, so a controller at
 * index 1 with nothing at 0 leaves a hole, and its shutdown/disconnect loops
 * then crash on `undefined` when a scene changes. Skip the holes.
 */
function patchSparseGamepads(): void {
  type PadList = { gamepads: (Phaser.Input.Gamepad.Gamepad | undefined)[] };
  const proto = Phaser.Input.Gamepad.GamepadPlugin.prototype as unknown as Record<string, (this: PadList) => void>;
  for (const method of ["stopListeners", "disconnectAll"]) {
    const original = proto[method];
    proto[method] = function (this: PadList) {
      const all = this.gamepads;
      this.gamepads = all.filter(Boolean);
      try {
        original.call(this);
      } finally {
        this.gamepads = all;
      }
    };
  }
}
patchSparseGamepads();

gatePhones(() => {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    backgroundColor: "#121018",
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    input: { gamepad: true, keyboard: true },
    audio: { disableWebAudio: false },
    // Overlays last so they draw on top.
    scene: [BootScene, TitleScene, CharacterSelectScene, SeriesSetupScene, TournamentScene, KingOfTheHillScene, StageSelectScene, ControlsScene, FightScene, RoundResultScene, MatchResultScene, PauseScene, SettingsScene, FighterStatsScene],
  });

  // Handy for debugging from the console.
  (window as unknown as { photoDojo: Phaser.Game }).photoDojo = game;
});
