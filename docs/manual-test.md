# Manual test checklist

Automated coverage: `npm test` (simulation, collision, round rules, pose geometry/matching, sprite normalization math, codec, storage, transfer over a fake data channel), `npm run test:signaling` (the Worker), and `npm run test:e2e` (headless Chrome: real WebRTC transfer, capture UI → send, fight, export/import). What they can't cover: real people in front of real cameras, real phones, real gamepads, and other networks. That's this list.

## Setup

```sh
npm install && npm install --prefix worker
npm run worker:dev          # signaling Worker on :8787
npm run dev:https           # Vite with a self-signed cert, proxies /room to the Worker
```

Open the **Network** URL Vite prints (e.g. `https://192.168.1.20:5173/`) on the laptop. Phones must be on the same Wi-Fi and accept the self-signed certificate once. For the deployed build, use the Pages URL instead.

Devices: two phones (one iOS Safari, one Android Chrome), two laptops (Chrome + Safari or Firefox), two gamepads (one Xbox-style, one PlayStation-style).

## 1. Capture (phone, same Wi-Fi)

- [ ] Scan the QR on the laptop's character select. The capture page opens with the room code shown.
- [ ] Mode screen: "Friend holds the phone" is the default; "Solo" shows bigger text.
- [ ] First visit: "Warming up…" shows a progress bar through the ~60 MB model download, then a short "Starting the camera…" pause. Reload and start again: it's ready within a couple of seconds (models come from the Cache API). Check the download on mobile data too.
- [ ] Heavy pose model on the phone: the live skeleton still follows smoothly enough to pose (it detects at most 15×/s; note the real rate on an older phone).
- [ ] Rear camera is used (friend mode). Camera permission denied → clear error and "Start over".
- [ ] The ghost appears; the live skeleton tracks the person. Once someone is detected the ghost shrinks/grows to their height and stands where they stand (smoothly, no jitter); on the jump pose it stays on the floor.
- [ ] Framing hints: standing far away shows (and after a moment says) "Come a bit closer"; filling the frame or cutting off head/feet shows "A bit further back". Hints aren't repeated more than every ~5 s.
- [ ] Holding a matching pose for ~0.5 s captures it: ring fills, "hold it" / "got it" spoken, phone vibrates (Android), cutout bounces in the corner.
- [ ] Without looking at the screen: a rising, pulsing tone plays for the whole hold, stops the moment the pose breaks, and ends in a ding when the snapshot is taken. Check it's audible over the spoken "hold it" and not annoying.
- [ ] After ~5 s without a match, a close-enough pose now captures (tolerances widen).
- [ ] After ~10 s, "Tap to capture anyway" appears and works.
- [ ] Facing left instead of right still works: the cutout faces right and "Flipped so you face right" shows.
- [ ] Punching with the left arm is accepted; in game the punch hitbox follows the left wrist (F1).
- [ ] Solo mode: there's a ~3 s pause after each capture.
- [ ] Background removal: a dark outfit against a dark wall, furniture next to you, and a hand on the hip all come out clean; your shadow isn't cut out with you. The console logs `[matting] ISNet on webgpu` (or `wasm`, much slower) and each capture's matting time.
- [ ] Kicks and punches captured mid-motion look sharp (the sharpest of a short burst is used; `info.json` lists each frame's sharpness).
- [ ] Solo mode uses the same hold-to-capture as friend mode: the rising, pulsing tone tells you you're matching without looking at the screen.
- [ ] Buffer between poses: for ~1.5 s after a new pose starts, matching does nothing (the ghost stays white, no tone). If you're still frozen in the previous pose when that ends, it says "Relax for a second, then strike the pose" and only captures after you move out of and back into the pose. Two similar poses in a row (punch → uppercut, win → flex) can't be captured back to back by accident.
- [ ] Rough cut-out check: capture against a cluttered wall / with a hand out of frame / in dark clothes in a dim room. Friend mode stops on "That one came out rough — retake? (reason)" with Retake / Keep it; solo mode says "let's go again" and retakes once, then keeps the second try with a toast. A clean capture never triggers it (if it does, the `?debug=1` export's `info.json` has the `quality` numbers for tuning `QUALITY_THRESHOLDS` in `src/capture/cutout-quality.ts`).
- [ ] Camera switch: on a phone, "⇄ Camera" flips between rear and front; front is shown mirrored, captures are not. A laptop webcam is mirrored. With only one camera the button is hidden.
- [ ] All 13 poses are required (crouch block after block, uppercut after punch, low kick after kick, hit-in-the-face after hurt, flex after win). Review strip shows all 12; tapping one retakes it and returns to review. Sizes match across poses.
- [ ] Lock the phone or reload mid-capture: reopening offers "Pick up where you left off?" with the right count, and Resume continues at the next missing pose (or review). "Start fresh" discards it. A finished fighter clears the draft.
- [ ] With a game code, the "Connected to game" chip appears right after Start camera (before any poses). Stop the Worker/laptop: the chip turns red; tapping it retries. Leave the laptop on select > 10 min (room code refreshes): the phone stays connected and can still send.
- [ ] Send failure screen: entering the laptop's new code and "Try again" works.
- [ ] Sounds: record (auto-stops at 2 s), play back, remove a take, record up to 3 takes per sound, skip one, skip all. Quiet recordings come out louder (peak normalization).
- [ ] Level meter while recording: it moves with your voice, turns green past the tick mark; whispering shows "● Recording — louder!" after about half a second.
- [ ] Wait a second before shouting: playback (phone preview and in game) starts right at the shout, not after the pause. A soft first syllable isn't clipped.
- [ ] Preview plays the showcase with hard cuts and the recorded sounds. Name field works.
- [ ] "Send to game": progress, then "Sent!". The fighter appears in the laptop grid without a reload.
- [ ] Standalone (`/capture` without a code): the button says "Save"; "Download fighter file" produces a `.photodojo`.
- [ ] Spoken prompts toggle off → silence.
- [ ] Rough edges with a busy background / baggy clothes are acceptable; capture is never blocked on quality.
- [ ] Normal indoor lighting: no chunks of wall/furniture attached to the cutout, no missing limbs, dark clothing kept.
- [ ] Hands on hips (and the flex pose): the wall visible through the loop of the arm is transparent in the sprite, not filled in. A dark patch on a shirt is still filled.
- [ ] Sprites on the dark fight background have no light or wall-coloured fringe; hair and fingers look soft, not jagged. Compare friend mode with solo mode (room photo): solo should be noticeably cleaner at the edges.
- [ ] Thin forearms and wrists don't carry a strip of wall along them.
- [ ] If background removal looks bad, open `/capture?debug=1`, capture, and tap "Download matting debug (zip)" on the review screen. Each pose folder has the raw frame, the model's alpha, the final alpha (after keeping only what touches the skeleton) and the sprite, plus `info.json` with the backend and timing.

## 2. Transfer

- [ ] Same Wi-Fi: a 2–4 MB fighter arrives in a second or two.
- [ ] Phone on cellular, laptop on Wi-Fi: if it fails, after 20 s the phone shows "Couldn't reach the game" with "Download fighter file". If cross-network matters, configure TURN (see README) and retest — `/turn-credentials` should return ICE servers.
- [ ] Laptop's Import fighter file accepts the downloaded `.photodojo`.
- [ ] Sending while the laptop is mid-fight works; the fighter shows up in the grid afterwards.
- [ ] Leave the laptop on character select > 10 min: "code refreshes in m:ss" counts down under the code (gold in the last 30 s), then a new room code + QR appears (room expired and reopened) and the countdown restarts from 10:00.
- [ ] Refresh the laptop mid-transfer: the phone reports a failure instead of hanging; retry works.

## 3. Game (laptop)

- [ ] Character select lists captured fighters (newest first) and the two stick figures.
- [ ] "Press any button": first pad/keyboard half to press gets P1, the next gets P2. Pads only appear after a button press.
- [ ] Keyboard without a numpad: P1 = WASD + J (punch) / K (kick); P2 = arrows + `,` (punch) / `.` (kick). Numpad 1/2 also work if present.
- [ ] Gamepad (standard mapping): d-pad and left stick move, A/Cross punches, B/Circle kicks, Start pauses. Check on Safari too.
- [ ] Rumble (Xbox and PlayStation pads, Chrome + Firefox + Safari): a buzz on join; getting punched < kicked < thrown < KO'd; blocking is a light tick; landing a hit is a small kick-back. Settings → Controller rumble (or pause → R) turns it off, and it stays off after a reload. A single pad the browser reports as controller 2 still works and doesn't crash on scene changes.
- [ ] Punch to pick, kick to un-pick (or leave the slot).
- [ ] Mouse/touch: clicking a tile selects it (gold border) with Export and 🗑 on it; 🗑 asks "Delete? / Keep"; built-ins have no 🗑. A joined, not-ready player's cursor follows clicks; clicking the selected tile again picks it. "Export all fighters" downloads one file per captured fighter.
- [ ] Practice: one player joins, picks, presses punch again → practice vs. another fighter. 1–8 / Tab / pad Select change the dummy (incl. "jump in with a kick" to practice anti-airs); 9 cycles CPU easy/normal/hard, and hard is noticeably tougher than easy; hitboxes on; no timer; health refills; Esc → "Quit to fighter select" quits.
- [ ] KO: after the K.O. banner, a slow-motion replay with sounds plays; any button skips; timeouts don't replay.
- [ ] After both pick, the "How to fight" screen shows each player's controls for *their* device and side (P2 on the right: back is →; gamepads show Ⓐ/Ⓑ and the d-pad), with each move previewed using that player's own fighter, P2's facing left. Each player presses punch when ready; kick un-readies or goes back. Rematch skips this screen.
- [ ] Walk, jump (with and without direction), punch, kick, block by holding back against an attack, crouch-block with down.
- [ ] High/low: a low kick (down + kick) hits a standing blocker but not a crouching one; a jump kick (kick in the air) hits a crouching blocker but not a standing one. One air kick per jump; landing ends it.
- [ ] Jumping over the opponent works (cross-up); both turn around on landing; pushback goes away from the attacker.
- [ ] Round 2 starts with the players on swapped sides.
- [ ] Punch + kick from far away taunts (win pose + voice line) and leaves you open to a hit.
- [ ] Blocking at 1 health never ends the round. A just-released back still blocks; mashing right after a KO doesn't skip the replay.
- [ ] Down + punch = uppercut (knocks a jumping opponent out of the air); down + kick = low kick. Fighters without bonus captures still get both moves (main poses shown).
- [ ] Punch + kick together = throw: works against a blocker at close range, whiffs at range, loses to an opponent who's attacking. Pressing punch + kick while grabbed breaks it ("BREAK!").
- [ ] After landing a hit, attacking again first feels rewarded; after a blocked kick, the defender can punish with a punch.
- [ ] Pressing a button slightly before recovering (e.g. right after landing from a jump or getting hit) still comes out.
- [ ] Hits freeze both fighters briefly (hitstop); kicks shake the screen; motion streaks on attacks.
- [ ] Variety: with bonus moves captured, punches/kicks/hit reactions/wins switch between versions; hitboxes (F1) follow the version shown. Multiple voice takes rotate without the same take twice in a row.
- [ ] Sounds: battle cry on the attack's first active frame, ouch on hit, victory line at round end; fighters without clips use the bundled sounds.
- [ ] Holding down shows the fighter's crouch photo (holding back shows the standing block). A punch thrown at a crouching opponent passes over them: no hit, no block spark. Kicks and uppercuts are blocked crouching; a jump kick timed to come down late hits a crouching opponent.
- [ ] F1 shows hurtboxes (green: head, torso and a pair of boxes per limb bone, hugging the body), body boxes (blue), and active hitboxes (red: fist to shoulder for punches); the setting survives a reload. A punch thrown at point-blank range still hits; a kick passing through the empty space under an opponent's extended arm doesn't.
- [ ] Health bars drain toward the center; the 60 s timer counts down; timeout gives the round to the healthier fighter.
- [ ] Best of 3: round result screen between rounds; match result offers rematch (punch) or back to select (kick).
- [ ] Esc/Start opens the pause menu (sounds pause). ▲▼ + punch, Enter, or the mouse choose; kick / Esc / Start resume, and the button that resumed doesn't also punch. Controls shows both players' keys for their device and side. Restart round resets health, positions and clock (and undoes a KO that's still in its outro). Quit goes to fighter select.
- [ ] Unplug (or switch off) a gamepad mid-fight: the game pauses with "P2's controller disconnected — press any button to reconnect"; Resume and Restart are greyed out but Settings / Quit work. Plug it back in and press a button: the banner goes, the menu stays up, and Start resumes. A different pad (or a free keyboard half) can take over instead.
- [ ] Settings (Tab or pad Select on fighter select, or from the pause menu): game and voice volume change independently (with a preview sound each step); screen shake off stops kick/throw shakes; all settings survive a reload.
- [ ] Remap P1's keys: each prompt takes one key; a key P2 uses, Esc/F1/Tab/1–9 are refused with a reason; Esc cancels without changes. The new keys work for joining, in the fight, on the "How to fight" screen and in the pause Controls list. "Reset keys to default" restores WASD + J/K.
- [ ] Low health (≤ 30) pulses the bar with a red glow (faster below 15). Last 10 s: the clock turns red, pops each second and ticks; not in practice.
- [ ] Export P1's fighter downloads a `.photodojo`; Delete needs a second click within 3 s; built-ins can't be deleted.
- [ ] Private window / storage not persisted: the warning line shows on character select.
- [ ] Mirror match (same fighter on both sides): P2 is tinted.

## 4. Browsers

| | Capture | Game | Transfer |
|---|---|---|---|
| iOS Safari | | | |
| Android Chrome | | | |
| Desktop Chrome | | | |
| Desktop Safari | | | |
| Desktop Firefox | | | |
