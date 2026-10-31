// The eggs on screen (M6 T20, M6b T11): the beacon reveal at the screen's centre or beside the
// parent, the carried egg on its tether, the peers' eggs (from their snapshots' egg mark), and the hatch, where
// the child grows out of the shell and the parent dissolves where it stood. DOM-free: the shell says
// what happened and draws what this returns. Presentation only; nothing here touches the sim.

import type { RarityTier } from '../genome/rarity';
import type { CreatureSource } from '../render/creature-cache';
import {
  carriedPose,
  EGG,
  type EggPose,
  EggReveal,
  EggTether,
  type EggView,
  emptyPose,
  type TetherParent,
} from '../render/egg';
import { idFraction } from '../render/instances';
import type { RemoteCellView } from '../render/remotes';
import { clamp } from '../sim/math';
import { hatchling } from '../sim/mating';

/** What the reveal is for: a genesis's beacon, a mating's beacon, or hatching the carried child. */
export type EggMode = 'genesis' | 'mate' | 'hatch';

/** A peer as the eggs need it: where it is and whether its snapshots say it carries an egg. */
export interface EggRemote extends TetherParent {
  id: string;
  alpha: number;
  egg: boolean;
}

export interface EggFrame {
  /** Wall-clock milliseconds. */
  now: number;
  /** Seconds since the last frame. */
  dt: number;
  /** Reduced motion (the setting, else `prefers-reduced-motion`): the shake becomes a fade. */
  reduced: boolean;
  /** The creature the player's egg belongs to; null when none is drawn. */
  self: TetherParent | null;
  /**
   * Where a genesis egg sits: the screen's centre, with the egg's half-height there (a genesis
   * egg is alone on screen); null when nothing is drawn.
   */
  stage: TetherParent | null;
  /** The cursor in world units, or null when it has not moved; a waiting genesis egg leans toward it. */
  pointer: { x: number; y: number } | null;
  /** The player's pending child, or null. */
  child: { tier: RarityTier; maxBiomass: number } | null;
  remotes: readonly EggRemote[];
}

/** The parent a hatch leaves behind, drawn dissolving for `GHOST_MS`. */
export interface Ghost extends TetherParent {
  body: CreatureSource;
  hue: number;
}

/** A parent left behind by a hatch dissolves over this long, then nothing of it stays. */
export const GHOST_MS = 1000;
/** A hatched child's egg covers it, matching the carried egg it came from: its half-height in the child's radii. */
const COVER_HATCH = 1.15;
/** The lean toward the cursor eases in and out with this time constant (seconds). */
const LEAN_SECONDS = 0.15;
/** Before the child is known, a mating's egg is this share of the parent's radius. */
const UNKNOWN_EGG = 0.55;
/** A carried egg is a little larger than the hatchling inside, and never larger than this share of its parent. */
const CHILD_EGG = 1.1;
const MAX_EGG = 0.8;
/** A peer's egg, in the peer's radii. */
const PEER_EGG = 0.5;
const UP = Math.PI / 2;
const OWN_SEED = 0.37;

interface PeerEgg {
  tether: EggTether;
  pose: EggPose;
  view: EggView;
  frame: number;
}

const newView = (pose: EggPose, seed: number): EggView => ({
  x: 0,
  y: 0,
  radius: 1,
  heading: UP,
  pose,
  seed,
  parent: null,
});

export class EggShow {
  readonly reveal = new EggReveal();
  /** Whether the player's own egg was drawn by the last frame, and the peers drawn with one. */
  ownShown = false;
  readonly peerIds: string[] = [];
  private modeNow: EggMode | null = null;
  /** A hatch waiting for the hub: the egg stays where it was when H was pressed. */
  private frozen = false;
  /** The child of the last reveal, so a reveal plays once per child. */
  private revealedFor: string | null = null;
  private readonly ownParent: TetherParent = { x: 0, y: 0, heading: 0, radius: 1 };
  private readonly own = new EggTether();
  private readonly ownPose = emptyPose();
  private readonly ownView = newView(this.ownPose, OWN_SEED);
  private readonly hookPose = emptyPose();
  private readonly peers = new Map<string, PeerEgg>();
  private readonly out: EggView[] = [];
  private frameNo = 0;
  private ghost: Ghost | null = null;
  private ghostAt = 0;
  /** The waiting genesis egg's lean toward the cursor, in radians. */
  private lean = 0;
  private readonly ghostView: RemoteCellView & { body: CreatureSource | null } = {
    id: 'ghost',
    x: 0,
    y: 0,
    heading: 0,
    radius: 1,
    beat: 0,
    alpha: 1,
    hue: 0,
    body: null,
    dissolve: 0,
  };

  constructor(
    /** The shell bursts: where, how big, with how many rings, and for what. */
    private readonly onBurst: (
      x: number,
      y: number,
      radius: number,
      rings: number,
      mode: EggMode | null,
    ) => void,
    /** The beacon came and the egg begins to stir (its sound). */
    private readonly onStir: () => void = () => {},
  ) {}

