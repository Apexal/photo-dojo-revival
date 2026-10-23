/**
 * Text-to-speech stand-ins for the announcer lines (src/game/announcer-lines.ts):
 *   public/announcer/<id>.mp3
 * Only writes lines that have no file yet, so recorded takes dropped in over
 * them are kept. `--force` redoes them all; line ids as arguments redo just those.
 * Needs macOS (`say`) and ffmpeg. ANNOUNCER_VOICE picks the voice (`say -v '?'`).
 * Run: npm run generate:announcer [-- --force] [-- fight ko …]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANNOUNCER_LINES, ANNOUNCER_LINE_IDS, type AnnouncerLineId } from "../src/game/announcer-lines";

const OUT = join(import.meta.dirname, "..", "public", "announcer");
const VOICE = process.env.ANNOUNCER_VOICE ?? "Ralph";
/** Words per minute: a touch slower than `say`'s default, for weight. */
const RATE = "165";
/** Trim the silence `say` leaves at both ends, then even out the loudness. */
const FILTER = [
  "silenceremove=start_periods=1:start_threshold=-50dB",
  "areverse",
  "silenceremove=start_periods=1:start_threshold=-50dB",
  "areverse",
  "loudnorm=I=-14:TP=-1",
].join(",");

const args = process.argv.slice(2);
const force = args.includes("--force");
const named = args.filter((a) => !a.startsWith("--"));
for (const id of named) if (!(id in ANNOUNCER_LINES)) throw new Error(`No announcer line "${id}"`);
const ids = (named.length ? named : ANNOUNCER_LINE_IDS) as AnnouncerLineId[];

mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "announcer-"));
try {
  for (const id of ids) {
    const file = join(OUT, `${id}.mp3`);
    if (existsSync(file) && !force && !named.length) continue;
    const aiff = join(tmp, `${id}.aiff`);
    execFileSync("say", ["-v", VOICE, "-r", RATE, "-o", aiff, ANNOUNCER_LINES[id]]);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", aiff, "-af", FILTER, "-ar", "44100", "-ac", "1", "-b:a", "96k", file]);
    console.log("wrote", file);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
