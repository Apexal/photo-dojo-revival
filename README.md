# Photo Dojo: Revival

A browser-only 2D fighting game. Pick a fighting style and pose for sixteen photos on a phone, the phone turns them into a sprite fighter locally, sends it to a laptop over WebRTC, and two people fight with controllers or a shared keyboard. No accounts, no backend storage: fighters live in each browser's IndexedDB. See [PLAN.md](PLAN.md) for the design.

## Run it

```sh
npm install
npm install --prefix worker
npm run worker:dev      # signaling Worker (wrangler dev) on :8787
npm run dev             # Vite; open http://localhost:5173
```

The Vite dev server proxies `/room/*` and `/turn-credentials` to the Worker, so the pages talk to signaling on their own origin.

**Phones need HTTPS for the camera.** Use `npm run dev:https` (self-signed certificate), open the Network URL Vite prints on the laptop, and scan the QR code. The phone has to accept the certificate once.

Without a phone, open `/capture` on the laptop to capture with its webcam (it saves locally, then download the `.photodojo` file and use **Import fighter file**), or just pick the two built-in stick figures.

### Controls

The game opens on a title screen with a demo fight between fighters from your library; press any button to start (a controller's press joins it as P1).

| | Move | Punch | Kick | Pause |
|---|---|---|---|---|
| P1 keyboard | WASD | J | K | Esc |
| P2 keyboard | Arrows | `,` (or numpad 1) | `.` (or numpad 2) | Esc |
| Gamepad | D-pad / left stick | A / Cross | B / Circle | Start |

Keyboard keys can be remapped in **Settings** (Tab or a pad's Select button on fighter select, or from the pause menu).

- **Up** jumps after a 3-frame wind-up (holding back or down during it still blocks). You can jump over the opponent.
- Hold **back** to block standing, or hold **down** to crouch-block. Punches pass right over a crouch; kicks and uppercuts can be blocked either way. The **low kick** has to be blocked crouching, and the **jump kick** (kick in the air, once per jump) has to be blocked standing.
- The **kick** lunges forward, so it reaches further than a punch but is slower. Hold **back** while kicking to kick in place instead (shorter, keeps your distance).
- **Down + punch** is an uppercut: the anti-air. Jumping attacks can't hit you while it comes out, so it beats a jump-in timed right, but it's very punishable if blocked. **Down + kick** is a quick low kick.
- **Punch + kick** together throws when you're close (it beats blocking) and knocks them down, and taunts when you're far away. Press punch + kick while grabbed to break free.
- **Down + punch + kick** is your fighter's **signature move**, set by the fighting style picked during capture:
  - **Brawler: Shoulder Charge.** A slow lean, then a charge most of the way across the stage that knocks them down. Blocked, it's a free punish.
  - **Grappler: Bear Hug.** A grab that reaches almost three times as far as a throw and can't be broken. It loses to any attack, and a miss leaves you open.
  - **Guardian: Parry.** Catches any strike for a moment: no damage, and the attacker staggers long enough for a free hit. Throws go straight through it, and a mistimed one leaves you open.
  - **Acrobat: Flying Knee.** An overhead from the ground: it hits a crouching guard, so block it standing.
- **Knockdowns:** a throw, a bear hug, a shoulder charge, or an uppercut that catches someone in the air knocks them down. Nobody can touch them while they're down; get ready for when they stand up.
- A press up to 5 frames early still counts, and a block still works if you let go of back within the last 3 frames. Blocked hits can't KO.
- Players swap sides every round.
- Gamepads rumble when you get hit (heavier for kicks and throws, a light tick when blocking, a long one on a KO) and buzz once when they join. Turn it off in Settings (or press R in the pause menu). Rumble uses the browser's Gamepad haptics (Chrome/Edge dual-rumble, Firefox pulse), and pads without it just don't rumble.
- **Pause menu** (Esc / Start): Resume, Controls (each player's moves for their device), Settings, Restart round, Quit to fighter select. Any controller can drive it; kick, Esc or Start resumes.
- **Settings:** game volume (hits, blocks, the clock) voice volume (the fighters' clips) and announcer volume separately, screen shake on/off, dynamic camera on/off (zooms in when the fighters are close), rumble on/off, smooth motion on/off (moves, walking, guarding, jumps, hit recoveries and the idle sway morph between photos instead of cutting; with it off you get Photo Dojo hard cuts and motion streaks instead; visual only), and keyboard remapping for each keyboard half. Everything is remembered. Throws need punch + kick at once, and some keyboards can't register that while a direction is held, so remap to keys further apart if throws don't come out.
- If a gamepad disconnects mid-fight, the game pauses and says whose it was. Pressing any button on a pad (or keyboard half) the other player isn't using takes over.
- A health bar pulses when it's low, and the clock flashes and ticks in the last 10 seconds.
- F1 toggles the hitbox overlay.
- Before each match, a "How to fight" screen shows each player's controls with slow-motion previews of their fighter's moves.
- **Playing alone:** join with one controller, pick a fighter, and press punch again to choose your opponent: your controller moves a CPU cursor over the grid, and punch picks. Then choose **Match** (◀ ▶ sets the CPU to easy, normal or hard) or **Practice** with up / down, and punch to go; kick steps back. A match against the CPU is a full best-of-three with the clock, the K.O. replay and the stats page, but it doesn't count toward career records. If a second player joins meanwhile, they take the CPU's place.
- **Practice:** against the opponent you chose, you play an easy CPU with no clock and health that refills. Key 9 cycles the CPU easy → normal → hard; keys 1–8 (or Tab / Select) turn it into a scripted training dummy instead, including jumping in with a kick to practice anti-airs. F1 shows hitboxes. Harder levels react faster, block, anti-air and punish more often, and throw or jump in on a player who just crouch-blocks.
- **Tutorial:** join alone, pick a fighter, and press up instead of punch. A guided drill against the dummy, one move at a time, with your own buttons on screen: walk, jump, punch, kick, uppercut, low kick, block its punches, throw it, then your signature move. Attacks that fall short get a "too far" nudge. Then it carries on as practice. Fighters that have never fought are tagged NEW on fighter select, and picking one alone suggests the tutorial.
- **Party modes:** with both players joined on fighter select, press T (or Start on a joined pad, or click 🏆 Party modes). Pick the mode on the top row (◀ ▶), punch 3–8 fighters in, then Enter / Start begins. Each match is a normal best-of-three; a drawn match is played again; kicking twice between matches abandons the mode.
  - **Tournament:** a single-elimination bracket drawn in random order (byes go to the top seeds). P1 plays the top fighter of each match and P2 the bottom, so pass the controllers around.
  - **King of the Hill:** fighters line up in the order picked. The winner stays on, on the same side (so the same controller), and the next in line steps in; the loser goes to the back of the line. Beat every other fighter in a row to rule the hill.
- A knockout plays back in slow motion before the round result. Press any button to skip.
- Callouts: FIRST BLOOD for the round's first clean hit or throw, "N HIT STREAK" for clean hits in a row (it ends when the opponent hits or throws back, or blocks, parries or breaks a throw), and PERFECT for a round won without losing any health (practice only shows hit streaks).
- The match ends on a stats page: damage, clean hits, accuracy, longest hit streak, blocks, throws, knockdowns, perfect rounds, each player's favorite move, and how every round went. Punch for a rematch, kick for fighter select.
- Each fighter keeps a career record across matches (not practice): wins, losses and best hit streak show on fighter select, and the stats page shows both fighters' records. Once you've picked, press down (or click the record) for the fighter's full career page: every total, clean hits by move, their favorite move and their rivals. When the two players are on different fighters, their head-to-head (or "first meeting") shows between the panels. Records are saved in this browser with the rest of your settings; deleting a fighter deletes its record and everyone's rivalry with it.
- Fighter select works with a mouse or touch too. Click a tile to select it, then use the tile's Export or 🗑 button. Clicking a selected tile again picks it for a player who has joined. With more than 12 fighters the grid pages: move past the last row, or click ◀ ▶.

The frame data and the reasoning behind it are in [docs/fighting-mechanics.md](docs/fighting-mechanics.md).

## Test

```sh
npm test                 # Vitest unit tests (Node, no DOM)
npm run typecheck        # app + Worker
npm run test:signaling   # needs worker:dev running
npm run test:e2e         # needs dev + worker:dev; headless Chrome, real WebRTC between two tabs
npm run test:e2e:gamepad # needs dev; a virtual gamepad: joining, menus, practice, rumble
```

`test:e2e` takes an optional base URL and output directory for screenshots: `npm run test:e2e -- http://localhost:5173 e2e-out`. Set `CHROME_PATH` if Chrome isn't in `/Applications`.

Anything that needs a real person, phone, gamepad or another network is in [docs/manual-test.md](docs/manual-test.md).

## Deploy

- **Site**: static, `npm run build` → `dist/`, hosted on Cloudflare Pages (`/capture` and `/about` are served from `capture.html` and `about.html`).
- **Link previews**: set `VITE_SITE_URL` (e.g. `https://photo-dojo.pages.dev`, the repo variable `SITE_URL` in CI) so the Open Graph image URL is absolute. `public/og-image.png` is a shot of the title screen: regenerate it with `node scripts/generate-og-image.mjs` while `npm run dev` runs.
- **Signaling**: `worker/`, a Worker plus a `SignalingRoom` Durable Object. It relays SDP/ICE between at most two sockets per room code and stores nothing. Rooms expire after 10 minutes.
- Build the site with `VITE_SIGNALING_URL=wss://<your-worker>.workers.dev`.
- `.github/workflows/deploy.yml` tests every push and deploys both on `main`. It needs the repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and the repo variables `VITE_SIGNALING_URL` and optionally `PAGES_PROJECT` and `SITE_URL`.
- **TURN (optional)**: phones on cellular may need TURN. Create a Cloudflare Realtime TURN key, then run `wrangler secret put TURN_KEY_ID` and `wrangler secret put TURN_KEY_API_TOKEN` in `worker/`. Clients fetch short-lived credentials from `/turn-credentials` and fall back to STUN only when it isn't configured.

Background removal runs ISNet (a 1024×1024 background-removal model) on a crop around the person, with ONNX Runtime Web on WebGPU (falling back to WASM, which is much slower), and keeps only what's attached to the detected skeleton (`src/capture/background-remover.ts`, `src/capture/matting.ts`). `/capture?debug=1` adds an export of the model's output and the final alpha.

The MediaPipe WASM runtime is bundled (about 13.5 MB). The pose model loads from Google's model CDN (override with `VITE_POSE_MODEL_URL`), and ONNX Runtime's WASM (~28 MB) from jsDelivr. The ISNet model (~179 MB) is built locally with `uv run --with onnx --with onnxruntime --with numpy python scripts/build-matting-model.py` into `models/`, which the dev server serves; production builds point `VITE_MATTING_MODEL_URL` at a hosted copy. Capture favors quality over speed: it uses the heavy pose model (~31 MB) for live tracking and stills. The loading screen shows download progress, and the models are kept in the browser's Cache API (`photodojo-models-v1`), so they download once per device rather than every session.

Each capture takes the sharpest of a short burst of 1080p frames.

## Layout

- `src/shared/`: fighter model, codec (chunks + `.photodojo` zip), IndexedDB storage, pose definitions and geometry, frame data, room codes. Also canonical stick-figure skeletons, used for placeholders, ghosts and test landmarks.
- `src/simulation/`: the fight, in pure TypeScript with no Phaser imports. Fixed-timestep and deterministic.
- `src/capture/`: phone pipeline (camera, MediaPipe pose + segmentation, matcher, normalizer, sounds, flow state machine, DOM UI).
- `src/transfer/`: signaling client, peer connection, chunked sender/receiver with backpressure.
- `src/game/`: Phaser scenes, input sources, rendering. Stages (scenery and an optional looping soundtrack) are in `src/game/stages/`: add a `StageDefinition` file and list it in `STAGES`; with more than one, a stage select step appears after fighter select. There are two: Dusk Dojo and Lunar Dojo (music: "Space-Time" by TomboFry, credited on stage select and the About page). The menus play "Get A Move On" by TomboFry. The music is licensed, not MIT, so it isn't in the repo: for local dev drop the files into git-ignored `public/music/`; production builds load them from an R2 bucket via `VITE_MUSIC_BASE_URL`. Without them the game just plays silently.
- `worker/`: signaling Worker.
- `scripts/`: asset generator (`npm run generate:assets` rebuilds `public/placeholders` and `public/sounds`), announcer placeholders (`npm run generate:announcer`: text-to-speech stand-ins for any missing `public/announcer/*.mp3`), signaling and browser smoke tests.

## Known limits

- iOS may evict IndexedDB under storage pressure, so export fighters you care about. There is no cloud backup by design.

## License

[MIT](LICENSE). The pose model (MediaPipe) and the matting model (ISNet, via rembg) are downloaded at runtime or built locally and are not part of this repository; they are under their own licenses (Apache-2.0).

This is an unofficial fan project inspired by Nintendo's *Photo Dojo* (DSiWare). It is not affiliated with or endorsed by Nintendo and contains no Nintendo code or assets.
