# 0051: Combat from anatomy, size as an advantage, and kills as the fast way to grow

- Status: accepted (amends 0011's reward line and DESIGN §7's initial values; the combat tournament tunes the numbers)
- Date: 2026-11-02

## Context

The brief asks for automatic baseline combat driven by anatomy, with tradeoffs and no single best build. The owner added two points on Playtest v0.6.0:

- killing a comparable creature must grow you faster than eating plankton;
- size must be a meaningful advantage in a fight.

Both are M7 exit criteria. The plankton economy has to stay the way to grow in a creature's first minutes, and repeated-victim decay stays in M8.

The bodies give little to work with. Over 1,000 genesis bodies (`Stats.combat`):
- weapon power is 0 for half of them, and at most 0.3;
- armour is at most 0.03;
- spines have a median of 0.09.

Random-byte bodies, a stand-in for long breeding, reach a power of 9 and an armour of 0.9. Damage proportional to raw power would leave half the genesis cells harmless and let evolved ones kill in one hit. DESIGN §7 gave a reward of 40% of the victim's biomass "as energy first", and energy only becomes biomass at the growth cap (`0.012·b` per second). A full forager already grows near that cap, so an energy reward would never grow a killer faster.

## Decision

**Strikes.** Every body strikes automatically. Its strike profile is:
- reach: the farther of the weapon reach and the mouth's reach;
- arc: the wider of the weapon arc and the mouth's arc, at least 0.6 rad;
- power: `nip + gain × w ÷ (w + half)`, where `w` is `Stats.combat.power` (pointed and hooked tips, chelae, a jaw's bite). Initial values: nip 0.3, gain 1.2, half 0.6.

So every mouth bites. A genesis weapon doubles the bite, and an evolved arsenal is worth about 5 bites, never 30. A strike winds up for 8 ticks (the telegraph) and lands only if the target is still within 1.1 × the reach and inside the arc. Then the striker waits 24 ticks.

**Damage scales with the attacker's radius, and health with the victim's** (health is already 10 × radius):

`damage = scale × r_attacker × power × stance × (1 − cap × armour × stance armour) × brace × (1 ± 0.1)`

Initial values: scale 2.8, cap 0.6. A body 1.5 times as wide deals 1.5 times the damage and lasts 1.5 times as long, so it kills about 2.25 times as fast. That is the size advantage, and it holds within ±1 tier. The tournament's size targets bound it: at 1.5 × the biomass a body wins at least 70% of mirror duels, and at 2 × at least 85%. If size makes bigger bodies too strong, the fallback is `r^0.75`.

**Rams, spines, armour.**
- A ram is a collision at a closing speed above 60 wu/s (a dash). Its damage grows with speed up to 120 wu/s and with the rammer's share of the pair's mass. A pair can ram at most once every 24 ticks. So fast, heavy bodies ram, and nothing names a "blunt" part.
- Spines return 0.4 × spines of the damage a strike or ram dealt to its attacker.
- Armour reduces damage by at most 60%. It already costs mass, drag and basal metabolism (ADR 0006).

**Stance and brace.** These are DESIGN §7's numbers, converted to ticks:
- the brace window is 8 ticks, its cooldown 60 ticks and its cost 0.05 × biomass of energy;
- a brace blocks 80% of a strike or ram that lands inside the window, and staggers the attacker for 9 ticks (no windup, 30% thrust);
- a brace also shields the bracer's egg (ADR 0052).

**Rewards are biomass.**
- A kill gives the killer `0.4 × the victim's biomass × tier factor` as biomass at once, up to its maximum. The rest becomes energy at 3 per unit, up to its maximum. Health rises by 10 per unit of radius gained, as growth gives it.
- The tier factor is 0.5 for a victim a tier smaller, 1 for the same tier and 1.5 for a tier bigger.
- Another 40% of the victim's biomass becomes carrion: food anyone can eat for 60 s near where it died. It is worth 3 energy per unit of biomass, eaten best by jaws.
- Growth outside fights keeps its cap. Carrion is energy, and plankton is unchanged.

A hatchling or a genesis cell is a poor prey: the victim's biomass is small, and a bigger hunter gets the 0.5 factor. Spawn protection (15 s, ADR 0050) covers a new creature's first moments. So the first minutes still grow on plankton.

**No new genes.** Combat reads anatomy that already exists:
- `Stats.combat` (reach, arc, power, armour, spines);
- mass;
- the speed band and turning;
- the colliders, which become hit shapes in fights.

Behaviour genes (aggression, caution, curiosity, reflex, target preference) drive only the autopilot. A body's stats stay at its adult values for its whole life, as for movement, and its current radius scales everything.

**Tuning gate**, the combat tournament (`npm run report:combat`, run as a heavy test):
- no archetype wins more than 70% overall;
- at least one pairing is won at least 65% one way, so anatomy decides fights;
- mirror duels go 40–60%;
- genesis duels of equal size last a median of 8–25 s;
- the size targets above;
- a duel winner gains biomass at least 1.5 times as fast per minute of fighting as the pacing bot does per minute of foraging at the same size.

## Consequences

- Fights are short and decisive between comparable bodies, and lopsided across a size gap, which is the owner's ask. Fleeing (evasive stance, a dash, escape after 3 s out of range) is the answer to a bigger hunter.
- Kills grow a creature visibly at once. That is a strong pull toward combat, kept in check by the tier factor, spawn protection, ±1 tier and, from M8, decay for repeated victims and young identities.
- Two identities can still farm each other until M8's decay. The hatch bucket and the 0.5 factor for small victims bound the gain.
- Rejected:
  - damage from raw weapon power (half the genesis cells harmless, evolved ones one-shot);
  - damage independent of size (the owner wants size to matter);
  - energy-first rewards (they never beat the growth cap);
  - new combat genes (the existing anatomy already differs widely);
  - hard-coded bonuses for named parts (ADR 0006).
