# Photo Dojo Revival — Technical Plan

A browser-only 2D fighting game. Players pose for a handful of photos on a phone, the phone turns them into a sprite fighter locally, pushes it to a laptop over WebRTC, and two people fight with controllers. No accounts, no backend storage. All data lives in each browser's IndexedDB.

Decisions already made:

- Entirely browser-based. Static hosting on Cloudflare Pages. The only server code is a Cloudflare Worker for WebRTC signaling (and optionally TURN credentials). It stores nothing.
- Phaser 3 for rendering and input. Game logic lives in plain TypeScript modules with no Phaser imports so it is unit-testable.
- TypeScript + Vite + Vitest.
- Pose captures are shown as hard cuts (Photo Dojo style). Keypoints are stored per pose so ARAP tweening can be added later without a data migration.
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
photo-dojo/
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
      ghost-overlay.ts             # draws target silhouette + progress ring over the video
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
  | "jump" | "block" | "hurt" | "win";

export type SoundId = "attack" | "hurt" | "win";

export interface NormalizedLandmark { x: number; y: number; visibility: number } // pixel coords in the sprite canvas

export interface CapturedPose {
  poseId: PoseId;
  imageBlob: Blob;                       // PNG with alpha, SPRITE_CANVAS_SIZE x SPRITE_CANVAS_SIZE
  landmarks: NormalizedLandmark[];       // 33 MediaPipe landmarks, in sprite-canvas pixel space
  anchorPoint: { x: number; y: number }; // feet midpoint (or pelvis for jump), in sprite-canvas pixels
  capturedAt: number;
}

