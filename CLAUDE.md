# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Photo Dojo: Revival: a browser-only 2D fighting game. A phone (`/capture`, `capture.html`) photographs poses, builds a sprite fighter locally with MediaPipe, and sends it over WebRTC to a laptop (`/`, `index.html`) running a Phaser game (phones opening `/` get a "this is the big screen" page instead: `src/game/device-gate.ts`). `/about` (`about.html`) is a static About / privacy / FAQ / credits page. No accounts, no backend storage: fighters live in IndexedDB. The only server code is a Cloudflare Worker in `worker/` that relays SDP/ICE (and optionally issues TURN credentials) and stores nothing.

Design docs: `PLAN.md` (overall architecture and data model), `docs/fighting-mechanics.md` (frame data and the reasoning behind the fight rules — implemented), `docs/manual-test.md` (checks needing a real phone/gamepad/network). README.md has the player-facing controls and move list.

## Commands

```sh
npm install && npm install --prefix worker   # worker/ is a separate npm package
npm run worker:dev        # signaling Worker (wrangler dev) on :8787
npm run dev               # Vite on :5173; proxies /room/* and /turn-credentials to :8787
npm run dev:https         # self-signed HTTPS so phones on the LAN get camera access

npm test                  # Vitest unit tests (tests/**/*.test.ts, Node env)
npx vitest run tests/fight-simulation.test.ts       # single file
npx vitest run tests/collision.test.ts -t "facing"  # single test by name
npm run typecheck         # tsc for the app AND the worker
npm run build             # tsc --noEmit + vite build → dist/ (three entry points: game, capture, about)

npm run test:signaling    # needs worker:dev running
npm run test:e2e          # needs dev + worker:dev; headless Chrome, real WebRTC between two tabs
npm run test:e2e:gamepad  # needs dev; virtual gamepad
npm run generate:assets   # rebuild public/placeholders and public/sounds
node scripts/generate-og-image.mjs  # needs dev; public/og-image.png (link preview) from the title screen
uv run --with onnx --with onnxruntime --with numpy python scripts/build-matting-model.py  # models/ for dev (needed for capture)
```

E2E scripts use `playwright-core` with a local Chrome; set `CHROME_PATH` if Chrome isn't in `/Applications`. `test:e2e` accepts `-- <baseUrl> <screenshotDir>`.

CI (`.github/workflows/deploy.yml`) runs `typecheck`, `test`, `build` on every push, and on `main` deploys the Worker and the site (Cloudflare Pages). The site is built with `VITE_SIGNALING_URL=wss://…`.

## Architecture

```
src/shared/      fighter model, codec (chunks + .photodojo zip), IndexedDB storage,
                 pose definitions/geometry, frame data, room codes, stick-figure skeletons
src/simulation/  the fight — pure TS, NO Phaser imports, fixed-timestep, deterministic
src/capture/     phone pipeline: camera → MediaPipe pose → matcher/auto-capture →
                 segmentation/matting → sprite normalizer → IndexedDB; DOM UI + flow state machine
src/transfer/    signaling client, peer connection, chunked sender/receiver with backpressure
src/game/        Phaser scenes, input sources, rendering, host session (laptop side of transfer)
worker/          Worker + SignalingRoom Durable Object (≤2 sockets per room, rooms expire after 10 min)
```

Key boundaries that span files:

