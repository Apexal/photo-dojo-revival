# Foto Fighter — Technical Plan

A browser-only 2D fighting game. Players pose for sixteen photos in front of a camera (a phone streaming to the computer, or the computer's own), the computer turns them into a sprite fighter locally, and two people fight with controllers. No accounts, no backend storage. All data lives in each browser's IndexedDB.

> **Note.** The capture pipeline was first built to run on the phone, which then sent finished fighters to the laptop. It now runs on the computer in the Character Studio, with the phone as a plain camera: see [docs/character-studio.md](docs/character-studio.md), which supersedes §4 and §5 below. §1–§2 still show the original layout; CLAUDE.md and the README have the current one.

Decisions already made:

- Entirely browser-based. Static hosting on Cloudflare Pages. The only server code is a Cloudflare Worker for WebRTC signaling (and optionally TURN credentials). It stores nothing.
- Phaser 3 for rendering and input. Game logic lives in plain TypeScript modules with no Phaser imports so it is unit-testable.
- TypeScript + Vite + Vitest.
- Pose captures are shown as hard cuts (Photo Dojo style). Keypoints are stored per pose, which is what ARAP tweening (§9, now implemented for attack wind-ups and retractions) needed.
- v1 gameplay: walk, jump, punch, kick, block, health bars, 60s round timer, best of 3 rounds, two gamepads. No specials, no throws, no CPU opponent.

---

## 1. Architecture

```
┌──────────────── phone browser ────────────────┐      ┌────────────── laptop browser ──────────────┐
│ /capture                                       │      │ /                                           │
│  camera → MediaPipe pose → auto-capture         │      │  Phaser game                                 │
│  → ISNet matting → normalized PNG + keys        │      │  character select ← IndexedDB (fighters)     │
│  → IndexedDB (fighters)                         │ WebRTC│  fight scene                                 │
│  → RTCDataChannel ───────────────────────────────┼──────┼→ receive fighter → IndexedDB                 │
└────────────────────────────────────────────────┘      └─────────────────────────────────────────────┘
                              ▲                                        ▲
                              └──────── signaling (WebSocket) ─────────┘
                                   Cloudflare Worker + Durable Object
                                   relays SDP/ICE for one room code, then closes
```

One Vite project, two HTML entry points (`index.html` for the game, `capture.html` for the phone), one shared `src/shared/` package for the fighter data model, codecs, and math. The Worker is a separate small package in the same repo.

Everything heavy (pose detection, segmentation, image normalization) runs on the device that took the photo. The laptop only ever receives finished sprites.

---

## 2. Repository layout

```
foto-fighter/
  package.json
  vite.config.ts
  index.html                       # game entry (laptop)
  capture.html                     # capture entry (phone)
  src/
    shared/
      fighter-model.ts             # Fighter, CapturedPose, PoseId, SoundId types
      fighter-codec.ts             # Fighter <-> transferable chunks (manifest + binary parts)
      fighter-storage.ts           # IndexedDB access (idb wrapper): saveFighter, loadFighter, listFighters, deleteFighter
      pose-definitions.ts          # the 8 target poses: joint-angle targets + tolerances + ghost SVG path
      pose-geometry.ts             # joint angles from landmarks, pose scoring, normalization transform
      frame-data.ts                # move definitions: pose sequence, durations, hitbox/hurtbox rules
      room-code.ts                 # generate/validate 6-char room codes
    capture/
      main.ts                      # capture page bootstrap
      camera-session.ts            # getUserMedia, video element, frame grab to canvas
      pose-tracker.ts              # MediaPipe PoseLandmarker wrapper (VIDEO mode)
      pose-matcher.ts              # live scoring against the current target, hold timer, auto-capture trigger
      background-remover.ts        # ISNet (onnxruntime-web) → alpha mask
      sprite-normalizer.ts         # crop, scale to canonical torso length, anchor feet, emit PNG blob
      sound-recorder.ts            # MediaRecorder for the 3 voice clips
      capture-flow.ts              # state machine: intro → pose 1..8 → sounds → preview → send
      ghost-overlay.ts             # draws target silhouette, live skeleton (bones coloured per joint) + progress ring
      pose-coaching.ts             # per-joint error → one spoken/written correction ("Raise your arm higher")
      voice-prompts.ts             # speechSynthesis cues ("punch... hold it... got it")
      ui/                          # minimal DOM screens, no framework
    transfer/
      signaling-client.ts          # WebSocket to the Worker, exchanges SDP/ICE
      peer-connection.ts           # RTCPeerConnection + RTCDataChannel setup, ICE config
      fighter-sender.ts            # chunks a Fighter and streams it with backpressure
      fighter-receiver.ts          # reassembles chunks, validates, saves to IndexedDB
    game/
      main.ts                      # Phaser bootstrap
      scenes/
        boot-scene.ts
        character-select-scene.ts  # lists fighters from IndexedDB, shows QR + room code for adding one
        fight-scene.ts             # renders FightSimulation state, plays sounds
        round-result-scene.ts
      input/
        gamepad-input-source.ts    # maps Phaser gamepad to InputFrame
        keyboard-input-source.ts   # WASD / arrows fallback
      render/
        fighter-sprite-view.ts     # loads pose PNG blobs into Phaser textures, flips for facing
        hitbox-debug-view.ts       # toggle with F1
    simulation/                    # NO Phaser imports anywhere in here
      fight-simulation.ts          # fixed-timestep step(inputs) → FightState
      fighter-state-machine.ts     # idle/walk/jump/attack/block/hurt/ko
      collision.ts                 # hitbox vs hurtbox resolution
      round-rules.ts               # timer, health, best-of-3
      input-frame.ts               # InputFrame type
  worker/
    package.json
    wrangler.toml
    src/
      index.ts                     # routes /room/:code to the Durable Object
      signaling-room.ts            # Durable Object: 2 WebSockets max, relays messages, 10-min TTL
  tests/
    pose-geometry.test.ts
    pose-matcher.test.ts
    sprite-normalizer.test.ts
    fighter-codec.test.ts
    fight-simulation.test.ts
    collision.test.ts
    round-rules.test.ts
```

---

## 3. Data model

```ts
// src/shared/fighter-model.ts

export type PoseId =
  | "idle" | "walk" | "punch" | "kick"
  | "jump" | "block" | "crouch" | "hurt" | "win"
  | "signature"                          // the archetype's signature move: a different pose per archetype
  | "handshake";

export type SoundId = "attack" | "hurt" | "win";

export interface NormalizedLandmark { x: number; y: number; visibility: number } // pixel coords in the sprite canvas

export interface CapturedPose {
  poseId: PoseId;
  imageBlob: Blob;                       // PNG with alpha, SPRITE_CANVAS_SIZE x SPRITE_CANVAS_SIZE
  landmarks: NormalizedLandmark[];       // 33 MediaPipe landmarks, in sprite-canvas pixel space
  anchorPoint: { x: number; y: number }; // feet midpoint (or pelvis for jump), in sprite-canvas pixels
  capturedAt: number;
  attackSide?: "left" | "right";         // which limb struck (punch/kick/signature/handshake)
}

export interface Fighter {
  fighterId: string;                      // uuid
  name: string;
  schemaVersion: 2;
  archetype: "brawler" | "grappler" | "guardian" | "acrobat"; // picks the signature move (src/shared/archetypes.ts)
  createdAt: number;
  facingDirection: "right";               // all captures face right; renderer flips for P2
  poses: Record<PoseId, CapturedPose>;
  poseVariants: Partial<Record<PoseId, CapturedPose[]>>; // second versions of idle, punch, kick, hurt, win
  sounds: Record<SoundId, Blob | null>;   // webm/opus, ≤2 s each (victory line ≤5 s)
  soundVariants?: Partial<Record<SoundId, Blob[]>>;      // extra takes
  thumbnailBlob: Blob;                    // idle pose downscaled, for character select
}
```

Every fighter has every pose and second version: sixteen captures. The archetype is picked at the start of capture, so the poses run in one go. Archetypes add one move each on down + punch + kick to a shared core moveset; frame data and the reasoning are in `docs/fighting-mechanics.md` §3.4.

Constants (in `fighter-model.ts`):

- `SPRITE_CANVAS_SIZE = 512`
- `CANONICAL_TORSO_LENGTH_PX = 110` (mid-shoulder to mid-hip; every pose is scaled so this is constant)
- `GROUND_LINE_Y = 480` (feet anchor is placed here for grounded poses)

### Storage

IndexedDB via the `idb` package. Database `photo-dojo`, version 3.

- Object store `fighters`, key `fighterId`, value is the `Fighter` object. Blobs are stored directly; IndexedDB handles them.
- Object store `settings`, key/value (last used controller mapping, debug flags).
- Object store `drafts`: the studio's unfinished capture, so a reload can resume it.
- Object store `fighterSources`, key `fighterId`: each studio-built fighter's cut-outs and geometry, for retakes when editing (docs/character-studio.md §6).

On first write, call `navigator.storage.persist()` so the browser is less likely to evict the data. Show a one-line warning on the character select screen if it returns `false`.

Provide **Export** (one `.fotofighter` file: a zip built with `fflate` containing `fighter.json` + PNGs + webms) and **Import** so fighters survive a cleared browser. This is also how fighters move between computers.

---

## 4. Capture pipeline (now in the studio)

Superseded by [docs/character-studio.md](docs/character-studio.md): the pipeline runs in the Character Studio (`/studio`, `src/studio/`) on the computer, with a `CameraSource` that is either a camera of the computer's own or a phone streaming over WebRTC (`/capture`, `src/phone/`). The pipeline modules themselves are still in `src/capture/`. What stays from the original plan:

- **Pose detection**: MediaPipe `PoseLandmarker` on the live video (the heavy model, ~15 Hz), and again in IMAGE mode on each full-resolution still (`pose-tracker.ts`).
- **Target poses** are joint-angle targets with tolerances, not silhouettes (`src/shared/pose-definitions.ts`; sixteen captures, `CAPTURE_TARGET_COUNT`, the signature pose depending on the archetype). `pose-geometry.ts` scores the live angles: 0 = perfect, 1 = at the tolerance edge, >1 = out. Either arm or leg may strike; the capture records which.
- **Auto-capture** (`pose-matcher.ts`): a match held steady for 500 ms captures (moving starts the hold over); tolerances never widen. There's no capture without the pose: the photo has to be in it and cut out cleanly to count (`docs/character-studio.md`). Any pose can be retaken from the review.
- **Segmentation and normalization**: ISNet on a crop around the skeleton, keeping only what's connected to it (`background-remover.ts`, `matting.ts`); then `sprite-normalizer.ts` scales every pose to `CANONICAL_TORSO_LENGTH_PX`, anchors the feet on `GROUND_LINE_Y` (pelvis for `jump`), flips left-facing captures so all face right, and exports the PNG.
- **Sounds**: three clips (attack, hurt, win) recorded with `MediaRecorder`, now on the computer's mic, peak-normalized, skippable.

---

## 5. Transfer (retired)

Finished fighters no longer travel between devices: the studio saves them into the IndexedDB the game reads, on the same computer. The phone ↔ studio link (signaling as below, then a video track plus a `camera` data channel for stills) is specified in [docs/character-studio.md](docs/character-studio.md) §4. `.fotofighter` export/import (§3) moves fighters between computers.

Signaling is unchanged: a Cloudflare Worker with one `SignalingRoom` Durable Object per room code relays SDP/ICE verbatim between at most two sockets (the studio as host, the phone as guest) and expires after 10 minutes or when both close. Room codes are 6 characters from an unambiguous alphabet. An optional Worker route mints short-lived Cloudflare TURN credentials for networks where a direct connection fails.

---

## 6. Game (laptop)

### 6.1 Scenes

- `BootScene`: opens IndexedDB, loads settings.
- `CharacterSelectScene`: grid of fighter thumbnails. The "Add a fighter" panel opens the Character Studio (`/studio`) or imports a `.fotofighter` file; a captured fighter's tile can open the studio on it (Edit). Each player picks with their own pad; "press any button" assigns pads to players by who pressed first.
- `FightScene`: owns a `FightSimulation`, steps it at a fixed 60 Hz using an accumulator on Phaser's `update(delta)`, and renders the latest state. Never mutates simulation state from render code.
- `RoundResultScene`: round / match result, rematch, back to select.

### 6.2 Simulation (pure TypeScript)

`FightSimulation.step(inputs: [InputFrame, InputFrame]): FightState`

```ts
interface InputFrame { left: boolean; right: boolean; up: boolean; down: boolean; punch: boolean; kick: boolean }

interface FighterState {
  position: { x: number; y: number };
  velocity: { x: number; y: number };
  facing: 1 | -1;
  health: number;
  action: "idle" | "walk" | "jump" | "block" | "punch" | "kick" | "hurt" | "ko" | "win";
  actionFrame: number;      // frames elapsed in current action
  hitstopFrames: number;
}
```

Rules in v1:

- Stage width 1280 logical px, floor at y = 0, gravity 0.6 px/frame², jump impulse −14.
- Walk speed 4 px/frame. Block = hold back while grounded (classic), also down for crouch-block. Blocking takes 25 % damage and no hitstun.
- Punch: startup 4f, active 3f, recovery 10f, damage 8, hitstun 12f, pushback 6 px.
- Kick: startup 7f, active 4f, recovery 16f, damage 12, hitstun 16f, pushback 10 px.
- Hitstop 6f on every hit, 8f on a throw (both fighters freeze; this is what makes hard cuts feel good). It's excluded from frame advantage, and buffered presses don't expire during it, so its length is feel only.
- Hurt lasts the hitstun; KO when health ≤ 0; round timer 60 s; best of 3.
- Fighters push each other apart if their body boxes overlap.

### 6.3 Frame data and hitboxes from keypoints

`frame-data.ts` maps each action to a pose sequence:

```ts
punch: [
  { poseId: "idle",  frames: 4,  phase: "startup" },
  { poseId: "punch", frames: 3,  phase: "active" },
  { poseId: "punch", frames: 4,  phase: "recovery" },
  { poseId: "idle",  frames: 6,  phase: "recovery" },
]
```

Boxes are derived from stored landmarks, so every fighter gets hitboxes that match their own body with no hand-authoring:

- **Hurtbox**: bounding box of all landmarks with visibility > 0.5, expanded 8 px.
- **Punch hitbox**: 48×48 px centered on the right wrist landmark of the `punch` pose, during active frames.
- **Kick hitbox**: 56×56 px centered on the right ankle landmark of the `kick` pose, during active frames.
- **Body box** (for push-apart): shoulders-to-ankles bbox of the current pose, narrowed to 60 % width.

`collision.ts` resolves hitboxes vs hurtboxes in sprite-canvas space transformed by position and facing. This is fully unit-tested with synthetic landmarks.

### 6.4 Rendering

- `fighter-sprite-view.ts` turns each pose `Blob` into an object URL and loads it with `this.load.image` in the scene's preload; 8 textures per fighter, no atlas.
- Sprite origin = `anchorPoint` so feet stay planted when poses swap.
- P2 (or whoever is on the right) gets `flipX = true`. Because all captures face right, flipping is correct and hitboxes mirror around the anchor.
- On hard cuts for attacks, draw 2–3 procedural motion lines (Phaser `Graphics`) between the previous and current wrist/ankle landmark positions for the active frames. Cheap, sells the motion. With smooth motion on (§9) the poses morph and the lines are left out; they come back when it's off or the browser has no WebGL.
- Hitstop: skip rendering updates while `hitstopFrames > 0`; add a 2 px screen shake on kick hits.
- Hit weight, Street Fighter II style (`src/game/render/hit-feel.ts`, rendering only): the struck fighter keeps the pose they were hit in for the first 4 of the 6 hitstop frames, shaking sideways (4 px on a hit, 2 px on a block), then snaps into the hurt pose. On a clean hit or a landed throw the attacker shakes too (2 px, out of step), so the impact goes through both; the freeze itself (both fighters hold still in the simulation) is unchanged. A parry shows a ringed flash in the parrier's colour. A marker shows where the hit landed (the hit event's `at`: the middle of the hitbox's overlap with the hurtbox it overlaps most), in the attacker's colour (P1 red, P2 blue, as on fighter select, with a pale centre) and with a symbol per kind: a spiky burst for a hit, a bigger burst in a ring for a KO, a ring with four ticks (a struck shield) for a block, double chevrons pointing the way the victim flies for a throw. It pops out, holds through the freeze and fades over 16 frames.
- Hit reactions show where the hit landed: a clean hit above `headHitLineY` (a quarter torso below the shoulders, since the contact point is the middle of the biggest overlap, usually with the torso box) shows the hands-on-face capture (hurt variant 1), anything lower the main hurt photo. KOs too; throws always show the main one. Decided in the simulation from the hit's `at`, so it's deterministic and replays the same; still cosmetic, since hurtboxes come from the main hurt pose. Win and taunt photos stay random.
- Knockdowns (`KNOCKDOWN` in `frame-data.ts`, `docs/fighting-mechanics.md` §2.4): throws, the bear hug, the shoulder charge (`knockdown: "always"`) and uppercut hits on airborne opponents (`knockdown: "air"`) knock down: `knockdown` → `downed` (40f) → `wakeup` (12f), untouchable and without a push box throughout; KO'd fighters fall the same way. Events `knockdown` and `landed` (dust, `thud` sound, a small shake). Drawn by rotating the hurt photo (`fallPose` in `hit-feel.ts`; the turn lays the photo's own feet-to-head line flat, and it's lifted so its lowest joint rests on the floor).
- Fight camera (`src/game/render/fight-camera.ts`, rendering only; Settings → Dynamic camera): frames both fighters, from the whole stage when they're 620 px apart or more to 1.22× when they're 240 px or closer, centred between them with the floor pinned to the bottom and never past the stage's edges. It zooms out as far as needed to keep both whole (170 px beside each, 540 px above the feet, so a jump with arms up fits), eases 10% of the way per frame, and punches in briefly on a clean hit, throw or KO. It snaps at each round start and when the KO replay begins. The HUD is drawn by a second, fixed camera: everything at depth ≥ 100 is HUD, the rest is world (the hitbox overlay moved from depth 1000 to 90 for this).
- Sounds: `attack` on active frame 1, `hurt` on hit, `win` on round end, played through Phaser's Web Audio sound manager from object URLs. Missing clips fall back to bundled generic sounds.

### 6.5 Input

- `gamepad-input-source.ts` reads `Phaser.Input.Gamepad`. Standard mapping: d-pad/left stick for direction, A/Cross = punch, B/Circle = kick, Start = pause.
- Pads only appear after a button press; the "press any button" screen is a real step.
- `keyboard-input-source.ts`: P1 WASD + J/K, P2 arrows + numpad 1/2. Needed for development and the no-controllers case.
- Both produce `InputFrame`; the simulation never touches Phaser input.

---

## 7. Testing

Vitest, Node environment, no DOM for simulation tests.

- `pose-geometry.test.ts`: angle computation on hand-built landmark sets; scoring returns 0 for exact, 1 at tolerance edge.
- `pose-matcher.test.ts`: hold timer triggers at 500 ms of continuous match, resets on a miss, starts over when they move.
- `sprite-normalizer.test.ts`: canonical torso length achieved; anchor lands on the ground line; left-facing input is flipped. Use `OffscreenCanvas` under `happy-dom` or test the pure transform math separately.
- `fighter-codec.test.ts`: round-trips a Fighter (and through a `.fotofighter` file); rejects missing poses, bad manifests and non-zip files.
- `fight-simulation.test.ts`: scripted input sequences produce expected states (punch connects on frame 5, block takes 25 %, hitstop freezes both).
- `collision.test.ts`: hitbox/hurtbox overlap with facing flips.
- `round-rules.test.ts`: timer expiry, KO, best-of-3.

The studio's flow, drafts, sources, the phone's protocol side and the camera link are unit-tested with fakes; `npm run test:e2e` drives the studio with Chrome's fake camera and a `/capture` tab streaming to it over real WebRTC. Real cameras, real phones and other networks are tested manually with the checklist in `docs/manual-test.md`.

---

## 8. Milestones

Each milestone ends with something runnable.

**M0 — Scaffold (½ day)**
Vite + TS + Vitest, two entry points, Phaser hello-world, Worker scaffold with `wrangler dev`, Cloudflare Pages deploy from `main`.

**M1 — Fight with placeholder fighters (2–3 days)**
Simulation, frame data, collision, round rules, all tested. FightScene renders two hand-drawn placeholder fighter folders (8 PNGs + fake landmarks each) loaded from `/public`. Keyboard input. Hitstop and motion lines. This is the game; it should already be fun with stick figures.

**M2 — Capture on the laptop webcam (2–3 days)**
Capture page working standalone: pose detection, ghost overlay, auto-capture, segmentation, normalization, sounds, IndexedDB save. Character select loads fighters from IndexedDB. No phone involved yet; use the laptop webcam to prove the pipeline.

**M3 — Phone and transfer (1–2 days)**
Durable Object signaling, WebRTC data channel, codec, QR flow. Test on iOS Safari and Android Chrome. Export/import fallback.

**M4 — Feel and robustness (2 days)**
Gamepads, friend/solo modes, voice prompts, storage persistence warning, bundled fallback sounds, TURN if cross-network testing demands it, debug hitbox overlay.

**M5 — ARAP tweening (done)**
See §9.

---

## 9. ARAP tweening

Implemented; no data migration was needed, since every `CapturedPose` already stored its 33 landmarks.

- **Frame data.** Sequence entries are `{ poseId, frames }` (hold) or `{ fromPoseId, toPoseId, frames }` (tween). A tween is rendering only: the simulation plays it as `fromPoseId`, so hurt/hit/body boxes and frame advantage are exactly what the hard cut gave. Punch, kick, low kick and throw tween idle → strike during startup and strike → idle on the first recovery entry; the uppercut only tweens its recovery (the crouch → pop-up cut is what reads as an anti-air); the jump kick tweens jump → kick during startup. `tweenOf(state)` (`fight-simulation.ts`) gives `{ from, to, t }` with the captured versions resolved like `frameOf`; t steps by 1/(frames + 1), so neither end repeats the neighbouring hard-cut frame.
- **Mesh** (`src/game/render/arap.ts`, pure TS). Each capture's alpha mask gets two triangles per 12 px grid cell holding opaque pixels (no dilation, so legs a few px apart stay separate). The texture's own alpha draws the outline.
- **Between actions.** `SOFT_CUTS` (`frame-data.ts`) lists pose pairs whose hard cut between actions morphs over 3–8 frames instead, eased out so the new pose reads almost at once: the walk cycle (a real stride), guard and crouch in and out, take-off and landing, the jump kick folding back, recovering from a hit, and taunt/win. Nothing morphs into `hurt` (impacts snap). The simulation only knows the current pose, so `PoseTransitions` (`src/game/render/pose-transitions.ts`) remembers what was on screen and times the morph by the simulation frame.
- **Walking** (`walk-gait.ts`). A planted shuffle from the stance and the step: the stance ↔ step morph is driven by distance walked, not time, so the planted foot stays still on the floor while the simulation slides the body past it. Forward, the front foot reaches out (back foot planted), then the back foot catches up (front foot planted); backward, the planted feet swap (no moonwalk). A stride is the fighter's own step (`STRIDE_LIMITS` 0.5–2.2 torsos; outside them the feet slip a little rather than patter or drag). Mid-step the body rises by about a pixel and the stepping foot skims just off the floor (`stepPose`, through `PoseTweener.layers`' skeleton adjust), easing to nothing at both photos. No cross-dissolve while walking (`layers(…, single)`): the nearer photo is drawn alone, swapping at mid-step, over the other photo's body as a backing for holes. A dissolve held this long showed both photos' legs at once, since two warps never line up exactly. Stopping into the stance eases back over 6 frames; anything else takes over at once. Positions and hurtboxes are untouched (`WALK_CYCLE` still collides). Without WebGL, or a step no wider than the stance, the walk cycle's soft cuts stand in.
- **Idle sway.** Standing still, a fighter sways between its stance and a second stance (`idle-2`, captured right after the stance: knees a little softer, breathing in) once every 100 frames (`idleSwayOf`), a cosine ease so it starts and ends at rest. Hurtboxes stay the main stance's. Every fighter has `idle-2` (the codec requires it).
- **Left/right flips.** MediaPipe sometimes swaps left and right on a side-on body. If shoulders *and* hips both fit the other capture much better swapped (`sidesFlipped`), one capture is relabelled for that pair. One arm fitting better swapped isn't a flip (a cross does that), so that case is left alone.
- **Moving limbs are cut loose.** An arm or leg whose elbow/wrist (knee/ankle) moves more than 0.35 torso lengths relative to its shoulder (hip), and that both captures can see, gets its own piece of mesh: triangles nearer its centre line than any other bone (within 0.3 / 0.45 torso lengths) and with their own vertex copies, so a forearm across the chest no longer drags the chest or the other fist along. It stays attached within 0.2 torso lengths of where the cut starts (30% down the upper arm / thigh), so it hinges instead of tearing off, and it's drawn over the body. Cut vertices are renumbered next to their originals so the solver's matrices stay banded (otherwise building is ~15× slower).
- **Handles.** 17 joints plus points ⅓ and ⅔ along each limb bone and torso side, kept when both captures' landmarks are ≥ 0.5 visible. Each binds only inside its own piece (a cut limb's handles to the limb, the rest to the body), barycentrically in the triangle it falls in, else to the nearest vertex within 3 cells, keeping its offset. Mesh pieces no handle reaches are dropped.
- **Skeleton interpolation** (`pose-tweener.ts`). The pelvis moves linearly; every other landmark is placed from its parent with the bone turning the short way round and its length interpolated, so a straightening arm doesn't shrink through the elbow.
- **Warp.** Igarashi et al. 2005 two-step ARAP (similarity step, then per-triangle rotation fit and edge-matching step), soft handles, both matrices factored once per capture-and-partner as banded Cholesky (row-by-row vertex numbering keeps them banded). Every pair a fighter can show is built at fight start: ≈ 100 ms per fighter in Chrome for a captured fighter; a solve is well under a millisecond.
- **Drawing** (`fighter-sprite-view.ts`). Both captures are warped onto the in-between skeleton and drawn as Phaser `Mesh`es (WebGL only; the canvas renderer keeps hard cuts): the arriving capture on top fading in at 2t, the leaving one under it fading out from halfway, so the body never goes see-through. Under both, the fainter capture's body (without its cut-loose limbs) is drawn solid: it fills the hole a moved limb leaves (a photo has nothing behind an arm). Settings → "Smooth motion" turns all of it off.
- **Limits.** Where two limbs overlap in a photo (a rear forearm across a lead forearm), the cut has to guess which pixels belong to which, so the edge of the moving limb can look ragged for a frame or two. Limbs that don't move between the two captures aren't cut, so they still bend with the body. Body-part segmentation models (BodyPix, human parsing) would give cleaner cuts but are large to run on a phone and don't fill what's hidden behind a limb; the backing layer does that from the other photo. Keep tweens short.

