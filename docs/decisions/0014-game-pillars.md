# 0014: Game pillars: water world, controls, economy and supply control

- Status: accepted (the key map has grown with the game, and DESIGN §3 is current: H promotes, M opens the pond map, G opens the social wheel)
- Date: 2026-10-25

## Context

The brief puts fun first: fast survival with real risk, visible progress and attachment to a lineage, enjoyable before the player understands genetics, with approachable controls, readable consequences and no NPC organisms. The owner chose a **water-only** world for v1.0, **combat after breeding**, and **light procedural sound**. Supply control has to make strong organisms hard to develop and keep alive, even for players running bots.

## Decision

- **World**: one continuous body of water, seen from above. Sunlit shallows have caustics and UV. Twilight is mid-depth. In the deep and the abyss, bioluminescence is the main light and pressure is the hazard. Depth comes from a deterministic bathymetry field. No land stage before 1.0.
- **Nothing alive but players.** Food is nonliving: detritus, nutrient globules, vent crystals, and carrion from dead creatures. Hazards are toxic plumes, currents, UV in the shallows and pressure in the abyss. Decorative particles may look like algae or diatoms but never behave like organisms.
- **Controls** (mouse and keyboard, at most 6 core actions):
  - Steering: the cursor sets direction, and its distance from the creature sets throttle; WASD is the alternative.
  - Space: dash. E: court or accept. F or click: attack (M7).
  - In combat only: 1/2/3 for stance, Tab for target, Shift for brace.
  - Social: Enter for chat, T for emote, G for ping. Esc: menu.
- **Economy**:
  - Energy pays for metabolism, movement and actions.
  - Biomass is size; energy surplus turns into it, up to the genetic maximum.
  - Starvation, hazards and fights cost health; at zero health the creature dies with a stated cause.
- **Lifecycle**:
  - A creature hatches small and grows.
  - It matures after a minimum active time and size, then reproduces with a cooldown.
  - It ages, and dies of old age at the end of its lifespan.
  - Lifespan counts **active** time only. Inactive checkpoints and offline creatures are paused, except inside committed encounters.
- **Lineage**:
  - Each mating gives both players their own offspring.
  - Promoting turns the parent into a checkpoint.
  - On death the player chooses their pending offspring or returns to the nearest surviving ancestor. With neither, a new genesis starts and the old lineage remains as history.
- **Supply control**:
  - a genesis limit per identity;
  - mating costs energy and biomass, with a cooldown that doubles for repeat partners within 24 h;
  - inbreeding expresses recessive load alleles;
  - kill rewards decay for repeated victims and brand-new identities;
  - witness duty needs play history;
  - every strong trait has upkeep (ADR 0006).

  Bots still gain extra attempts, but no shortcut to superior creatures.
- **Feedback**: every source of damage and every death has a visible and an audible cue. Light procedural Web Audio (no asset files) provides ambience by depth and sound effects for eating, dashing, hits, danger, courtship, hatching, pings and chat (M6).
- **Living reference**: `docs/DESIGN.md` describes the mechanics and lists initial values. Code tables (`src/sim/rules.ts` and those that follow) are the source of truth. Specs update DESIGN.md whenever they change a mechanic or a value.

## Consequences

- Playtests can tune numbers without new decisions. Changes to these pillars need a new ADR.
- Rejected:
  - a land stage before 1.0 (owner decision);
  - NPC predators or prey of any kind (brief);
  - complex biochemistry simulation (brief: fun first);
  - audio files with licensing (procedural audio covers the need).