export interface Fighter {
  fighterId: string;                      // uuid
  name: string;
  schemaVersion: 1;
  createdAt: number;
  facingDirection: "right";               // all captures face right; renderer flips for P2
  poses: Record<PoseId, CapturedPose>;
  sounds: Record<SoundId, Blob | null>;   // webm/opus, ≤2 s each
  thumbnailBlob: Blob;                    // idle pose downscaled, for character select
}
```

Constants (in `fighter-model.ts`):

- `SPRITE_CANVAS_SIZE = 512`
- `CANONICAL_TORSO_LENGTH_PX = 110` (mid-shoulder to mid-hip; every pose is scaled so this is constant)
- `GROUND_LINE_Y = 480` (feet anchor is placed here for grounded poses)

### Storage

IndexedDB via the `idb` package. Database `photo-dojo`, version 1.

- Object store `fighters`, key `fighterId`, value is the `Fighter` object. Blobs are stored directly; IndexedDB handles them.
- Object store `settings`, key/value (last used controller mapping, debug flags).

On first write, call `navigator.storage.persist()` so the browser is less likely to evict the data. Show a one-line warning on the character select screen if it returns `false`.

Provide **Export** (one `.photodojo` file: a zip built with `fflate` containing `fighter.json` + PNGs + webms) and **Import** so fighters survive a cleared browser. This is also the fallback transfer path if WebRTC fails.

---

## 4. Capture pipeline (phone)

### 4.1 Session setup

- Page opens at `/capture?room=ABC123` from the laptop's QR code, or at `/capture` standalone (saves locally only, laptop webcam use case).
- Request `getUserMedia({ video: { facingMode: "environment", width: 1280, height: 720 } })`. Prefer the rear camera; it is better and the subject isn't the one holding the phone in friend mode.
- Two modes selectable on the first screen: **Friend holds the phone** (default) and **Solo, phone propped up**. Both use the same flow; solo mode adds a 3-second grace after each capture and bigger overlay text.
- One-screen tips: plain wall, full body in frame, face sideways to your right. Then get out of the way.

### 4.2 Pose detection

`@mediapipe/tasks-vision` `PoseLandmarker`, `pose_landmarker_lite` model, `runningMode: "VIDEO"`, GPU delegate with CPU fallback. Run on each `requestVideoFrameCallback` tick, throttled to ~15 Hz on slower phones.

### 4.3 Target poses

Defined in `pose-definitions.ts` as joint-angle targets, not silhouettes. Each pose specifies 3–5 angles with tolerances. Example:

```ts
{
  poseId: "punch",
  angleTargets: [
    { joint: "rightElbow", degrees: 175, tolerance: 25 },   // arm extended
    { joint: "rightShoulderElevation", degrees: 90, tolerance: 25 }, // arm forward at shoulder height
    { joint: "leftElbow", degrees: 60, tolerance: 40 },     // guard hand bent
  ],
  requiredVisibleLandmarks: ["rightWrist", "rightShoulder", "leftHip", "rightAnkle"],
  ghostSvgPath: "...",
  voicePrompt: "Punch. Arm straight out.",
}
```

Side-view capture means the camera sees mostly one side. Angles are computed from the 2D landmarks projected on the image plane; that is fine because the game is also side-view.

`pose-geometry.ts` exposes `computeJointAngles(landmarks)` and `scorePoseMatch(angles, target)` returning the worst normalized error (0 = perfect, 1 = at tolerance edge, >1 = out).

### 4.4 Auto-capture

`pose-matcher.ts` keeps a hold timer:

- Score ≤ 1.0 continuously for **500 ms** → capture.
- After 5 s without a match, tolerances widen by 1.5×.
- After 10 s, a "Tap to capture anyway" button appears.
- A pose can always be retaken from the review strip.

Progress ring fills during the hold. `speechSynthesis` says the prompt on entry, "hold it" when the hold starts, "got it" on capture. Short vibration on capture where supported.

### 4.5 Segmentation and normalization

On capture:

1. Grab the current video frame at full resolution to an offscreen canvas.
2. Run ISNet on a crop around the skeleton → alpha; keep only regions connected to the skeleton. (Originally the MediaPipe selfie segmenter; replaced because its 256² masks needed a pile of fix-up heuristics that made results worse.)
3. Run `PoseLandmarker` once more on the still frame for clean keypoints.
4. `sprite-normalizer.ts`:
   - Compute torso length = distance(mid-shoulder, mid-hip).
   - Scale factor = `CANONICAL_TORSO_LENGTH_PX / torsoLength`.
   - Anchor = midpoint of ankles for grounded poses; pelvis for `jump`.
   - Draw the masked figure into a 512×512 canvas, scaled, so the anchor lands at `(256, GROUND_LINE_Y)` (or at a fixed jump height for `jump`).
   - Transform landmarks into the same canvas space.
   - If the figure doesn't fit, scale down uniformly and record it; frame data uses landmarks, not canvas size, so this is safe.
   - Export PNG blob.
5. Show the cutout bouncing in the corner immediately.

All poses face right. The ghost overlay enforces this. If the detected shoulder order indicates the person faces left, flip the frame and landmarks horizontally before normalizing, and tell the user.

### 4.6 Pose order and count

Eight poses, in this order (easy ones first so the user learns the mechanic):

1. idle (fighting stance)
2. walk (one step, weight forward)
3. block (arms up, crouched slightly)
4. punch
5. kick
6. jump (arms up, knees bent — captured standing; the game moves it vertically)
7. hurt (head back, off balance)
8. win (anything, hands up)

### 4.7 Sounds

`MediaRecorder` with `audio/webm;codecs=opus`, 2-second cap, one tap to start, auto-stop. Three clips: attack, hurt, win. Normalize peak gain with Web Audio before storing. Skippable.

### 4.8 Finish

Preview screen plays a scripted showcase (idle → walk → punch → kick → win) with hard cuts and sounds. Name field. "Send to game" if a room code is present, "Save" otherwise. Both save to the phone's IndexedDB first.

---

## 5. Transfer (phone → laptop)

### 5.1 Signaling

Cloudflare Worker + one Durable Object class `SignalingRoom`, keyed by room code.

- Laptop: `GET /room/:code` upgraded to WebSocket, role `host`.
- Phone: same URL, role `guest`.
- The DO holds at most two sockets, relays any message from one to the other verbatim, and self-destructs after 10 minutes or when both sides close. It never parses or stores payloads.
- Room codes: 6 chars from an unambiguous alphabet (no 0/O/1/I), generated by the laptop.

### 5.2 Peer connection

- ICE servers: a STUN server at minimum. Same-Wi-Fi is the common case and works with STUN alone.
- Optional TURN for phone-on-cellular: a Worker route that mints short-lived Cloudflare TURN credentials. Add in M4 only if testing shows it is needed.
- Ordered, reliable `RTCDataChannel` named `fighter`.

### 5.3 Wire format

`fighter-codec.ts` produces:

1. One JSON manifest: `{ fighterId, name, schemaVersion, parts: [{ partId, kind: "pose"|"sound"|"thumbnail", poseId?, soundId?, byteLength, mimeType }], landmarks, anchors }`
2. Binary parts streamed in **16 KB** chunks with a 4-byte part index + 4-byte chunk index header. Sender honors `bufferedAmountLowThreshold` for backpressure.
3. A final `{ type: "done" }` message.

Receiver validates part sizes, rebuilds blobs, constructs the `Fighter`, saves to IndexedDB, and the character select grid updates live. Typical fighter is ~2–4 MB; on local Wi-Fi this is a second or two.

### 5.4 Failure path

If no data channel opens within 20 s, the phone offers "Download fighter file" and the laptop screen shows "Import file." Same codec, written to a `.photodojo` zip.

---

## 6. Game (laptop)

### 6.1 Scenes

- `BootScene`: opens IndexedDB, loads settings.
- `CharacterSelectScene`: grid of fighter thumbnails. Big "Add a fighter" tile shows a QR code (`qrcode` package) for `https://<host>/capture?room=XXXXXX` and opens the signaling socket. Each player picks with their own pad; "press any button" assigns pads to players by who pressed first.
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
- Hitstop 4f on every hit (both fighters freeze; this is what makes hard cuts feel good).
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
- On hard cuts for attacks, draw 2–3 procedural motion lines (Phaser `Graphics`) between the previous and current wrist/ankle landmark positions for the active frames. Cheap, sells the motion.
- Hitstop: skip rendering updates while `hitstopFrames > 0`; add a 2 px screen shake on kick hits.
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
- `pose-matcher.test.ts`: hold timer triggers at 500 ms of continuous match, resets on a miss, widens after 5 s.
- `sprite-normalizer.test.ts`: canonical torso length achieved; anchor lands on the ground line; left-facing input is flipped. Use `OffscreenCanvas` under `happy-dom` or test the pure transform math separately.
- `fighter-codec.test.ts`: round-trips a Fighter through chunks, including a 16 KB boundary and a missing part.
- `fight-simulation.test.ts`: scripted input sequences produce expected states (punch connects on frame 5, block takes 25 %, hitstop freezes both).
- `collision.test.ts`: hitbox/hurtbox overlap with facing flips.
- `round-rules.test.ts`: timer expiry, KO, best-of-3.

