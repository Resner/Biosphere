---
paths:
  - "src/game/**"
  - "src/lab/**"
  - "index.html"
  - "lab.html"
---

# Game shell and UI (`src/game`, `src/lab`)

`docs/DESIGN.md` describes the mechanics and controls; ADR 0014 sets the pillars.

- Controls: mouse plus keyboard, at most 6 core actions, each with a keyboard equivalent and a visible hint. Combat keys work only in combat.
- Readable consequences: every source of damage and every death cause has a visible cue (audible from M6). The death screen always names the cause. Never a silent death.
- The core loop (move, feed, survive, find a mate) must work without opening any genetics UI. Genetics adds depth; it never gates the fun.
- No NPC organisms, fake players or bots in the live world. Test clients and simulated populations never point at the production authority.
- Test hook `window.__bs`: read-only views and replay are always present. Mutating helpers exist only under `?debug=1` and never change authority-side state.
- Keep text short and plain English. Never use colour as the only signal (threat outlines also change shape or pulse).
