# Character Studio: the laptop builds fighters, the phone is a camera

Status: implemented (phases 1–6). Supersedes PLAN.md §4 (capture pipeline on the phone) and §5 (phone → laptop fighter transfer). Where the code ended up differing from this plan, §10 says how and why; the rest of this document describes the code as built.

## 1. Why

Building a fighter on the phone needs the heavy pose model and ISNet (1024² background removal) in one browser tab. On iPhones that doesn't fit: Safari kills the tab at ~3.3 GB, and measured in Safari the capture page needs ~2.8–3.0 GB even with the fp16 matting model (two MediaPipe runtimes of ~257 MB WASM each, ~1.2 GB of GPU memory, ~1 GB of WebKit allocations). Laptops have the memory, a better GPU path and a big screen.

So the work moves:

- **The phone is a dumb camera.** It opens `/capture?room=CODE`, streams its rear camera to the laptop over WebRTC, and answers "send me a sharp full-resolution still" requests. No models, no fighter data, almost no memory.
- **The laptop runs the Character Studio** (`/studio`): live pose tracking on the incoming video, auto-capture, background removal, sprite normalization, sounds (laptop mic), preview, save. It can also edit fighters it built.
- **Any camera works.** The studio's camera is a `CameraSource`: a phone over WebRTC, or a camera the laptop itself has (built-in/USB webcam, or an iPhone via macOS Continuity Camera, which appears to `getUserMedia` as an ordinary webcam).

Rules: one phone streams to one studio at a time, and only while the studio is open. Photos still never touch a server (WebRTC is peer to peer; a TURN relay only forwards encrypted packets).

## 2. What changes for players

| Before | After |
|---|---|
| Character select shows a QR; the phone runs the whole capture and sends a finished fighter | Character select has **Open the studio**; the studio shows the QR when you pick "Use a phone" |
| Phone screen shows the ghost, the HUD, the review, the sounds | The laptop shows all of it, big; the phone shows "Streaming to the studio", a small preview and the studio's status line |
| Sounds recorded on the phone mic | Recorded on the laptop mic |
| A phone can build a fighter without a laptop and export a `.photodojo` | Not any more: fighters are built on the computer running the game (`.photodojo` export/import stays, from fighter select) |
| A finished fighter can't be changed except its name | **Edit**: retake any pose, re-record sounds, rename (fighters built in the studio; others: rename, sounds, or capture everything again) |

## 3. Architecture

```
phone (/capture)                          laptop (/studio)
────────────────                          ─────────────────────────────────────────────
getUserMedia (rear, 1080p) ──video track──▶ RemoteCamera ─┐
          │  (camera switch: replaceTrack)                 ├─ CameraSource ─▶ StudioApp
local <video> (full res) ◀── "camera" data channel ──▶     │    (live pose tracking, matcher,
  grabSharpest(region, burst) ── PNG still chunks ──▶      │     ghost overlay, capture, ISNet,
                                                   LocalCamera   sprites, sounds, review,
                                             (webcam / Continuity)  preview, save, edit)
```

### 3.1 Code layout