Capture page and WebRTC are tested manually with a checklist in `docs/manual-test.md` (two phones, two laptops, same Wi-Fi and cross-network).

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
Gamepads, friend/solo modes, voice prompts, tolerance widening, storage persistence warning, bundled fallback sounds, TURN if cross-network testing demands it, debug hitbox overlay.

**M5 — ARAP hook (later)**
See §9.

---

## 9. ARAP tweening hook (future)

Nothing in v1 depends on this, but the data model is ready for it:

- Every `CapturedPose` stores 33 landmarks in sprite-canvas space, which is exactly the control-point set an as-rigid-as-possible mesh warp needs.
- `frame-data.ts` entries are `{ poseId, frames }`; a future entry type `{ fromPoseId, toPoseId, frames }` would ask the renderer for interpolated frames.
- Implementation would live in `src/game/render/pose-tweener.ts`: triangulate the idle pose alpha mask once per fighter, bind triangles to nearest landmarks, interpolate landmark positions per frame, and warp on a WebGL mesh (Phaser's `Rope`/`Mesh` or a custom pipeline). Only short side-view-to-side-view tweens, which is where this technique works.

---

## 10. Risks and known limits

- **iOS Safari**: IndexedDB is evictable under storage pressure; `navigator.storage.persist()` helps but isn't a guarantee, hence export/import. WebGPU delegate for MediaPipe may be unavailable; the WASM CPU path is fast enough at 15 Hz on recent iPhones. Gamepad API works in Safari but button mapping can differ; use Phaser's standard-mapping detection and offer remap in settings later.
- **Cross-network WebRTC** needs TURN. Same Wi-Fi does not. Defer TURN until a real failure.
- **Full-body framing on a phone** needs the holder to stand 3–4 m back. The ghost overlay and "step back" prompt handle it; the 10 s manual-capture fallback covers the rest.
- **Baggy clothes, low light, busy backgrounds** degrade pose and segmentation. Accept rough edges; it's the aesthetic. Don't block on quality.
- **Right-side-only attacks**: punch and kick use the right limb. Left-handed users will punch with their left; the matcher should accept either arm meeting the angle target and record which, so hitboxes follow the correct wrist. Small addition to `pose-definitions.ts`.
- **Determinism**: simulation uses integer frame counts and fixed-point-friendly math (no `Date.now()` inside `step`). Not needed for local play, but it keeps the door open for replays.
- **No cloud backup** by design. Losing the browser profile loses fighters unless exported. Say so once in the UI.