- **Simulation vs. rendering.** `FightSimulation.step([InputFrame, InputFrame])` (`src/simulation/fight-simulation.ts`) owns all game state. `FightScene` steps it at a fixed 60 Hz via an accumulator and only reads state to render — render code never mutates simulation state. Input sources (`src/game/input/`: keyboard, gamepad, training dummy) all produce `InputFrame`; the simulation never touches Phaser input. Keep it this way so rules stay unit-testable in Node.
- **Frame data and hitboxes come from landmarks.** `src/shared/frame-data.ts` defines each attack (startup/active/recovery, damage, hitstun/blockstun, hit level, which captured pose/variant to show) and derives hurtboxes, hitboxes and body boxes from each fighter's stored 33 MediaPipe landmarks — no hand-authored boxes. `src/simulation/collision.ts` transforms them to world space by position/facing. Changing fight rules generally means editing `frame-data.ts` / `fighter-state-machine.ts` and updating `tests/fight-simulation.test.ts` / `tests/collision.test.ts`.
- **Fighter data flow.** A `Fighter` (`src/shared/fighter-model.ts`) is pose PNG blobs + landmarks + anchor + sounds. `fighter-codec.ts` serializes it both as data-channel chunks and as a `.photodojo` zip (fflate) for export/import. Phone: `capture/game-link.ts` opens the link early and `transfer/fighter-sender.ts` sends; laptop: `game/host-session.ts` generates a room code, shows a QR, and `transfer/fighter-receiver.ts` stores into IndexedDB.
- **Signaling is same-origin in dev.** Pages connect to `/room/<code>` on their own origin; Vite proxies to the Worker so a phone only trusts one certificate. In production `VITE_SIGNALING_URL` points at the Worker.
- **Background removal** is deliberately simple: one strong model and almost no post-processing. `background-remover.ts` runs ISNet (1024², via onnxruntime-web: WebGPU, falling back to WASM) on a crop around the skeleton; `matting.ts` keeps only regions connected to the skeleton. Don't add heuristic stages (mask fusion, hole filling, edge filters, empty-room photos): an earlier pipeline full of them ended up worse than the model alone. If cut-outs are bad, look at a better model first. The model file is built by `scripts/build-matting-model.py` (rembg's ISNet with MaxPool `ceil_mode` turned off, which WebGPU lacks; bit-identical output) into git-ignored `models/`, which the dev server serves at `/models/`. It's too big for Pages (25 MiB per file), so production builds set `VITE_MATTING_MODEL_URL`. ORT's ~28 MB WASM binary is likewise loaded from jsDelivr, not bundled (`onnxruntime-web-use-extern-wasm` condition in `vite.config.ts`; `ORT_VERSION` must match package.json). BiRefNet was tried and doesn't run in ORT Web without heavy graph surgery. `/capture?debug=1` exports the frame, model alpha and final alpha. Quality beats speed here: the heavy pose model is used everywhere and each capture takes the sharpest frame of a burst (`sharpness.ts`). Models are downloaded with progress and stored in the Cache API (`vision-runtime.ts`). Model URLs can be overridden with `VITE_POSE_MODEL_URL`, `VITE_MATTING_MODEL_URL`.
- **Pose tweening is rendering only.** A `{ fromPoseId, toPoseId, frames }` sequence entry in `frame-data.ts` plays as `fromPoseId` in the simulation (boxes unchanged), and `SOFT_CUTS` lists cuts between actions that morph; `tweenOf` and `PoseTransitions` tell the renderer to ARAP-warp both captures onto an interpolated skeleton and cross-dissolve them, with moving limbs cut into their own mesh piece (`src/game/render/arap.ts`, `pose-tweener.ts`, `pose-transitions.ts`: pure and Node-tested; Phaser `Mesh` glue in `fighter-sprite-view.ts`, WebGL only). Idle sways into the optional `idle-2` capture (or a warped stand-in). PLAN §9 has the details and limits. Hit weight (struck pose held through hitstop, shake, colour-coded sparks at the hit event's `at`) is likewise render-only: `hit-feel.ts` / `hit-markers.ts`.
- **Stages are scenery only.** `src/game/stages/`: each stage is a `StageDefinition` (id, name, optional `preload`, `build` drawing into a container in screen space) in its own file, listed in `STAGES` (`stages.ts`); assets go in `public/stages/<id>/`. A stage's optional `music` (looping; list an Ogg and an MP3 fallback) is loaded and played through `stage-music.ts` (fights, and as a preview on stage select) at the player's Music volume, with an optional `credit` shown on stage select (also credit tracks on the About page). Lunar Dojo uses "Space-Time" by TomboFry. The menus (title, fighter select) share one unbroken track, "Get A Move On" by TomboFry (`src/game/menu-music.ts`). Music is licensed and NOT in the repo: tracks are named by file and resolved by `music-url.ts` against `VITE_MUSIC_BASE_URL` (an R2 bucket in production), defaulting to git-ignored `public/music/` in dev; missing files mean silence: menu scenes call `playMenuMusic`, the scenes that take over (stage select, controls, fight) `stopMenuMusic`. The floor, walls and stage width are fixed (`render/stage.ts`, the simulation), so stages can't change the rules. The chosen id rides in `FightSceneData.stageId`; with more than one stage, `startMatch` routes fighter select through `StageSelectScene` (with a Random option), otherwise straight on. The title demo picks a random stage.
- **Match stats** come from the simulation's events: `MatchStatsTracker` (`src/simulation/match-stats.ts`, pure and Node-tested) is fed every stepped state by `FightScene` (not replays) and handed to `MatchResultScene` at `matchOver`. The FIRST BLOOD / N HIT COMBO / PERFECT callouts come the same way from `CalloutTracker` (`src/simulation/callouts.ts`, sharing `ComboCounter` with the stats). Between rounds it's `RoundResultScene`.
- **Round intro handshake.** Every fighter captures a `handshake` pose (last in the capture order). During the intro `FightSimulation` scripts both fighters (`introStep`, timeline `INTRO` in `round-rules.ts`): walk in from the start positions, pause, player 1 offers a hand, player 2 takes it, shake, walk back. `src/shared/handshake.ts` turns each arm about its shoulder so both hands meet at one height (`handshakeGrips`) and gives the reach the simulation uses to stand them so the hands overlap. The pumping hand is render-only: variants 1/2 of `handshake` are stand-ins (the capture warped onto a raised/lowered hand, `shakenGrip`) that `FighterSpriteView` tweens between.
- Stick-figure skeletons in `src/shared/stick-figure.ts` double as built-in placeholder fighters, capture ghosts, and synthetic landmarks for tests (see `tests/helpers.ts`).

## Conventions

- Tests run in Vitest's `node` environment by default; tests needing IndexedDB use `fake-indexeddb`, and `happy-dom` is available for DOM bits.
- `tsconfig.json` is strict with `noUnusedLocals`/`noUnusedParameters`; the worker has its own `tsconfig.json` and TypeScript version.
- Every captured pose keeps all 33 landmarks: ARAP tweening (PLAN §9) warps with them — don't drop them from the model or codec.