  get mode(): EggMode | null {
    return this.modeNow;
  }

  /** The player's egg as last drawn (its `angle` includes the lean). */
  get pose(): Readonly<EggPose> {
    return this.ownPose;
  }

  /**
   * The player's egg's swing at `now`, the lean included, as the next frame would draw it: the test
   * hook reads it between frames, which a software-rendered page draws slowly.
   */
  angleAt(now: number, reduced: boolean): number {
    if (!this.ownShown) return 0;
    const { phase } = this.reveal;
    if (phase !== 'waiting' && phase !== 'stirring' && phase !== 'cracking')
      return this.ownPose.angle;
    return this.reveal.pose(now, reduced, this.hookPose).angle + this.lean;
  }

  /** A click on the waiting egg, or Space during a genesis: one wobble. False when no egg waits on screen. */
  poke(now: number): boolean {
    return this.ownShown && this.reveal.poke(now);
  }

  /** A click or Enter while the egg stirs or cracks: the burst comes now. */
  skip(now: number): boolean {
    return this.ownShown && this.reveal.skip(now);
  }

  /** Whether the small "Waiting for the beacon…" line shows under the player's egg. */
  waitLine(now: number): boolean {
    return this.ownShown && this.reveal.waitLine(now);
  }

  /** A genesis waits for its beacon (the title screen): the egg appears over the title cell. */
  awaitGenesis(now: number): void {
    if (this.modeNow === 'genesis' && this.reveal.phase === 'waiting') return;
    this.modeNow = 'genesis';
    this.reveal.wait(now);
  }

  /**
   * The genesis's beacon arrived: the egg stirs (by the rarity of the body the beacon gives, when
   * known), cracks, and holds until the creature hatches.
   */
  genesisBeacon(now: number, tier: RarityTier | null): void {
    if (this.modeNow !== 'genesis' || this.reveal.phase !== 'waiting') return;
    this.reveal.stir(now, { tier, opens: true, hold: true });
    this.onStir();
  }

  /** A mating waits for its beacon: the egg appears beside the parent. */
  awaitMate(now: number): void {
    if (this.modeNow === 'genesis' || this.modeNow === 'hatch') return;
    if (this.modeNow === 'mate' && this.reveal.phase === 'waiting') return;
    this.modeNow = 'mate';
    this.reveal.wait(now);
  }

  /** The mating's child is checked: its egg stirs, cracks and bursts by its rarity, once per child. */
  childRevealed(now: number, id: string, tier: RarityTier): void {
    if (this.revealedFor === id || this.modeNow === 'genesis' || this.modeNow === 'hatch') return;
    this.revealedFor = id;
    this.modeNow = 'mate';
    this.reveal.stir(now, { tier, opens: false });
    this.onStir();
  }

  /**
   * H: the carried egg cracks open and holds until the hub has hatched the child. `carried` is
   * false when the parent is gone (the death screen's choice): the child then hatches in the open.
   */
  hatchStart(now: number, tier: RarityTier, carried: boolean): void {
    this.modeNow = 'hatch';
    this.frozen = carried;
    this.reveal.crack(now, { tier, opens: true, hold: true });
  }

  /**
   * A life began. After a genesis or a hatch the creature grows out of the shell, and true says
   * so (the shell scales it by `emerge`); any other life (a resume, a return) shows no egg.
   */
  hatched(now: number, tier: RarityTier): boolean {
    const { reveal } = this;
    this.frozen = false;
    if (this.modeNow === 'genesis' || this.modeNow === 'hatch') {
      if ((reveal.phase === 'stirring' || reveal.phase === 'cracking') && reveal.opens) {
        reveal.setTier(tier);
        reveal.release();
        return true;
      }
      if (reveal.phase === 'waiting') {
        reveal.crack(now, { tier, opens: true });
        return true;
      }
    }
    this.cancel();
    return false;
  }

  /** A genesis or hatch that ended without a life: back to no egg (a carried one shows again). */
  cancel(): void {
    this.modeNow = null;
    this.frozen = false;
    this.reveal.reset();
  }

  /** The parent a hatch left where it stood: it dissolves over `GHOST_MS`. */
  leave(parent: Ghost, now: number): void {
    this.ghost = { ...parent };
    this.ghostView.id = `ghost:${parent.body.hash}`;
    this.ghostAt = now;
  }

  /** The dissolving parent to draw, or null once it is gone. */
  ghostOf(now: number): RemoteCellView | null {
    const { ghost } = this;
    if (!ghost) return null;
    const t = (now - this.ghostAt) / GHOST_MS;
    if (t >= 1) {
      this.ghost = null;
      return null;
    }
    const v = this.ghostView;
    v.x = ghost.x;
    v.y = ghost.y;
    v.heading = ghost.heading;
    v.radius = ghost.radius;
    v.hue = ghost.hue;
    v.body = ghost.body;
    v.dissolve = Math.max(0, t);
    v.alpha = 1 - Math.max(0, t) * 0.5;
    return v;
  }

  /** The player's egg as last drawn, or null when none is. */
  get drawn(): Readonly<EggView> | null {
    return this.ownShown ? this.ownView : null;
  }

