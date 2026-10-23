import Phaser from "phaser";
import type { InputFrame } from "../../simulation/input-frame";
import type { RoundEndReason, RoundOutcome } from "../../simulation/round-rules";
import { createInputSource, isPlayerInput, type InputDescriptor } from "../input/input-descriptor";
import type { InputSource } from "../input/input-source";
import { GAME_HEIGHT, GAME_WIDTH } from "../render/stage";
import type { FightScene } from "./fight-scene";

export interface RoundResultData {
  kind: "round" | "match";
  roundNumber: number;
  roundWinner: RoundOutcome;
  matchWinner: RoundOutcome | null;
  reason: RoundEndReason;
  wins: [number, number];
  names: [string, string];
  inputs: [InputDescriptor, InputDescriptor];
}

const INPUT_DELAY_MS = 700;
const AUTO_CONTINUE_MS = 3500;

/** Round / match result over the paused fight: continue, rematch, or back to select. */
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

    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x121018, 0.72).setOrigin(0);
    const title =
      r.kind === "match"
        ? winnerName(r.matchWinner) ? `${winnerName(r.matchWinner)} WINS!` : "DRAW GAME"
        : winnerName(r.roundWinner) ? `${winnerName(r.roundWinner)} takes round ${r.roundNumber}` : `Round ${r.roundNumber}: draw`;
    this.add.text(GAME_WIDTH / 2, 230, title, {
      fontSize: r.kind === "match" ? "84px" : "56px", fontStyle: "bold", color: "#f2c14e", stroke: "#121018", strokeThickness: 8,
      align: "center", wordWrap: { width: GAME_WIDTH - 120 },
    }).setOrigin(0.5);
    this.add.text(GAME_WIDTH / 2, 330, `${r.reason === "ko" ? "K.O." : "Time"}  ·  ${r.names[0]} ${r.wins[0]} – ${r.wins[1]} ${r.names[1]}`, {
      fontSize: "28px", color: "#f3efe6",
    }).setOrigin(0.5);
    const help = r.kind === "match" ? "Punch: rematch     Kick: back to fighter select" : "Punch to continue";
    this.add.text(GAME_WIDTH / 2, 440, help, { fontSize: "30px", color: "#c9c3b8" }).setOrigin(0.5);
  }

  private get fight(): FightScene {
    return this.scene.get("fight") as FightScene;
  }

  update(): void {
    const ready = performance.now() - this.openedAt > INPUT_DELAY_MS;
    const now = this.sources.map((s) => s.read());
    const pressed = (k: keyof InputFrame) => ready && now.some((f, i) => f[k] && !this.previous[i][k]);
    this.previous = now;

    if (this.result.kind === "round") {
      if (pressed("punch") || pressed("kick") || performance.now() - this.openedAt > AUTO_CONTINUE_MS) {
        this.scene.stop();
        this.fight.nextRound();
      }
      return;
    }
    if (pressed("punch")) {
      this.scene.stop();
      this.fight.rematch();
    } else if (pressed("kick")) {
      this.fight.quitToSelect();
    }
  }
}
