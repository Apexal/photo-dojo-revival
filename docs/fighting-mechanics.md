# Making fights fair (without making them serious)

> **Status: implemented.** Everything in sections 2–4 is in the game, plus the taunt and "chip can't KO" from section 5: blockstun and hitstun (2.1), throw and tech (2.2), high/low with the low kick and an overhead jump kick (2.3), reach and hurtbox clamping (3.1), uppercut / low kick on inputs (3.2B), cross-ups and alternating sides (3.3), the input buffer, block leniency, the jump wind-up and the replay's mash guard (4). Each rule is covered by tests in `tests/fight-simulation.test.ts` and `tests/collision.test.ts`. Section 1 describes the rules *before* these changes.

Foto Fighter is a party game: two friends, one laptop, fighters made of their own goofy photos. The goal isn't tournament depth. It's that **the person who plays better usually wins, and nobody feels cheated**. This report looks at where the current rules fall short of that, and what real fighting games do about it. It suggests the smallest changes that fix each problem, ordered by how much they matter.

Everything here applies to the pure simulation in `src/simulation/` and `src/shared/frame-data.ts`, so every suggestion can be unit-tested the same way the current rules are.

---

## 1. What the numbers say today

I measured frame advantage in the simulation: how many frames earlier the defender can act than the attacker after an attack connects. Hitstop is excluded. Positive numbers favor the attacker.

| Attack | On hit | On block |
|---|---|---|
| Punch (4f startup) | **−1** | **−13** |
| Kick (7f startup) | **−4** | **−20** |

Two consequences:

- **Landing a hit puts you behind.** Hitstun (12/16f) is shorter than the attack's remaining active + recovery frames (12/19f). After you hit someone, *they* get to act first. In real fighting games a clean hit is almost always plus, and being behind after a successful hit feels wrong even to people who don't know the terms.
- **Blocking is free and always wins.** There's no blockstun, so the defender acts the moment hitstop ends, 13–20 frames before the attacker recovers. A 4-frame punch punishes *every* blocked attack. The best strategy is to hold back and wait, which makes fights slow and turtly. There's also no throw to beat a blocker.

This explains why fights between new players tend to stall: whoever attacks first loses.

---

## 2. Fix the core loop (do these first)

### 2.1 Make hits plus and blocks slightly minus

Add **blockstun** and lengthen **hitstun**. Suggested values, chosen so that:
- a landed punch or kick leaves the attacker slightly ahead;
- a blocked punch is safe (−3, too little for the 4-frame punch to punish);
- a blocked kick is punishable by a punch (−6). Kicks are big and should be risky.

| | Startup | Active | Recovery | Hitstun | **Blockstun** | On hit | On block |
|---|---|---|---|---|---|---|---|
| Punch | 4 | 3 | 10 | 12 → **15** | **10** | +2 | −3 |
| Kick | 7 | 4 | 16 | 16 → **21** | **14** | +1 | −6 |

Implementation: give `AttackData` a `blockstun` field. In `applyHit`, a blocked hit puts the defender into a `block` action with `stunFrames = blockstun`. The fighter state machine already treats hurt/attack as locked actions, so blockstun is just another locked state. Add a frame-advantage test like the measurement above, so the table stays true.

**Why this matters most:** the "rock" (attacking) currently loses to the "paper" (blocking) with no "scissors". These numbers make attacking a real option again.

### 2.2 Add a throw so blocking can be beaten

Real fighting games have a triangle: **attacks beat throws, throws beat blocks, blocks beat attacks**. Without throws, a player who just holds back can't be opened up.

Minimal version:
- **Input:** punch + kick together, or forward + punch, at close range (within the push boxes plus a few pixels).
- **Frame data:** 5f startup, 1 active frame, unblockable, 10 damage. It whiffs if the opponent is mid-attack (attacks beat throws) and has big recovery on whiff (20f) so it can't be spammed.
- **Escape (optional, nice for fairness):** pressing punch + kick within 8 frames of being grabbed breaks the throw for no damage.
- **Pose:** reuse `punch` for the thrower and `hurt` for the victim, plus a sideways shove: the victim is pushed 80 px and the sides stay as they are. It stays silly with no new captures needed. A later bonus capture ("grab") could replace the pose.
- **Now:** a throw that lands knocks down (section 2.4): the victim is flung `throwDistance` (90 px), lies down, then gets up, which leaves the thrower free well before them.

### 2.4 Knockdowns (implemented)

Street Fighter's reset: a throw, or an **uppercut** hit on someone in the air (the anti-air's reward), sends the victim flying back to the floor; a KO hit makes the loser fall too. Other air hits are plain hits, so knockdowns stay an event rather than every exchange.

