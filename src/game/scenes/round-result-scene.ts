import Phaser from "phaser";
import type { InputFrame } from "../../simulation/input-frame";
import type { RoundEndReason, RoundOutcome } from "../../simulation/round-rules";
import { createInputSource, isPlayerInput, type InputDescriptor } from "../input/input-descriptor";
import type { InputSource } from "../input/input-source";
import { GAME_HEIGHT, GAME_WIDTH } from "../render/stage";
import type { FightScene } from "./fight-scene";
import { bodyText, COLOR, displayText, HEX } from "../render/theme";

export interface RoundResultData {
  roundNumber: number;
  roundWinner: RoundOutcome;
  reason: RoundEndReason;
  wins: [number, number];
  names: [string, string];
  inputs: [InputDescriptor, InputDescriptor];
}

const INPUT_DELAY_MS = 700;
const AUTO_CONTINUE_MS = 3500;

/** Round result over the paused fight: punch or kick continues, or it does by itself. (The match's end: match-result-scene.ts.) */
export class RoundResultScene extends Phaser.Scene {
  private result!: RoundResultData;
  private sources: InputSource[] = [];
  private previous: InputFrame[] = [];
  private openedAt = 0;

  constructor() {
    super("round-result");
  }

  init(data: RoundResultData): void {
    this.result = data;
  }

  create(): void {
    this.openedAt = performance.now();
    this.sources = this.result.inputs.filter(isPlayerInput).map((d) => createInputSource(this, d));
    this.previous = this.sources.map((s) => s.read());
    const r = this.result;
    const winnerName = (o: RoundOutcome | null) => (o === null || o === "draw" ? null : r.names[o]);

    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, HEX.ink, 0.75).setOrigin(0);
    const title = winnerName(r.roundWinner) ? `${winnerName(r.roundWinner)} takes round ${r.roundNumber}` : `Round ${r.roundNumber}: draw`;
    this.add.text(GAME_WIDTH / 2, 230, title, displayText(60, COLOR.accent, { align: "center", wordWrap: { width: GAME_WIDTH - 120 } })).setOrigin(0.5);
    this.add.text(GAME_WIDTH / 2, 330, `${r.reason === "ko" ? "K.O." : "Time"}  ·  ${r.names[0]} ${r.wins[0]} – ${r.wins[1]} ${r.names[1]}`, displayText(30, COLOR.fg)).setOrigin(0.5);
    const help = "Punch to continue";
    this.add.text(GAME_WIDTH / 2, 440, help, bodyText(28, COLOR.muted, 800, { stroke: COLOR.ink, strokeThickness: 5 })).setOrigin(0.5);
  }

  private get fight(): FightScene {
    return this.scene.get("fight") as FightScene;
  }

  update(): void {
    const ready = performance.now() - this.openedAt > INPUT_DELAY_MS;
    const now = this.sources.map((s) => s.read());
    const before = this.previous;
    this.previous = now;
    const pressed = (k: keyof InputFrame) => ready && now.some((f, i) => f[k] && !before[i][k]);

    if (pressed("punch") || pressed("kick") || performance.now() - this.openedAt > AUTO_CONTINUE_MS) {
      this.scene.stop();
      this.fight.nextRound();
    }
  }
}
