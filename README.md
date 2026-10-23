# Photo Dojo: Revival

A browser-only 2D fighting game. Pose for fifteen photos on a phone, the phone turns them into a sprite fighter locally, sends it to a laptop over WebRTC, and two people fight with controllers or a shared keyboard. No accounts, no backend storage: fighters live in each browser's IndexedDB. See [PLAN.md](PLAN.md) for the design.

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
- **Knockdowns:** a throw, or an uppercut that catches someone in the air, knocks them down. Nobody can touch them while they're down; get ready for when they stand up.
- A press up to 5 frames early still counts, and a block still works if you let go of back within the last 3 frames. Blocked hits can't KO.
- Players swap sides every round.
- Gamepads rumble when you get hit (heavier for kicks and throws, a light tick when blocking, a long one on a KO) and buzz once when they join. Turn it off in Settings (or press R in the pause menu). Rumble uses the browser's Gamepad haptics (Chrome/Edge dual-rumble, Firefox pulse), and pads without it just don't rumble.
- **Pause menu** (Esc / Start): Resume, Controls (each player's moves for their device), Settings, Restart round, Quit to fighter select. Any controller can drive it; kick, Esc or Start resumes.
- **Settings:** game volume (hits, blocks, the clock) and voice volume (the fighters' clips) separately, screen shake on/off, dynamic camera on/off (zooms in when the fighters are close), rumble on/off, smooth motion on/off (moves, walking, guarding, jumps, hit recoveries and the idle sway morph between photos instead of cutting; with it off you get Photo Dojo hard cuts and motion streaks instead; visual only), and keyboard remapping for each keyboard half. Everything is remembered. Throws need punch + kick at once, and some keyboards can't register that while a direction is held, so remap to keys further apart if throws don't come out.
- If a gamepad disconnects mid-fight, the game pauses and says whose it was. Pressing any button on a pad (or keyboard half) the other player isn't using takes over.
- A health bar pulses when it's low, and the clock flashes and ticks in the last 10 seconds.
- F1 toggles the hitbox overlay.
- Before each match, a "How to fight" screen shows each player's controls with slow-motion previews of their fighter's moves.
- **Practice:** join with one controller, pick a fighter, and press punch again. You play against an easy CPU with no clock and health that refills. Key 9 cycles the CPU easy → normal → hard; keys 1–8 (or Tab / Select) turn it into a scripted training dummy instead, including jumping in with a kick to practice anti-airs. F1 shows hitboxes. Harder levels react faster, block, anti-air and punish more often, and throw or jump in on a player who just crouch-blocks.
- A knockout plays back in slow motion before the round result. Press any button to skip.
- The match ends on a stats page: damage, clean hits, accuracy, longest combo, blocks, throws, knockdowns, perfect rounds, each player's favorite move, and how every round went. Punch for a rematch, kick for fighter select.
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
- `scripts/`: asset generator (`npm run generate:assets` rebuilds `public/placeholders` and `public/sounds`), signaling and browser smoke tests.

## Known limits

- iOS may evict IndexedDB under storage pressure, so export fighters you care about. There is no cloud backup by design.

## License

[MIT](LICENSE). The pose model (MediaPipe) and the matting model (ISNet, via rembg) are downloaded at runtime or built locally and are not part of this repository; they are under their own licenses (Apache-2.0).

This is an unofficial fan project inspired by Nintendo's *Photo Dojo* (DSiWare). It is not affiliated with or endorsed by Nintendo and contains no Nintendo code or assets.
