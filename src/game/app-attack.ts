// Attack on the play screen (M7 T11): F and the card's Attack button engage, an "F" glyph marks
// the creature F would take, protected creatures shimmer, and while locked 1-3 set the stance and
// Shift or the right button braces. The rules of who can be engaged live in `engage.ts`.

import { fighterOf } from '../genome/fighter';
import { starterGenome } from '../genome/starter';
import { buildCreature, type Creature } from '../genome/stats';
import type { Reacher } from '../sim/encounter/reach';
import type { CreatureState } from '../sim/types';
import type { App } from './app';
import { pick, setText } from './dom';
import {
  Attack,
  type AttackPeer,
  engageRefusal,
  fightKey,
  hintTarget,
  offered,
  ProtectionWatch,
  refusalToast,
} from './engage';
import { type LabelProjection, placeAt, screenX, screenY } from './labels';

/** A click or the cursor this close (CSS pixels) to a creature's centre points at it, however small. */
const PICK_PX = 24;
/** The shimmer's ring sits this many radii from a protected creature's centre. */
const SHIMMER_RADII = 1.35;
/** Refusal toasts are short. */
const TOAST_MS = 2500;

type Stats = Pick<Reacher, 'combat'> & { phys: CreatureState['phys'] };

/** What the attack shows, for `state().attack`. */
export interface AttackView {
  /** The id the "F" glyph marks, or null. */
  hint: string | null;
  /** The ids drawn with the protection shimmer. */
  shimmer: string[];
  /** An engage is out and unanswered. */
  waiting: boolean;
}

export class AttackUi {
  readonly attack: Attack;
  private readonly watch = new ProtectionWatch();
  private readonly marks = pick('[data-testid="attack-marks"]');
  private readonly glyph = pick('[data-testid="attack-hint"]');
  private readonly cardButton = pick<HTMLButtonElement>('[data-testid="inspect-attack"]');
  private readonly cardWhy = pick('[data-testid="inspect-attack-why"]');
  private readonly shimmers: HTMLElement[] = [];
  /** Peers as the attack sees them, reused frame to frame by id. */
  private readonly pool = new Map<string, AttackPeer>();
  private readonly peerList: AttackPeer[] = [];
  /** Combat stats by genome hash, built once each. */
  private readonly stats = new Map<string, Stats>();
  private starter: Stats | null = null;
  private own: { creature: Creature; stats: Stats } | null = null;
  private readonly view: AttackView = { hint: null, shimmer: [], waiting: false };