---

## 10. Risks and known limits

- **iOS Safari**: IndexedDB is evictable under storage pressure; `navigator.storage.persist()` helps but isn't a guarantee, hence export/import. WebGPU delegate for MediaPipe may be unavailable; the WASM CPU path is fast enough at 15 Hz on recent iPhones. Gamepad API works in Safari but button mapping can differ; use Phaser's standard-mapping detection and offer remap in settings later.
- **Cross-network WebRTC** needs TURN. Same Wi-Fi does not. Defer TURN until a real failure.
- **Full-body framing on a phone** needs the holder to stand 3–4 m back. The ghost overlay and "step back" prompt handle it.
- **Baggy clothes, low light, busy backgrounds** degrade pose and segmentation. A cut-out that fails the quality check isn't kept: the player is told what to change (`cutoutAdvice`) and poses again. Keep `QUALITY_THRESHOLDS` honest: too strict and nobody can finish.
- **Right-side-only attacks**: punch and kick use the right limb. Left-handed users will punch with their left; the matcher should accept either arm meeting the angle target and record which, so hitboxes follow the correct wrist. Small addition to `pose-definitions.ts`.
- **Determinism**: simulation uses integer frame counts and fixed-point-friendly math (no `Date.now()` inside `step`). Not needed for local play, but it keeps the door open for replays.
- **No cloud backup** by design. Losing the browser profile loses fighters unless exported. Say so once in the UI.