- `knockdown` (flying) → `downed` (40 frames on the floor) → `wakeup` (12 frames) → free; buffered presses come out on the first free frame (a wake-up attack).
- The whole time they can't be hit or thrown and have no push box (walk over them): **no juggles**, so this fits the "no combos" rule in section 5. It resets to neutral with the attacker free first; the fixed wake-up timing is the guessing game (attack so it's out as they rise, or wait and block).
- Drawn without new captures: the hurt photo tipped back around the feet until it lies flat, resting on the floor, a bounce, dust and a thud on landing; it rotates back up and eases into the stance. The CPU walks in on a downed opponent and, more often on harder levels, times an attack for their wake-up.

### 2.3 Give blocking a high/low choice

Right now crouch-block blocks everything, so a crouching player is safe forever. Give it one weakness each way:
- **Down + kick → low kick.** It must be blocked crouching. Use the **low kick** bonus capture when the fighter has one, and the main kick otherwise.
- **Kick in the air → jump kick.** It must be blocked standing (an "overhead"). Jumping needs to allow an attack for this, using the kick pose.

That's two new inputs and one rule in hit resolution: a hit counts as blocked only if the guard matches its height. It turns blocking from "hold a direction" into a read, which is the whole game in real fighters.

---

## 3. Fairness between different fighters

Fighters are built from photos, so their hitboxes come from each person's actual body. That's charming, but it means **a tall person, or one who stretched a long kick during capture, gets more reach**. Someone who crouched a compact idle pose gets a smaller hurtbox. Pose capture shouldn't decide the winner.

### 3.1 Normalize reach and body size

Size is already normalized (every fighter has the same torso length on screen). Limbs and pose extents aren't. Suggested:
- **Clamp reach:** measure each attack hitbox's horizontal reach from the anchor and clamp it to the canonical stick figure's reach ±15%. Squeeze the hitbox and its landmarks toward the anchor, not the sprite. The sprite keeps looking like the person, and the gameplay box stays within a fair band.
- **Standard hurtboxes:** derive the hurtbox for each action from the canonical skeleton, scaled by the fighter's body scale, instead of from the raw capture's bounding box. Keep "the attacking limb is hittable while extended": that's how whiff punishing works, and it's intuitive.
- **Body-shaped hurtboxes (implemented):** instead of one bounding rectangle per pose, the hurtbox is a set of boxes: head, torso, and each visible limb bone in two halves (`hurtboxesFor` in `frame-data.ts`). Only where the body is can be hit: the empty space under an extended arm or above a crouch isn't part of it, and the extended attacking limb is, for whiff punishing. Part thickness is fixed in canonical units (`HURT_PART_SIZE`), the same for every fighter, and every part is clipped to the stick figure's extent for that frame ±15%, so a sprawling capture isn't a bigger target. Because hurtboxes now follow the body, punch hitboxes run from the fist back to the shoulder (kicks: foot to knee), so point-blank hits still land. Trade-off: the *minimum* target isn't enforced any more, so how far you can be hit from depends a little on your own captured pose (e.g. a tight guard is reached by an uppercut ~20% less far than the stick figure's). Standardizing hurtboxes on the stick figure would remove that.
- **Hurtboxes don't depend on animation or luck (implemented):** walking alternates the walk and idle photos for a stride, but the hurtboxes are always the idle ones (the stride's front leg would otherwise make you a bigger target every other step), and alternates picked by where a hit landed (hurt, KO) or at random (win/taunt) are cosmetic: the main pose's hurtboxes count (`hurtFrameOf` in `fight-simulation.ts`).
- **Show it:** the F1 overlay draws all three kinds of box (each hurtbox part separately). When the clamp kicks in, draw the original box faintly too, so testers can see what got evened out.

### 3.1b Crouching (implemented)

Holding down is one stance: a crouching guard, drawn with its own capture (`crouch`, the 13th pose). It used to be drawn with the standing block photo, so nobody could see which way an opponent was guarding and the high/low game was blind guessing.
- The punch is a **high** attack: blocked standing, and it **whiffs over a crouching guard** (`whiffsOverCrouch` / `isCrouching`). That's an explicit rule, not a side effect of how low someone crouched in their photo. It gives the punch, otherwise the best move in most situations, a counter.
- Kicks and uppercuts are mids (block either way), the low kick must be crouch-blocked, and the **jump kick** (overhead) still beats a crouch: it now stays active until landing, so a late jump kick comes down onto the crouch. Before that change it connected on only ~20% of timings against a crouch, which would have made crouching safe against everything but throws. A jump-in that lands right on top of a crouching opponent (or crosses over) still whiffs, so jump-ins need spacing.
- Crouching loses to the jump kick and to throws.

### 3.1c Spacing: the punch is fast, the kick is long (implemented)

