---
paths:
  - "src/game/**"
  - "src/lab/**"
  - "index.html"
  - "lab.html"
---

# Game shell and UI (`src/game`, `src/lab`)

`docs/DESIGN.md` describes the mechanics and controls; ADR 0014 sets the pillars.

- Controls: mouse plus keyboard, at most 6 core actions (ADR 0014): steer, dash, court, attack, the social wheel and the menu (DESIGN §3). Each has a keyboard equivalent and a visible hint. Any other key (chat, emote, pond map, promote, the combat keys) is a shortcut for something the screen also offers, so the game plays with the six alone. Combat keys work only in combat.
- Readable consequences: every source of damage and every death cause has a visible cue (audible from M6). The death screen always names the cause. Never a silent death.
- The core loop (move, feed, survive, find a mate) must work without opening any genetics UI. Genetics adds depth; it never gates the fun.
- No NPC organisms, fake players or bots in the live world. Test clients and simulated populations never point at the production authority.
- Test hook `window.__bs`: read-only views and replay are always present. Mutating helpers exist only under `?debug=1` and never change authority-side state.
- Keep text short and plain English. Never use colour as the only signal (threat outlines also change shape or pulse).
- The play screen is minimal (M6b, owner, Playtest #183): one menu button, four stat bars and the minimap (at most 6% of the screen), with no permanent text; the numbers live in the menu (Esc). Events (toasts, chips, hints, the result card) may appear and go. Damage and hazards never paint a border, vignette or overlay: damage lands as distinct hits at most every 0.5 s that gently jolt the body and kick the camera (no kicks under Reduce motion), flash the body deep red and the health bar, and sound; the hazard icon shows beside the minimap's depth gauge. The wheel and the menu never stop the player's movement. Nothing covers the egg while it waits, on the title and death screens too.
- Riding the current (M12 T7, `src/game/ride.ts`): `Ride` is pure and takes the time it is given. The offer shows once the page has been alone (`OnlineSession.alone()`, playing and alive) for `aloneMs` plus the report's 2 s gap, for 12 s and again every 2 minutes; it takes the alone hint's place (`ride-offer`, whose button takes the pointer), and the menu's `menu-ride` shows while the page is alone. R or either button sends one `ride` (`OnlineWiring.askRide`). On the hub's `spawn { why: 'ride' }` the transition plays on wall time with input held (`Ticker.chooseInput`): the first half sweeps the sim creature from where it was toward the arrival, the turn puts it a few radii short of the arrival and snaps the camera, zones and field there (`Ticker.carry`), the second half drifts it in, ending exactly at the arrival; under Reduce motion it holds still and turns at once (0.4 s). While it plays, `creatureNow()` reports the arrival, so no report from the old place reaches the hub's anchor. The look is `src/render/ride-fx.ts` (streaks as one additive `LineSegments` and a water-coloured wash under the creatures: two draw calls while riding, none otherwise), fed from `Ride.look`. A new life resets it.