  constructor(private readonly app: App) {
    this.attack = new Attack({
      self: () => this.self(),
      peers: () => this.peers(),
      cursor: () => {
        const at = app.controller.pointerAt();
        if (!at) return null;
        const world = app.worldAt(at.x, at.y);
        return { x: world.x, y: world.y, pick: PICK_PX / app.scene.pxPerWu };
      },
      engage: (target) => {
        const theirs = app.online.signed.latest(target);
        const mine = theirs ? app.online.signedNow() : null;
        return theirs && mine ? { t: 'engage', target, mine, theirs } : null;
      },
      send: (msg) => app.keeper.current?.send(msg),
      ring: () => {
        const { player } = app.session;
        app.fx.engagePulse({ x: player.x, y: player.y, radius: Math.sqrt(player.biomass) });
      },
      endShield: () => app.online.shield.end(),
      toast: (text) => app.hud.toast(text, TOAST_MS),
      nowMs: () => performance.now(),
      protectedLeft: (id) => this.watch.leftSeconds(id, performance.now()),
    });
    this.cardButton.addEventListener('click', () => {
      if (app.inspected) this.attack.press(app.inspected);
    });
    // The right button braces in a fight, so the canvas never opens the browser's menu.
    app.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    app.canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 2 && !app.controller.typing) app.fight.brace();
    });
  }

  /** The own creature as the reach rules see it, while it may engage: a recorded life, online, out of any fight. */
  private self(): Reacher | null {
    const { app } = this;
    const { session } = app;
    const live = app.livePond();
    const life = app.flow.view();
    if (
      !app.playing() ||
      !session.player.alive ||
      app.fight.fighting ||
      !live ||
      live !== app.pond ||
      app.keeper.current?.status !== 'online' ||
      life.status !== 'playing' ||
      !life.creature
    ) {
      return null;
    }
    const { creature } = session.body;
    if (this.own?.creature !== creature) this.own = { creature, stats: fighterOf(creature) };
    return { body: session.player, combat: this.own.stats.combat };
  }

  private statsOf(body: Creature | null, hash: string | null): Stats {
    if (!body || !hash) {
      this.starter ??= fighterOf(buildCreature(starterGenome()));
      return this.starter;
    }
    let stats = this.stats.get(hash);
    if (!stats) {
      stats = fighterOf(body);
      this.stats.set(hash, stats);
    }
    return stats;
  }

  /** The pond peers drawn now, as the attack sees them (bodies of the drawn size and place). */
  private peers(): readonly AttackPeer[] {
    const { pool, peerList, app } = this;
    peerList.length = 0;
    for (const r of app.remoteViews) {
      if (!offered(r)) continue;
      const stats = this.statsOf(r.body, r.genomeHash);
      let peer = pool.get(r.id);
      if (!peer) {
        const body: CreatureState = {
          id: r.id,
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          heading: 0,
          biomass: 1,
          energy: 1,
          health: 1,
          dashReadyTick: 0,
          alive: true,
          elder: false,
          cause: null,
          bornTick: 0,
          phys: stats.phys,
        };
        peer = {
          id: r.id,
          reacher: { body, combat: stats.combat },
          protected: false,
          fighting: false,
          signed: false,
        };
        pool.set(r.id, peer);
      }
      const { body } = peer.reacher;
      body.x = r.x;
      body.y = r.y;
      body.heading = r.heading;
      body.biomass = r.radius * r.radius;
      body.phys = stats.phys;
      peer.reacher.combat = stats.combat;
      peer.protected = r.spawnProtected;
      peer.fighting = r.fighting;
      peer.signed = app.online.signed.latest(r.id) !== null;
      peerList.push(peer);
    }
    if (pool.size !== peerList.length) {
      const live = new Set(peerList.map((p) => p.id));
      for (const id of pool.keys()) if (!live.has(id)) pool.delete(id);
    }
    return peerList;
  }

  /** A fresh key press; true when it was a combat key (F, or 1-3, Shift and Tab while locked). */
  key(key: string): boolean {
    const { app } = this;
    const routed = fightKey(key, app.fight.fighting, app.wheel.isOpen);
    if (!routed) return false;
    if (routed.t === 'attack') this.attack.press();
    else if (routed.t === 'stance') app.fight.stance = routed.stance;
    else if (routed.t === 'target') app.fight.cycleTarget();
    else app.fight.brace();
    return true;
  }

  refused(reason: string): void {
    this.attack.refused(reason);
  }

  started(): void {
    this.attack.started();
  }

  get waiting(): boolean {
    return this.attack.waiting;
  }

  /** Each frame: the "F" glyph, the protection shimmers and the card's Attack button. */
  update(p: LabelProjection): void {
    const { app, view } = this;
    const now = performance.now();
    const remotes = app.remoteViews;
    this.watch.update(remotes, now);
    const self = this.self();
    const peers = self ? this.peers() : [];
    const hint = self ? hintTarget(self, peers) : null;
    view.hint = hint?.id ?? null;
    view.waiting = this.attack.waiting;
    const target = hint ? remotes.find((r) => r.id === hint.id) : undefined;
    if (target) {
      const r = target.radius * p.pxPerWu;
      placeAt(
        this.glyph,
        screenX(target.x, p) + r * 0.8 + 10,
        screenY(target.y, p) - r * 0.8 - 6,
        'centre',
      );
    }
    if (this.glyph.hidden !== !target) this.glyph.hidden = !target;
    // A protected creature shimmers faintly for anyone playing, fighter or not.
    view.shimmer.length = 0;
    const shown = app.playing();
    for (const r of remotes) {
      if (!shown || !r.spawnProtected || r.alpha < 0.01) continue;
      const element = this.shimmerAt(view.shimmer.length);
      view.shimmer.push(r.id);
      const size = `${Math.round(2 * SHIMMER_RADII * r.radius * p.pxPerWu)}px`;
      if (element.style.width !== size) {
        element.style.width = size;
        element.style.height = size;
      }
      element.hidden = false;
      element.style.opacity = String(Math.round(r.alpha * 100) / 100);
      placeAt(element, screenX(r.x, p), screenY(r.y, p), 'centre');
    }
    for (let i = view.shimmer.length; i < this.shimmers.length; i++) {
      const element = this.shimmers[i] as HTMLElement;
      if (!element.hidden) element.hidden = true;
    }
    this.updateCard(self, peers);
  }

  /** The inspect card's Attack button: shown while the player could fight, disabled with the reason. */
  private updateCard(self: Reacher | null, peers: readonly AttackPeer[]): void {
    const { app, cardButton, cardWhy } = this;
    const peer = self && app.inspected ? peers.find((p) => p.id === app.inspected) : undefined;
    const hidden = !self || !peer;
    if (cardButton.hidden !== hidden) cardButton.hidden = hidden;
    let why = '';
    if (self && peer) {
      const refusal = engageRefusal(self, peer);
      if (refusal) {
        const left =
          refusal === 'protected' ? this.watch.leftSeconds(peer.id, performance.now()) : null;
        why = refusalToast(refusal, left);
      }
    }
    const disabled = why !== '' || this.attack.waiting;
    if (cardButton.disabled !== disabled) cardButton.disabled = disabled;
    setText(cardWhy, why);
    if (cardWhy.hidden !== (hidden || why === '')) cardWhy.hidden = hidden || why === '';
  }

  private shimmerAt(index: number): HTMLElement {
    let element = this.shimmers[index];
    if (!element) {
      element = document.createElement('span');
      element.className = 'shield-shimmer';
      element.dataset.testid = 'shield-shimmer';
      element.hidden = true;
      this.marks.append(element);
      this.shimmers[index] = element;
    }
    return element;
  }

  /** What `state().attack` shows. */
  info(): AttackView {
    return { hint: this.view.hint, shimmer: [...this.view.shimmer], waiting: this.view.waiting };
  }
}