Measured with a simulated option-vs-option table (every pair of options, both starting together, at distances from point-blank to 370 px, including reactive options: block then punish, duck then punish, back off then punish): the punch used to beat everything at every distance. It was the fastest move *and* reached furthest (214 px vs the kick's 206), and the idle guard held the fists ~130 px out front, so every move was in range from 300+ px and speed decided everything.
- **Guard pulled in:** the idle stick figure (and the idle capture target) hold the fists by the chin; the idle hurtbox's front edge went from 131 to 107 px, and photo fighters are clipped to that envelope.
- **Kicks lunge:** `advance` on an attack moves the fighter forward evenly over its *active* frames (kick 60 px, low kick 20 px), so the body only closes in after the punch window has passed, and the lunge stops on contact. Moving during startup instead walked the kicker into the punch. Hitboxes still follow the visible limb.
- **Kicking while backing off doesn't lunge:** a kick (or low kick) pressed with back held comes out in place (`retreating` on the fighter state). Lunging forward when the player is retreating felt like the game ignoring the input, and it removed the backing-off kick that catches someone walking in. Checked in the same table: the in-place kick is never undefeated (a punch beats it at most distances), and walking back then kicking is what beats an incoming lunge kick at 370 px.
- **Tip-safe kick:** kick pushback 20 (was 10). Blocked from ~310–350 px it can't be punished; blocked closer it can.
- Result: at every distance up to 290 px and at 370 px, no option is undefeated (the punch loses to a duck read; the kick to block/duck punishes). At ~330 px a well-spaced kick has no counter in the table, but it only nets chip damage against a blocker. That's the reward for spacing.

### 3.2 Make the variants fair (there's a trade-off here)

The new bonus moves (uppercut, low kick, hit-in-the-face, flex) are picked **at random** when an action starts. That's fair in the sense that it's deterministic and replayable. But an uppercut's hitbox sits higher than a straight punch's, so **whether your punch hits a crouching opponent is partly luck**. Two options:

- **Option A: variants are cosmetic.** Variant sprites are shown, but hits use the main pose's hitbox. Least surprise, and it stays random. Two-line change in `resolveHits`.
- **Option B (recommended): variants become moves.** Map them to inputs, each with its own frame data:
  - `down + punch` → uppercut: the anti-air. Attacks from airborne fighters can't hit it during its startup and active frames (`antiAirImmune` in `fight-simulation.ts`); without that it lost to jump-ins more often than a plain punch did. Still −8 on block.
  - `down + kick` → low kick: the "low" from 2.3.
  - Hit reactions and wins stay random. They're cosmetic anyway.

  This gives the bonus captures a gameplay purpose (and a reason to capture them) without adding complexity for players who skip them. The main pose is the fallback for fighters without the capture.

### 3.3 Side and position fairness

- P1 always starts on the left. Alternate starting sides between rounds (positions are already symmetric).
- When a cornered defender is hit, the attacker takes the pushback. That's already implemented, and it matches real fighting games because it stops infinite corner pressure. Keep it.
- Jumping over the opponent (cross-ups) is currently impossible because push boxes collide in the air. Allowing it (ignore push boxes while airborne, and resolve facing on landing) adds movement options and makes corners escapable. Escaping corners is a real fairness concern when one player gets trapped.

---

### 3.4 Archetypes: one signature move each (implemented)

Everyone sharing one move set kept fights fair but samey. So each fighter picks an **archetype** at the start of capture (`src/shared/archetypes.ts`), which decides the one extra pose it needs (the `signature` capture). It adds exactly one move, on the same input for everyone: **down + punch + kick**. Everything else stays the shared core, so the controls, the tutorial and the README still hold for every fighter, and the balance work is four moves, not four move sets.

| Archetype | Move | Frame data | Beats | Loses to |
|---|---|---|---|---|
| Brawler | Shoulder Charge (`ATTACKS.charge`) | 14 startup, 10 active, 18 recovery; lunges 300 px over its active frames; mid; 14 dmg; knocks down on hit (`knockdown: "always"`); −16 on block | Backing off and zoning: it reaches ~80 px past a kick's range from a standing start | Blocking (a free punish), a jump, the parry; the 14-frame lean is the tell |
| Grappler | Bear Hug (`GRABS.bearHug`) | 8 startup, 1 active, 32 recovery; range 110 (the throw's is 40); 20 dmg; held 14 frames and can't be teched | Blocking from outside throw range | Any attack (attacks beat grabs), jumping, stepping back; a whiff is a long time with arms out |
| Guardian | Parry (`PARRY`) | 3 startup, catches strikes on frames 3–12, 18 recovery; the attacker staggers 24 frames (`parried`), the guardian is free at once | Any strike, every hit level, including the other signatures' strikes | Grabs (a parrying fighter is throwable), waiting it out: 31 frames open on a whiff |
| Acrobat | Flying Knee (`ATTACKS.flyingKnee`) | 16 startup (a dip, then the knee), 4 active, 14 recovery; lunges 80 px; overhead; 9 dmg; +1 on hit, −4 on block | A crouching guard, without having to jump | Standing block, reacting to the 16-frame startup, any faster attack |

Notes:
- **Why down + punch + kick.** It was a throw before, and throws hardly ever happen while holding down; neutral or back + punch + kick still throws (or taunts from afar). Punch then kick a frame or two later with down held still counts (the throw leniency, `THROW_LENIENCY_FRAMES`).
- **The parry isn't a just-frame mechanic.** Its window is 10 frames, about a sixth of a second, and the CPU uses it only when the hit is due inside that window, given its reaction delay. It's a read: guess right and you get a free punish, guess wrong and you're open for half a second.
- **Fairness still holds per frame.** Signature hitboxes are clamped like every other attack's (3.1), against the archetype's own stick figure. Hurtboxes during the signature pose are clipped to that stick figure's extent too.
- **No stat leans** (speed, health, damage) for now: the moves need tuning on their own first.
- **Tests:** `tests/signature-moves.test.ts`; each archetype also plays the whole tutorial in `tests/tutorial.test.ts`.

---

## 4. Forgiveness for casual hands (cheap, high impact)

Fighting games feel unfair to newcomers mostly because inputs get "eaten". The keyboard taps fix from earlier was one case.

- **Input buffer:** remember a punch/kick press for 5 frames. If you press during recovery or hitstun, the attack comes out on the first frame you're free. Real games buffer 3–10 frames.
- **Block leniency:** count "holding back" as blocking if it was held at any point in the last 3 frames. It covers the moment a player switches from walking forward to blocking.
- **Jump squat:** add 3 frames before leaving the ground, during which the player can still block. It stops accidental jumps from up-held d-pads being punished as hard.
- **No mash-through:** the round-result screen already ignores input for 700 ms. Do the same for the first 20 frames after a KO, so a mashed button doesn't start the next round or a rematch by accident.

---

## 5. Keep it light: what *not* to add

These are standard in serious fighters, but they'd make Foto Fighter worse for its audience:

| Feature | Why skip it |
|---|---|
| Special moves with motion inputs (quarter-circles) | Hard on keyboards and for first-timers; the fun is the photos, not execution. |
| Combos / cancels / juggles | Creates a skill cliff where one player never gets to act. Keep hitstun short enough that a hit doesn't lead to a guaranteed second hit (with the values in 2.1, +2 on hit is far from a combo). |
| Super meter | One more thing to explain. If anything, a single "big kick" once per round. |
| Per-character frame data | The shared core stays one move set; that *is* the fairness. Archetypes (3.4) add one signature move each and nothing else. |
| Just-frame mechanics | Intimidating; fair only between experts. The guardian's parry has a 10-frame window for that reason (3.4). |

**Optional fun that doesn't hurt fairness:**
- **Taunt** (both buttons while far away): plays the win pose and the taunt line (the victory line if none was recorded), with no gameplay effect except leaving the taunter open.
- **Chip damage can't KO**, so a blocked kick never ends a round. Blocking should never feel like losing.
- **A tiny comeback cushion:** the losing fighter's hitstun on the round's final hit is shown in slow motion. It's pure spectacle and changes nothing.

---

## 6. Suggested order

| # | Change | Effort | Impact |
|---|---|---|---|
| 1 | Blockstun + longer hitstun (2.1) | Small: data + `applyHit` | Fixes the biggest problem: attacking becomes viable |
| 2 | Input buffer + block leniency (4) | Small | Fewer eaten inputs; feels fair to newcomers |
| 3 | Variants: cosmetic or input-mapped (3.2) | Small (A) / Medium (B) | Removes randomness from hitting |
| 4 | Throw (2.2) | Medium | Completes attack/throw/block triangle |
| 5 | Reach/hurtbox normalization (3.1) | Medium | Capture style stops deciding fights |
| 6 | Low kick + jump kick (2.3) | Medium | Blocking becomes a read, not a hold |
| 7 | Cross-ups, alternating sides (3.3) | Small–Medium | Corner escape, side fairness |

Steps 1–3 are about a day together and would change how fights feel the most. Each is deterministic and fits the existing unit-test style: for frame advantage, write a "scripted inputs → expected state" test like the measurement in section 1.

---

### Appendix: how the advantage numbers were measured

Two stick fighters stand 120 px apart. P1 presses the attack, and P2 either stands still or holds back to block. The simulation is stepped until each fighter is back in a free state (idle/walk/block). Hitstop frames are excluded, because they freeze both fighters equally. Advantage = (frame the defender is free) − (frame the attacker is free).
