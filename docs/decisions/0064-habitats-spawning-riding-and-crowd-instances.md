# 0064: Habitats: spawning around groups, riding the current, crowd instances and anchored transitions

- Status: accepted (amends 0013: the spawn centre stays the world's centre, instances split a crowded area rather than a crowded leaf, and open water shares water with every instance; amends 0062: `near`, gossip and the hello carry the instance, and a crowded page reports its crowd; amended by 0069: a group wider than the rings reach is searched from its edge)
- Date: 2026-11-07

## Context

M11 made one world with links by area of interest (ADR 0062). Three parts of ADR 0013 were left for M12:

- **Spawning.** A joiner still takes the first free slot on one ring around the world's centre (`place` in `worker/sessions.ts`), and the page turns later lives around that ring (`ringSpawn`). Nothing keeps a newcomer away from creatures that could attack it, nothing follows the players once they swim off, and a ring of 300 slots reaches 12 km.
- **Regrouping.** In a sparse world players drift apart and stay apart. A reload puts a creature back on the ring wherever it was, so a reload is a free teleport.
- **Crowds.** When more than 32 creatures that can act on a page are near, the page keeps the nearest and says `crowded`, and `engage:unseen` keeps an unseen attacker out. ADR 0013 promised bounded instances of a crowded leaf instead.

Facts that shape the decisions:
- **Directory positions are coarse.** A member reports every 30 s, or when it leaves its leaf by 64 wu or changes tier. In a sparse world the root leaf holds everyone, so a position can be 30 s old: up to 3,000 wu off.
- **Crowds span leaves.** The harness's `crowd` scenario (40 comparable creatures within 1,500 wu) sits across several 1,024 wu leaves, none of which holds 16. Counting a leaf's members does not find a crowd; a page's own count of P0 and P1 does.
- **Friends link at once only within P1.** A P1 (within 8 × the larger radius + 600 wu, 760 wu for two starters) is called through the hub at once. Further out a call waits on gossip, the lower id or a fresh sighting, so a newcomer placed further than P1 from a friend links in seconds, not at once.
- **Engage range is about 3 to 4 radii.** A strike reaches the farther of the weapon reach and the mouth's reach (up to about 3.6 core radii), plus 0.3 of the target's radius. The engage-candidate distance (8 × the larger radius) bounds it.
- **The world centre is the safe place.** Only its 1,400 wu disc is always twilight, and no vent lies within 1,800 wu of it.
- **The authority is not on the hot path** (ADR 0008): at most 20 incoming messages per player-minute, and the AoI harness's median is 2 to 6.
- **Hibernation empties memory.** The directory is rebuilt from the sockets' attachments (2 KB each), and anything that must outlive a socket goes to SQLite.

## Decision

### Groups and the spawn centre

- **The spawn centre stays the world's centre**, in the world's row as it is. In an empty world the first player spawns on it, so the first player establishes it, as the brief asks. Groups then decide where everyone else goes.
- **A group** is a single-linkage cluster of the directory's members that can link with the spawning creature (`linkTiers`): two members chain when they are within half the spawner's query radius `Q` (4,096 wu for a starter).
- **The best group** has the most members of the spawner's own tier, then the most it can link with, then lies nearest the spawn centre.

### Placement

The authority places every creature that enters the water from somewhere else: a genesis, a restored ancestor, a resume after 10 minutes away, and a ride. `worker/placement.ts` is pure.

- **Rings** around the best group's centroid (or the spawn centre when there is no group), from the centre itself outward:
  - rings a quarter of the clearance apart;
  - candidates half a clearance apart along each ring, at least 8;
  - up to 128 rings and 8,192 candidates.
- **A candidate is valid** when:
  - it lies at least 1,024 wu inside the world's edges;
  - it is in the safe depth band: below the shallows' edge plus the UV band (0.27) and above the pressure's start (0.7), so neither UV nor pressure hurts;
  - it is clear of plumes now and for 10 s, with `findClearSpot`'s rule and a reach of 2.5 × the spawner's radius;
  - it keeps the **clearance** from every member that could engage the spawner (exact tiers within ±1), and from every spawn of the last 60 s;
  - it is not within P1 reach of a member in an instance (a newcomer never spawns into a crowd; it may swim in).
- **The clearance** between two creatures is the larger of their AoIs, and never less than 12 × the larger radius:
  - for two starters, 233 to 354 wu: out of each other's view, and three times a typical engage range (3 to 4 radii);
  - 992 wu for two T1 adults and about 5,200 wu for two T2 adults, where the AoI still decides;
  - it uses the members' reported positions, so a member that swam since may be nearer. Spawn protection (15 s) covers the rest.
- **The first ring with a valid candidate wins.** Among its valid candidates, those within P1 reach of a member of the group come first, so friends link at once. One is drawn at random.
  - So spawns fill the gaps inside a group first, and the populated area grows outward as it fills.
  - The draw keeps the point unpredictable, and the recent-spawn clearance keeps newcomers apart: nobody can wait at "the spawn".
- **Fallbacks**: past 128 rings, the same search around the spawn centre; past that, the spawn centre itself.
- **No change to the sim.** Placement reads the bathymetry and plumes, which are pure functions of the seed. The page still runs `findClearSpot` on the answer and normally leaves it unchanged. No rules version changes and the world is not renewed.

### How a life is placed, and anchored

- **Asking.** When its creature enters the water, a page asks the hub with `spawn`. The answer names the place, why (`placed`, `back`, `ride`) and whether the creature is protected. The welcome's ring slot and spawn hint go.
- **By kind of life**:
  - a genesis and a restore are `placed` and protected for 15 s, counted from the answer rather than the binding, so a long egg reveal no longer eats it;
  - an unrecorded practice cell in the hub's world is `placed` by the radius and AoI it states, unprotected;
  - a promoted child keeps the parent's place and asks nothing;
  - a resume comes `back` where the creature left the water when that was under 10 minutes ago and it is the same creature, unprotected; otherwise it is `placed`, unprotected;
  - a return into a fight takes its place from the fight.
- **Where it left** lives in SQLite (migration 12: `players.left_x`, `left_y`, `left_at`, `left_creature`). The close writes it from the session's last report, in the transaction that writes its checkpoint, once per close. A reload is no longer a teleport.
- **Anchors.** Every binding has one:
  - after a placement or a ride: the place given;
  - after a promote: the parent's last report;
  - after a fight: the fighter's final position in the authority's own encounter.

  The first report after it must lie within the jump bound from that anchor: 300 wu/s since the anchor, plus 2,000 wu. A report past that is dropped, counted and flagged `teleport` once per creature. Fixture mode still takes jumps, for debug teleports.

### Riding the current

- **Who may ride.** A player may ride when all of these hold:
  - its creature is in the water;
  - it is not locked (no fight, no lock waiting for an answer);
  - it has no court outstanding;
  - its last fight ended at least 120 s ago;
  - the hub's directory has placed no creature it can link with and shares water with within its `Q` for 120 s (`aloneSince`, kept in the attachment), and none now.
- **What a ride does.**
  - The target is the best group among the others, and the arrival is placed by the rules above.
  - On arrival the creature is protected for 15 s, as a spawn is.
  - The creature keeps its state; no record is written.
  - The answer, like a spawn's, puts the member in the directory at its arrival at once, so two lone players asking together don't swap places.
- **Refusals**: `locked`, `busy` (a court), `company` (someone near), `soon` (under 120 s alone, or since a fight) and `none` (no group to ride to).
- **It is offered, never forced.** After 120 s alone the alone hint offers "Ride the current" (R) for 12 s, then again every 2 minutes while the player stays alone. The menu offers it whenever the page thinks it is alone. Consolidation comes from both paths: every new life spawns at the best group, and riding is one key away.

### Crowd instances

- **Instances.** Every member of the directory has an instance:
  - 0 is the open water;
  - 1 to 65,535 are instances of crowds.

  Two creatures **share water** when their instances are equal or either is 0 (`sameWater`). Only creatures that share water link, engage, join a fight, court, or hear each other's carrion and proxies. The hub refuses the rest:
  - an engage or a join that doesn't share water with every fighter is refused `engage:instance`;
  - a court that doesn't share water gets `not-near`;
  - a signal between members that don't share water gets `no-peer`, except for a duty pair.

  So nothing hidden can affect a player.
- **Open water sees every instance.** A creature swimming toward a crowd sees its edge, every instance of it, and joins one when the hub hears of it. The crowd thins as it enters, instead of being invisible until its next report.
- **A page is crowded for instances** when it wants 24 links of P0 and P1 among the creatures it shares water with (`CROWD_AT`: past it no room is left for P2 to P4).
  - Its next `where` goes at once and carries its **crowd**: the ids of its engage candidates (within 8 × the larger radius, by its own snapshots), at most 32.
  - It repeats every 10 s while it stays crowded.
  - Only the page has exact positions, so the clients' lists, not the directory, tell which creatures are close.
- **A crowd forms** 3 s after a crowded report from open water with no crowd member within the reporter's P1 reach. The wait gathers the other lists, on a one-shot timer of the hub's clock, as a lock's deadline is.
  - Its members are the reporter and the open-water members the directory places within its P1 reach.
  - They are split into at least 2 instances, one more for every 16 members (`INSTANCE_MAX`).
- **Units are never separated.** A unit is:
  - the fighters of one fight, and a lock still waiting for its answer;
  - a court's two players;
  - every pair in a crowd list received in the last 10 s (from either side).

  Each unit goes whole into the least-full instance. A unit larger than 16 keeps one instance to itself, over-full: an explicit limit.
- **Membership is sticky.**
  - **Joining**: an open-water member whose report places it within P1 reach of a crowd's member joins that crowd. It takes, in this order:
    - the instance of its fight or court partner there;
    - else the instance holding most of its own crowd list, when that instance has room;
    - else the least-full instance.
  - **Leaving**: a member further than twice the P1 hold (2 × (8 × the larger radius + 900 wu)) from every other member of its crowd goes back to open water.
  - **More room**: a crowded report from inside a crowd adds an instance and re-bins, at most once per 10 s per crowd. A unit stays in its instance while that instance holds at most 16; overflow units move to the least-full one.
- **A locked creature's instance never changes.** Joins, leaves, re-splits and merges pass over a fighter until its fight ends, so an instance change can't end or escape a fight. A fighter whose page closes keeps its instance while its fight runs, and takes it back when it signs in again during the fight.
- **Merging when quiet.** A crowd merges back into the open water once all of these hold for 30 s (`QUIET_MS`):
  - it has had at most 16 members;
  - no crowd list came from its members;
  - none of them is locked.

  An empty crowd ends at once.
- **On the wire** (protocol 12):
  - the hub tells each member its own instance (`instance`) on every change;
  - `near` lists only members that share water, with their instance, and the swarm likewise;
  - a link's `hello` and an `instance` peer event carry the sender's instance;
  - each gossip entry carries one, so a page never dials a creature it can't share water with.
- **In the page.** When the page's own instance changes, links to creatures it no longer shares water with close at once, and those creatures fade out over 1 s, never in one frame. A toast says why, at most once a minute.
- **Rebuilt on a wake.** Each member's crowd and instance live in its attachment; quiet timers restart.
- **Duty links cross instances.** A witness's duty link may join creatures that don't share water (it is P0). Neither side draws the other over it.

### Budget

- `spawn`: one per life.
- `ride`: one per ride.
- Crowd lists: every 10 s, and only from crowded pages, which instances keep few.

The AoI harness and the population-wave simulation gate the median at 6 incoming messages per player-minute.

## Consequences

- **What works now.**
  - A newcomer arrives near players of its size, out of view of anything that could attack it, and linked at once when a friend is near.
  - Lone players are a key press from company.
  - A crowd of any size shows each page at most about 16 creatures of its instance plus the open water at its edge.
- **Teleports.** Every transition that moves a creature is anchored, so a reload, a ride or a spawn is not a teleport the client chooses.
- **Explicit limits.**
  - Placement trusts reports up to 30 s old; spawn protection covers a member that swam closer since.
  - A unit of more than 16 mutually close creatures stays together, over-full, and keeps `crowded` and `engage:unseen` as its guard.
  - An instance change is visible, as a fade, not seamless.
  - Food claims reach linked peers only, so each instance eats from its own copy of the food.
  - A client may claim another instance in its hello or gossip. That buys it only links the other side drops; the hub's checks use its own assignment.
- **Rejected**:
  - instancing a leaf by its member count (crowds span leaves; the harness's crowd never fills one);
  - one numbering per region (seams at region edges, and a creature crossing one would change instance);
  - binning a crowd at random or by position alone (it separates a chase);
  - teleporting lone players to groups automatically (disorienting: spawns and the offered ride suffice);
  - moving the spawn centre with the population (only the world's centre is always twilight and free of vents);
  - widening the clearance by a report's age (it pushes friends out of P1);
  - keeping where a creature left in memory (hibernation loses it);
  - open water that can't see instances (a creature entering a crowd would see nothing until its next report).