- `src/capture/` keeps the **pipeline** modules, used by the studio: `pose-tracker`, `pose-matcher`, `pose-coaching`, `framing`, `ghost-overlay`, `matting`, `background-remover`, `vision-runtime`, `sprite-normalizer`, `cutout-quality`, `sharpness`, `sound-recorder`, `voice-prompts`, `hold-sound`, `camera-session`. The phone capture app (`main.ts`, `capture-flow.ts`, `game-link.ts`, `ui/`) is retired in phase 4.
- `src/shared/canvas.ts` (new): `createCanvas`, `context2d`, `Rect`, moved out of `sprite-normalizer.ts`/`matting.ts` (re-exported there so callers don't churn), so the phone page can use `camera-session.ts` + `sharpness.ts` without pulling in matting or sprite code.
- `src/studio/` (new): the laptop app.
  - `main.ts`: `StudioApp`. Its capture/matting/sprite/draft logic is **copied** from `CaptureApp` in phase 3 (the old app keeps running until phase 4 removes it).
  - `studio-flow.ts`: pure flow reducer (§5), Node-tested.
  - `capture-draft.ts`: moved here from `src/capture/` in phase 3 (with `CaptureMode`), `DRAFT_VERSION` 3; the old phone app imports it from here until phase 4.
  - `camera-source.ts` (interface), `local-camera.ts`, `remote-camera.ts`.
  - `phone-host.ts`: the studio's room and its one phone (§4.1).
  - `edit-session.ts` (phase 5): a saved fighter (+ sources) into a session.
  - `ui/screens.ts`, `ui/studio.css`: landscape, big-screen layout (live view + a side panel with the 16-pose strip).
- `src/phone/` (new): the phone camera page (`main.ts`, `ui.ts`, `phone.css`, and `phone-session.ts`: the pure protocol side, with the camera injected, Node-tested). During phases 2–3 it's served by a temporary entry `camera.html` (`/camera`); phase 4 points `capture.html` at it and deletes `camera.html`, in the same step that removes the game's `HostSession`, so the game's QR never points at a page that can't talk to it.
- `src/transfer/`:
  - `camera-protocol.ts` (new, pure): message types + validation, still framing (header + binary chunks), `StillAssembler`, `CAMERA_PROTOCOL` version, channel label `CAMERA_CHANNEL_LABEL = "camera"`.
  - `still-sender.ts` / `still-receiver.ts` (new): chunked send with `bufferedAmountLowThreshold` backpressure (same approach as `fighter-sender.ts`) and reassembly.
  - `peer-connection.ts`: `connectAsGuest(signaling, peerPresent, iceServers, { label, stream })` adds the stream's video track before the phone's offer (the phone always offers, so the studio needs no recvonly transceiver) and returns the `RTCRtpSender` with the link; `acceptAsHost(signaling, onLink, iceServers, { label })` sets `conn.ontrack` **before** `setRemoteDescription` (that's when `ontrack` fires, before `ondatachannel`), keeps the remote stream per connection and passes it with the link. The label is a parameter; the `"fighter"` default and constant go in phase 4.
- `tests/helpers.ts` gets the fake data channel (moved out of `tests/transfer.test.ts`) for the still sender/receiver tests.
- `studio.html` and `camera.html`: entries in `vite.config.ts` `build.rollupOptions.input` and in the `prettyUrls` pattern (`/studio`, `/camera` like `/capture`). `studio.html` runs the device gate (§7).

### 3.2 `CameraSource`

```ts
type CameraStatus = { kind: "starting" } | { kind: "ready" } | { kind: "lost"; reason: string } | { kind: "stopped" };

interface CameraSource {
  readonly kind: "local" | "phone";
  /** The live picture, playing (local: getUserMedia; phone: the received track). */
  readonly video: HTMLVideoElement;
  readonly width: number;   // live video size
  readonly height: number;
  /** Shown mirrored (front cameras); captures are never mirrored. */
  readonly mirrored: boolean;
  onFrame(cb: (nowMs: number) => void): () => void;
  /**
   * The sharpest of `burst` frames at the camera's full resolution. `region` is
   * the person, normalized 0..1 to the live frame (the still may be larger).
   */
  grabStill(region: NormalizedRect | null, burst: number): Promise<{ frame: HTMLCanvasElement | OffscreenCanvas; sharpness: number[] }>;
  canSwitch(): Promise<boolean>;
  switchCamera(): Promise<void>;
  /** Called immediately with the current status. */
  onStatus(cb: (s: CameraStatus) => void): () => void;
  stop(): void;
}
```

- `LocalCamera` = today's `CameraSession` (rear-preferred `getUserMedia`, 1080p ideal, `grabSharpest`), plus `listCameras()` / `useCamera(deviceId)` for a picker (laptops often have several: built-in, USB, Continuity Camera). `CameraSession.grabSharpest` takes a normalized region (converted to pixels inside). `CameraSession` also gets a `track` getter and an `onStreamChange` hook (the phone needs both for `replaceTrack`).
- `RemoteCamera` plays the received track in its own `<video>`; `grabStill` sends a `still-request` and resolves with the decoded PNG; `mirrored`/`canSwitch` come from the phone's `camera-info`.
- Live pose detection always runs on `video`. The still is re-detected in IMAGE mode as today, on the full-resolution frame. **There's no fallback to the live landmarks** when the still has nobody in it (local or remote): the still and the live frame are from different moments, so it fails and the pose is retried. The attack limb also comes from the still's landmarks.

## 4. The phone link

### 4.1 Connection, one phone, reconnects

The Worker's room holds one host and one guest; a second guest replaces the first one's socket, and a room is destroyed when both sockets close or after 10 minutes. So the rule is enforced by the studio, not the Worker:

1. Choosing "Use a phone" starts a `PhoneHost` with **one room code for the whole studio visit** (shown as QR for `/capture?room=CODE` + text; the studio renders the QR with the `qrcode` package itself, the URL helper `captureUrl(code)` moves to `src/shared/room-code.ts` for both game and studio).
2. The phone opens its camera (rear, `{ width: { ideal: 1920 }, height: { ideal: 1080 } }`), connects as guest with the video track and a `camera` data channel, sends `hello` then `camera-info`.
3. While waiting, `acceptAsHost` answers offers; if two phones scan before one connects, the last offer wins (existing behaviour). When a phone's channel opens, the studio **stops listening and closes its signaling socket** for as long as that phone is connected, so nobody else can join.
4. The phone is lost (channel closes, `connectionState` `disconnected`/`failed`, remote track `ended`/`mute` for >3 s, or no `ping` answered for 6 s; both sides ping every 2 s): `RemoteCamera` goes `lost`, the studio pauses on a "Phone disconnected" screen and **reopens the same room code**. Rooms that expire while waiting are reopened under the same code too.
5. The phone, on any drop, shows "Reconnecting to the studio…" and keeps retrying the same code (each attempt is `connectAsGuest`'s 20 s wait; back off to every 5 s). So a dropped phone comes back without rescanning, and a second phone simply waits until the first one leaves. The phone also handles `visibilitychange` (screen locked → camera paused → on resume: restart the camera if its track ended, `replaceTrack`, send `camera-info`).
6. Leaving the studio sends `bye` and closes everything; the phone then shows "The studio closed" (no retrying after a `bye`).

### 4.2 Video and stills

- Sender: `track.contentHint = "detail"`; after negotiation, try `sender.setParameters` with `degradationPreference: "maintain-resolution"` and `maxBitrate` 6 Mbps (in try/catch: Safari may not honour it). Live tracking only needs ~720p.
- **Camera switch never renegotiates** (signaling is closed by then): the phone reopens the camera and calls `sender.replaceTrack(newTrack)`, then sends `camera-info`.
- **Stills never go through the video codec.** The phone grabs them from its own local `<video>` at the camera's resolution (`grabSharpest`, judged in the studio's region) and sends a PNG over the data channel.
- Orientation: the phone sends the still's width/height; the studio checks its aspect ratio against the live video's (both portrait or both landscape) and fails the capture if they disagree (then the phone needs fixing; the manual test checks iOS Safari and Android Chrome).

### 4.3 Protocol (`camera` data channel, ordered + reliable)

JSON text frames, plus binary frames for still chunks (≤16 KB; each binary frame starts with a 4-byte request id and a 4-byte chunk index, so a chunk of a cancelled still can't be mistaken for the next one).

| Direction | Message | Meaning |
|---|---|---|
| phone → studio | `{ type: "hello", protocol: 1, device }` | first message; another `protocol` → studio replies `bye` ("reload the camera page") |
| phone → studio | `{ type: "camera-info", facing: "user" \| "environment" \| "unknown", width, height, canSwitch }` | after start, every switch, every resume |
| studio → phone | `{ type: "still-request", id, region: NormalizedRect \| null, burst }` | grab the sharpest of `burst` frames; a new request cancels a pending one |
| phone → studio | `{ type: "still", id, mime: "image/png", width, height, byteLength, sharpness: number[] }` + binary chunks totalling `byteLength` | the still |
| phone → studio | `{ type: "still-error", id, message }` | e.g. camera not running |
| studio → phone | `{ type: "switch-camera" }` | the studio's ⇄ button |
| studio → phone | `{ type: "status", text }` | shown on the phone ("Pose 4/16 — Punch", "Got it!") |
| either | `{ type: "ping", t }` / `{ type: "pong", t }` | liveness, every 2 s |
| either | `{ type: "bye", reason }` | clean close |

Unknown or malformed messages are ignored (logged). Studio-side timeout per still: 15 s → the capture fails like any other ("Didn't work… try again"). PNG at 1080p is ~2–4 MB: under a second on Wi-Fi, seconds over TURN. Quality beats speed; `mime` is in the header so JPEG q≥0.95 can be a fallback knob later.

## 5. Studio flow (`studio-flow.ts`)

Derived from `capture-flow.ts` (pure, Node-tested):

- **`setup` screen first**: mode ("On my own", default with a big screen: 3 s grace, bigger overlay; or "Someone's helping": short grace), camera choice ("Use a phone" → QR + code + "waiting for the phone…"; or a local camera from a device list), the resume-draft card, voice toggle. Models start downloading/building as soon as the studio opens, in parallel. `start` is enabled once the source is `ready`.
- **"How it works"** (`ui/intro.ts`) takes setup's place on the first visit (not when opening a fighter to edit; remembered in `localStorage`, shown again if storage is off), and setup's "How it works" replays it. Six short canvas scenes, drawn live rather than a video: become a fighter → pick a style → match the poses (the real `GhostOverlay`, coloured bones, arrow and hold ring, on a stick figure) → the cut-out → battle cries → a fight with the placeholder sprites. Auto-advances (not with reduced motion); Skip / Back / Next / dots. The app keeps the one element across renders so redraws don't restart it.
- `archetype` (picked first, so the poses then run without a break; a resumed draft without one asks here too) → `tips` → `loading` (models; usually done already) → poses 1..16 (pose → captured; a photo out of the pose or a rough cut-out is the pose again, never kept) → `review` → `sounds` → `preview` → `saving` → `saved` ("Back to the game" / "Build another").
- **`cameraLost`** on a live screen (`pose`, `captured`) or `archetype` → `cameraLost` screen (phone: QR again; local: "camera stopped — retry"); `cameraReady` → back to the same pose with its `retake` flag.
- **Retakes when no camera is ready** (review/preview after a lost phone, or an edit session that hasn't opened a camera yet): `retake` goes to a `camera` screen (the camera half of `setup`), then the pose, then back to `review`.
- **`startEdit`** (phase 5) from the initial state → `review` with the fighter's archetype and data.
- Removed vs `capture-flow`: `sending`, `sent`, `sendFailed`, room codes in the flow state, the `friend`/`solo` names (now `helped`/`solo`).

Voice prompts and the hold tone play on the laptop; `vibrate` goes. The `?debug=1` matting export stays (studio).

## 6. Fighter sources and editing

- New IndexedDB store **`fighterSources`** (keyed by `fighterId`; `DB_VERSION` 3, created in `upgrade`): `{ version: 1, fighterId, captures: DraftCapture[], savedAt }`: the cut-out PNG + geometry of every pose, exactly what a draft holds, so sprites can be re-planned at one fighter-wide scale after a retake. Phase 3 owns the whole store lifecycle: written when the studio saves a fighter; deleted in the same transaction as the fighter (`deleteFighter`); deleted when a `.photodojo` import overwrites a fighter id (the sources would describe another version).
- `openFighterDb` gets `blocking: () => db.close()` (and the game reloads/ reopens on next use) and a `blocked` handler that tells the user to close other Photo Dojo tabs, so a v2 game tab can't wedge the v3 upgrade.
- Phase 5, editing: `/studio?edit=<fighterId>` loads the fighter and its sources into a session (like resuming a draft) and opens the review. Saving overwrites the fighter under the same id (career records are keyed by id, so they stay), keeps `createdAt`, regenerates the thumbnail and sources.
- Fighters **without sources** (imported from a file): rename, redo sounds, or "Capture all poses again" (single retakes and style changes need the cut-outs). Built-in placeholders aren't in IndexedDB: no Edit button; `/studio?edit=` with an unknown id shows "That fighter isn't on this computer".
- `.photodojo` export stays as is (no sources).
- Drafts: one draft for a **new** fighter, on the laptop (`DRAFT_VERSION` 3; v2 drafts, e.g. on phones, are silently not offered, as `isResumable` already does). Edit sessions aren't drafted.

## 7. Game integration

- Character select: the "Add a fighter" panel loses the QR/room code/phone count; it gets **Open the studio** ("use a phone or this computer's camera") and keeps Import file. Hidden while a series (tournament / king of the hill) is running, since leaving the page ends it. The selected captured fighter's tile gets **Edit** in phase 5.
- Navigation is a page change: `/studio`; the studio's "Back to the game" goes to `/?to=select`, which `BootScene` honours by starting `CharacterSelectScene` instead of the title (menu music then starts at the first key press, as browsers require a gesture). The library reloads from IndexedDB at boot.
- Phase 4 removes `HostSession` (BootScene's `startHosting`, `REGISTRY.host`, TitleScene's and character select's use), `fighter-sender.ts`/`fighter-receiver.ts`, the data-channel chunk code in `fighter-codec.ts` (`chunkParts`, chunk headers, `FighterAssembler`, `TransferMessage`; the `.photodojo` zip code stays), the old phone app and its tests (`tests/transfer.test.ts` fighter parts, `tests/game-link.test.ts`, the flow parts of `tests/capture-flow.test.ts`; the draft tests move to `tests/capture-draft.test.ts` in phase 3).
- `device-gate.ts`: phones (and iPhones generally) opening `/` or `/studio` get "the studio runs on a computer; this phone can be its camera: scan the code the studio shows" (link to `/capture`); the "bring your fighter later as a file" line goes. iPads may open the studio (the iOS memory measures in `background-remover.ts`/`main` stay: matting built after the pose models, no warm-up, fp16), with a one-line warning that a computer works better.
- `/capture` without a room code: a code entry field ("enter the code the studio shows"); on a computer it also links to `/studio`.
- About page: the privacy text and FAQ (about.html lines ~40, 41, 76, 80, 88, 108 say processing happens on the phone).

## 8. Phases

Every phase ends with `npm run typecheck`, `npm test`, `npm run build` passing **and** the e2e smoke test (`npm run test:e2e`, with `npm run dev` + `npm run worker:dev` running) passing for everything that still exists, updated in the phase that changes it.

1. **Protocol and transport** (no UI): `src/shared/canvas.ts`; `camera-protocol.ts`, `still-sender.ts`, `still-receiver.ts`; label/stream/sender/remote-stream support in `peer-connection.ts` (existing callers unchanged); `CameraSession` normalized region, `track`, `onStreamChange`. Unit tests: message validation, framing/assembly incl. interleaved, cancelled and late chunks, backpressure over the fake channel (moved to `tests/helpers.ts`), `ontrack`-before-channel ordering with fakes.
2. **Phone camera page** at the temporary `/camera`: code entry / `?room=`, camera start, connect with track + `camera` channel, `hello`/`camera-info`, `still-request` → `grabSharpest` → PNG, `switch-camera` via `replaceTrack`, `status` line, ping/pong, Wake Lock, `visibilitychange`, reconnect loop on the same code, `bye`. The phone's message handling lives in a pure `phone-session.ts` (protocol state, still-request handling with an injected camera) so it's unit-tested against the studio side in Node; e2e here only checks that `/camera` loads and shows code entry (streaming is covered in phase 3 against the real studio).
3. **Studio** (`/studio`): `StudioApp` (copied from `CaptureApp`), `studio-flow.ts`, `capture-draft.ts` moved (v3), `CameraSource` + `LocalCamera` + `RemoteCamera`, `PhoneHost`, setup/camera/cameraLost screens, big-screen layout, laptop mic, save to IndexedDB, `fighterSources` store with its whole lifecycle and the DB `blocking`/`blocked` handlers, debug export. Unit tests: flow reducer, draft, `PhoneHost` (one phone, reopen same code, room expiry) with fake signaling, sources storage with `fake-indexeddb`. E2E: studio with Chrome's fake camera as local source (inject captures, save, fighter in the game's library on next boot); a `/camera?room=` tab streaming to a `/studio` tab (video arrives, a still request returns a PNG at the phone camera's size, disconnect → cameraLost → the phone reconnects on the same code).
4. **Game integration and retirement**: Open the studio, `/?to=select`, device gate, `capture.html` → phone page and `camera.html` removed, remove `HostSession`, the fighter data-channel transfer and the old phone app with the tests listed in §7; e2e: the fighter-transfer and phone-capture parts replaced (add test fighters with `saveFighter`/import instead of `sendFighter`; the studio/phone checks move to `/capture?room=`).
5. **Editing**: `/studio?edit=`, `edit-session.ts`, Edit button on fighter select, fighters without sources, unknown id. Tests with `fake-indexeddb`; e2e: edit a studio-built fighter (retake one pose via injected capture, rename, save; same id, records kept).
6. **Docs**: CLAUDE.md (architecture: studio, phone camera, background removal now laptop-side), PLAN.md §4/§5 → pointers here, README, `docs/manual-test.md` §1–2 rewritten (studio + phone camera incl. iOS/Android orientation and still resolution, Continuity Camera, reconnects, a second phone waiting), about page.

## 9. Risks and open questions

- **Phone stills at full resolution while sending video.** Expected fine (same camera, drawn locally), but iOS may lower the capture resolution while encoding. The studio logs each still's size; the manual test checks it.
- **Orientation** between the live track (rotation metadata) and stills (local canvas): checked by aspect ratio per capture (§4.2).
- **Laptops without WebGPU** run ISNet on WASM: ~6 s per pose on an M-series Mac, slower on older machines. The cut-out shows a spinner; the existing grace period plus the next pose's start buffer cover part of it.
- **Latency** of the live preview (~100–200 ms on Wi-Fi) delays the hold timer slightly; harmless for a 500 ms hold. The burst happens after the request reaches the phone, so the person must still be holding the pose: the hold tone ends with the ding only after the still arrived.
- **The photo is checked, not only the live video.** Hitboxes come from the still's landmarks, and the still is the sharpest frame of a burst (or the phone's later moment), so it's scored against the pose again (`checkStillPose`, the live tolerance × `STILL_TOLERANCE_SLACK` for re-detection jitter). Out of the pose: no matting, "Not quite. <correction>", and the pose again. The ding comes once the photo is in and passes. Then the cut-out has to pass `assessCutout` too, before anything is stored: a rough one says what to change (`cutoutAdvice`) and it's the pose again (a retake keeps the old photo until a new one passes). There is no "capture anyway" and no keeping a rough one: every photo in a fighter passed both checks. Live is stricter than the photo on every check they share, so a pose that goes green passes as a photo: the photo gets the angle slack above, live needs required landmarks `LIVE_VISIBILITY_MARGIN` surer than the photo does, and a stride `LIVE_STRIDE_MARGIN` longer; framing keeps the hands' and feet's own points off the sides, since the cut-out can't be checked live.
- **Framing before the photo.** `framingAdvice` says "further" (head or feet at or past the top/bottom, or too big) and "center" (a clearly seen point within `EDGE_MARGIN` torso lengths of a side: a lunge reaches further than standing), and "closer" (under `FRAMING_RANGE.min` of the frame: too few pixels for a sharp sprite and a clean cut-out); while it says anything but "ok" the matcher gets no landmarks, so no hold, no "Got it" for a photo that can't pass. The hold must also be steady (`STEADY_RADIUS`: a body point drifting further starts it over), so the photo at its end isn't blurred. When a photo does run into the border anyway, the cut-out check says which (`CutoutQuality.edges`) and the advice says which way to go (never "left"/"right": the preview may be mirrored).
- **Hidden limbs aren't held to the cut-out.** The holes and missing-extremity checks only use landmarks MediaPipe is confident about (`CLEARLY_SEEN`, 0.7): its guess for a limb behind the body (the rear arm in a shoulder charge) can land just off the silhouette. And the core it checks along each bone is thinner than any real limb (`CORE_SCALE` 0.12, ~0.04 torso lengths; a side-on forearm is ~0.08 half-wide), so MediaPipe's few pixels of joint error don't read as holes: at the old 0.25, about half of perfect cut-outs failed (simulated, ±0.04 torso joint error), which hardly mattered while rough ones could be kept.
- **The stance and the step are checked as a pair** (`compareStep`, `src/shared/walk-step.ts`): the walk is drawn from the two together (`walk-gait.ts`), so taking either one compares it with the other if it's in. Both are turned to face right (`detectFacing`: the toes and the nose, since a side-on fighter looking at the camera has the nose almost between the ears), centred on the hips and scaled to a torso (and a MediaPipe whole-body label swap is undone, `side-flips.ts`), then: the same foot in front (unless a photo's feet are too level to tell), and the step's feet at least `STRIDE_LIMITS.min` torso lengths further apart than the stance's, which is the stride the walk gets, so it never has to slip. Failing either is the pose again with what to change ("Other foot. Slide your front foot forward, don't step through." / "Bigger step."; retaking the stance: "Feet a bit closer together than in your step.").
- **Exposure and white balance are held** after a fighter's first photo (`CameraSource.lockExposure`: Image Capture `exposureMode`/`whiteBalanceMode` "manual" at the current values), so sixteen photos don't drift as the camera re-meters; released for a new fighter, re-locked at the next photo after a camera switch or restart. Only where the camera exposes those controls (many webcams in Chrome; not Safari, and not the phone yet); the console says which.
- **Cellular/TURN**: preview quality drops, stills take seconds. Same-Wi-Fi is the expected case.
- **No laptop, no fighter**: building on the go is gone, deliberately; `.photodojo` moves fighters between computers.

## 10. As built: deviations from the plan

Small, deliberate differences found while implementing, by phase.

**Transport (phase 1)**
- `connectAsGuest(signaling, peerPresent, iceServers, { label, stream?, timeoutMs? })` and `acceptAsHost(signaling, onLink, iceServers, { label })`: the options object replaced a bare `timeoutMs` parameter, and since phase 4 `label` (and `iceServers`) are required, with no `"fighter"` default.
- A still's binary frame is ≤16 KB in total: an 8-byte header (request id, chunk index) plus up to 16 376 bytes of payload. `StillRequestError` carries a reason, so the studio can tell a superseded request from a real failure.
- Request ids are unique per data channel (a `WeakMap` by channel, starting at 1 and wrapping within u32), not global.
- `src/shared/canvas.ts` also has `normalizeRect` / `denormalizeRect` (for `CameraSession`'s normalized region) and, since phase 2, `canvasToPng` (re-exported from `sprite-normalizer.ts`), so the phone page needs no sprite or matting code.

**Phone camera page (phase 2)**
- Any message from the studio counts as a sign of life, not only a `pong`: during a big still on a slow link the phone's own ping can sit behind still chunks in its send queue.
- The phone also sends `bye` on `pagehide`, so the studio sees a closed camera page at once.
- A second `switch-camera` arriving during a switch is dropped (logged), not queued; the `camera-info` after the running switch tells the studio which camera ended up live.
- A superseded `CameraSession.open()` throws an `AbortError` instead of returning, so `switchCamera()` can't go on to open another camera over the newer one.
- `src/phone/ui.ts` has its own copy of the tiny `h()` DOM helper.
- The phone page was on the temporary `/camera` through phase 3; phase 4 moved it to `/capture` and removed `camera.html`; the studio's QR has pointed at `/capture?room=` since.

**Studio (phase 3)**
- `captureUrl(code, { origin, base }, page = "capture")` takes its origin and base path as a parameter: the Worker shares `room-code.ts` and has neither `location` nor `import.meta.env`.
- The flow has events the plan didn't name: `setupDone` (setup → tips, only with a ready camera), `cameraReady` / `cameraLost` (tracked as `cameraReady` in the state), `cancelCamera` (camera screen → review) and `saveFailed` (saving → preview, with the reason shown) instead of an error screen.
- The camera source runs for the whole studio visit (a retake starts at once; a phone streams anyway). It stops when another source is picked or the page closes.
- Picking "This computer's camera" after a phone sends the phone `bye` and stops the `PhoneHost`; going back to the phone reuses the room code, but the phone page must be reloaded.
- Storage gained `saveFighterWithSources`, `loadFighterSources`, `saveImportedFighter` (fighter select's import: also drops stale sources) and `onDbBlocked`. `fighter-storage.ts` types the sources store loosely (`{ fighterId }`) so shared code doesn't depend on `src/studio`.
- `CameraSession.startDevice(deviceId)` backs `LocalCamera`'s camera picker. `device-gate.ts` gained `gateStudio()` and `isTablet()`.

**Game integration (phase 4)**
- `fighter.json` in a `.photodojo` file still carries `type: "manifest"` and a `chunkSize` (now a private constant), so files stay readable both ways between this version and older ones. Only the data-channel chunking was removed.
- `formatCountdown` (room-code expiry on fighter select) is gone with its only user.
- The "Add a fighter" panel also has its own "Import a fighter file" button (the toolbar's Import is unchanged). While a series is running the panel isn't drawn and `openStudio` refuses to leave the page (a safeguard: the series scenes normally clear the series before returning to fighter select).
- `BootScene` removes `to=select` from the address after honouring it, so a reload opens the title again.

**Editing (phase 5)**
- Fighters without usable sources (none, or sources missing a pose of the fighter's archetype: `usableSources`) can't change their archetype either, not only single retakes: a new signature pose would need re-planning at the fighter's scale. After "Capture all poses again" the session has sources and both work. That recapture keeps the archetype, clears the old sprites, and saves nothing if abandoned (edit sessions aren't drafted).
- The tile's Edit button is "✂ Edit", a second top-row button under ✎ Rename (the tile is too narrow for both on one row).
- A style change started from the review with no camera ready remembers the previous archetype on the `camera` screen (`previousArchetype`), so backing out restores it.
- Fighter thumbnails on fighter select are keyed with a module-level revision per fighter, so an edited or re-imported fighter's new images show without a reload (Phaser textures outlive the scene).
- Fixed on the way: sprites re-rendered only when the fighter-wide scale changed, so a retake at an unchanged scale kept the old sprite. The rendered-sprite map now records which capture each sprite came from.

**Docs (phase 6)**: CLAUDE.md, PLAN.md §4/§5 (now pointers here), the README, `docs/manual-test.md` §1–2 and the About page describe the studio and the phone camera.

### Still open
- Real-device only: the phone's `pageshow` reload, `sender.setParameters` tuning, the switch-then-reopen fallback, still resolution and orientation on iOS Safari / Android Chrome, Continuity Camera, reconnects and a second phone waiting (`docs/manual-test.md` §1–2).
- The tournament, series-setup and king-of-the-hill scenes key thumbnails as `thumb:${fighterId}` without the revision; a fighter edited or re-imported mid-session could show a stale thumbnail there.
- A grid redraw triggered by an async texture load leaves a tile unclickable for one Phaser frame (new interactive objects register on the next frame). Not noticeable by hand; the e2e test waits for the loader to go idle.
- Fighters saved in a studio tab show up in an already-open game tab only after it reloads (the studio's "Back to the game" does that).