  /** Where the player's egg is now: a hatch puts the child there. */
  ownAt(): { x: number; y: number } | null {
    return this.ownShown ? { x: this.ownView.x, y: this.ownView.y } : null;
  }

  /** The eggs to draw this frame. The array and its views are reused. */
  frame(input: EggFrame): readonly EggView[] {
    this.frameNo++;
    this.out.length = 0;
    const { reveal } = this;
    const { now } = input;
    const burst = reveal.update(now);
    const mode = this.modeNow;
    // A finished genesis or hatch lets go; a mating's reveal stays until the child is gone.
    if (reveal.opens && reveal.done(now)) this.modeNow = null;
    const self = this.modeNow === 'genesis' ? (input.stage ?? null) : input.self;
    this.ownShown = self !== null && this.ownEgg(input, self);
    if (this.ownShown) this.out.push(this.ownView);
    // The burst rings go where the egg is now (a genesis's egg has just left the title screen).
    if (burst && this.ownShown) {
      const rings = input.reduced ? 1 : EGG.burstRings[reveal.tier ?? 'common'];
      this.onBurst(this.ownView.x, this.ownView.y, this.ownView.radius, rings, mode);
    }
    this.peerEggs(input);
    return this.out;
  }

  private ownEgg(input: EggFrame, self: TetherParent): boolean {
    const { reveal } = this;
    const { now, child, reduced } = input;
    const phase = reveal.phase;
    const pose = this.ownPose;
    const revealing =
      phase === 'waiting' ||
      phase === 'stirring' ||
      phase === 'cracking' ||
      (phase === 'revealed' && (reveal.opens ? !reveal.done(now) : child !== null));
    if (revealing) reveal.pose(now, reduced, pose);
    else if (child) carriedPose(child.tier, pose);
    else return false;
    if (!pose.shown) return false;

    const view = this.ownView;
    const genesis = this.modeNow === 'genesis';
    this.leanToward(
      genesis && phase === 'waiting' && !reduced ? input.pointer : null,
      self,
      input.dt,
    );
    pose.angle += this.lean;
    const centred = genesis || (this.modeNow === 'hatch' && !this.frozen);
    if (centred) {
      view.x = self.x;
      view.y = self.y;
      view.radius = genesis ? self.radius : self.radius * COVER_HATCH;
      view.heading = UP;
      view.parent = null;
      this.own.drop();
      return true;
    }
    if (this.frozen) return true;
    const radius = child
      ? Math.min(MAX_EGG * self.radius, CHILD_EGG * Math.sqrt(hatchling(child.maxBiomass).biomass))
      : UNKNOWN_EGG * self.radius;
    this.own.follow(input.dt, self, radius);
    view.x = this.own.x;
    view.y = this.own.y;
    view.radius = radius;
    view.heading = Math.atan2(view.y - self.y, view.x - self.x);
    // A copy: a frozen hatch keeps the tether where it was while the live parent moves on.
    const parent = this.ownParent;
    parent.x = self.x;
    parent.y = self.y;
    parent.heading = self.heading;
    parent.radius = self.radius;
    view.parent = parent;
    return true;
  }

  /** Eases the lean toward a cursor within reach of the egg (none without one). */
  private leanToward(pointer: EggFrame['pointer'], egg: TetherParent, dt: number): void {
    let target = 0;
    if (pointer) {
      const dx = pointer.x - egg.x;
      const near = Math.hypot(dx, pointer.y - egg.y) <= EGG.leanReach * egg.radius;
      // The top tips toward the cursor's side: clockwise (negative) for one on the right.
      if (near) target = -EGG.lean * clamp(dx / (1.5 * egg.radius), -1, 1);
    }
    this.lean += (target - this.lean) * (1 - Math.exp(-Math.max(0, dt) / LEAN_SECONDS));
    if (target === 0 && Math.abs(this.lean) < 1e-4) this.lean = 0;
  }

  private peerEggs(input: EggFrame): void {
    this.peerIds.length = 0;
    for (const r of input.remotes) {
      if (!r.egg || r.alpha < 0.01) continue;
      let peer = this.peers.get(r.id);
      if (!peer) {
        const pose = carriedPose(null, emptyPose());
        peer = { tether: new EggTether(), pose, view: newView(pose, idFraction(r.id)), frame: 0 };
        this.peers.set(r.id, peer);
      }
      peer.frame = this.frameNo;
      const radius = PEER_EGG * r.radius;
      peer.tether.follow(input.dt, r, radius);
      peer.pose.alpha = r.alpha;
      const { view } = peer;
      view.parent = r;
      view.x = peer.tether.x;
      view.y = peer.tether.y;
      view.radius = radius;
      view.heading = Math.atan2(view.y - r.y, view.x - r.x);
      this.out.push(view);
      this.peerIds.push(r.id);
    }
    if (this.peers.size > this.peerIds.length) {
      for (const [id, peer] of this.peers) if (peer.frame !== this.frameNo) this.peers.delete(id);
    }
  }
}
