import { silhouetteOf } from '../genome/silhouette';
import { snapshotOf } from '../net/pond-sync';
import type { Member, Vec2 } from '../net/protocol';
import type { CellView } from '../render/cell';
import type { CreatureSource } from '../render/creature-cache';
import type { RemoteCellView } from '../render/remotes';
import { sightRadius } from '../render/zones';
import { depthAt, zoneOfDepth } from '../sim/bathymetry';
import { currentAt } from '../sim/currents';
import { lerp, wrapAngle } from '../sim/math';
import { RULES, TICK_HZ } from '../sim/rules';
import type { App } from './app';
import { adultRadius, MAX_THROTTLE, type Scripted } from './app-session';
import type { Body } from './body';
import { pick } from './dom';
import type { EggShow } from './eggs';
import { edgeIndicators, type Indicator } from './indicators';
import type { LabelProjection } from './labels';
import type { MinimapView } from './minimap';
import type { DrawnRemote } from './remote-bodies';
import type { Anchor } from './social-ui';
import { zoneReadout } from './zone-readout';

const MAX_FRAME_SECONDS = 0.1;
/** The body's red pulse above this flashes the health bar too (M6b T10). */
const HURT_FLASH = 0.05;
/** The most sim ticks of water flow one frame integrates: a stalled tab must not fling the snow. */
const MAX_FLOW_TICKS = TICK_HZ;
const NO_REMOTES: readonly DrawnRemote[] = [];
const NO_MEMBERS: readonly Member[] = [];
/** A genesis egg's half-height, as a share of the view's half-height: alone at the centre (M6b T11). */
const GENESIS_EGG = 0.26;

/** One drawn frame: the camera, the cues, the eggs, the snapshot out and every on-screen layer. */
export class Frame {
  readonly view: {
    time: number;
    camX: number;
    camY: number;
    halfHeight: number;
    creature: CellView | null;
    body: CreatureSource | null;
    remotes: readonly RemoteCellView[];
    rings: App['fx']['rings'];
    eggs: ReturnType<EggShow['frame']>;
    sight: number;
    flow: { x: number; y: number };
  };
  readonly cell: CellView = {
    x: 0,
    y: 0,
    heading: 0,
    radius: 1,
    beat: 0,
    hurt: 0,
    dissolve: 0,
    scale: 1,
  };
  /** The remotes plus a parent dissolving after a hatch; reused. */
  private readonly withGhost: RemoteCellView[] = [];
  /** World to screen for the labels, indicators and social cues; reused every frame. */
  private readonly projection: LabelProjection = {
    camX: 0,
    camY: 0,
    pxPerWu: 1,
    width: 1,
    height: 1,
  };
  /** The pending child as the eggs need it; reused. */
  private readonly eggChild = { tier: 'common' as Body['rarity'], maxBiomass: 1 };
  /** Where a genesis egg sits; reused. */
  private readonly eggStage = { x: 0, y: 0, heading: Math.PI / 2, radius: 1 };
  /** The player's egg on screen: CSS-pixel centre and half-height, for the hook and the waiting line. */
  readonly eggAt = { x: 0, y: 0, r: 0 };
  eggOnScreen = false;
  private readonly eggWait = pick('[data-testid="egg-wait"]');
  private eggWaitShown = false;
  private eggMomentShown = false;
  /** The cursor in world units while a genesis egg waits: one object, written each frame. */
  private readonly eggPointer: Vec2 = { x: 0, y: 0 };
  private flowTick = 0;
  private beat = 0;
  private readonly marks = { ready: false, egg: false };
  private readonly anchors = new Map<string, Anchor>();
  /** The edge arrows as last drawn. */
  indicators: Indicator[] = [];
  /** The player's body as drawn: the cell, moved by the damage shake (the HUD and labels follow `cell`). */
  private readonly drawnCell: CellView = { ...this.cell };
  /** What the minimap shows (M6b T10); refreshed every frame, drawn at most 10 times a second. */
  private readonly minimapView: MinimapView;

  constructor(private readonly app: App) {
    this.view = {
      time: 0,
      camX: 0,
      camY: 0,
      halfHeight: 1,
      creature: null,
      body: null,
      remotes: [],
      rings: app.fx.rings,
      eggs: [],
      sight: 1,
      flow: { x: 0, y: 0 },
    };
    this.minimapView = {
      seed: app.session.world.seed32,
      size: app.session.world.size,
      self: { x: 0, y: 0, heading: 0, radius: 1 },
      halfHeight: 1,
      aspect: 1,
      players: NO_REMOTES,
      pings: [],
      readout: null,
    };
  }

  /** A genesis egg on the title or death screen: the egg is the moment, and nothing covers it (M6b T11). */
  private genesisMoment(): boolean {
    return this.app.eggs.mode === 'genesis' && this.app.screen !== 'playing';
  }

  /**
   * The egg (M6 T20): a genesis waits on the title screen, a mating beside the parent; the child's
   * check cracks it; a pending child is carried. Returns the eggs to draw.
   */
  private updateEggs(now: number, dt: number, reduced: boolean): ReturnType<EggShow['frame']> {
    const { app, eggChild, eggStage } = this;
    const { eggs, flow, offspring, camera, scene } = app;
    const { hatching } = app.life;
    const status = flow.state;
    if (hatching && status === 'awaiting') eggs.awaitGenesis(now);
    else if (hatching && status === 'verifying' && eggs.reveal.phase === 'waiting')
      eggs.genesisBeacon(now, app.life.arrivingTier());
    // A hatch that ended without a life (a failed check, a wait for the next hatch) takes its egg
    // away, on the death screen too, where it would hide the way back.
    else if (!hatching && this.genesisMoment()) eggs.cancel();
    const playingNow = app.playing();
    const kid = offspring.view();
    if (playingNow && app.mateNow === 'awaiting') eggs.awaitMate(now);
    else if (kid.kind === 'egg')
      eggs.childRevealed(now, kid.child.born.record.hash, kid.child.body.rarity);
    else if (eggs.mode === 'mate' && eggs.reveal.phase === 'waiting' && kid.kind !== 'verifying') {
      // The mating ended without a child to show (a failed check, a lost connection).
      eggs.cancel();
    }
    // While a genesis egg is on the title or death screen, the screen steps aside: the egg is the moment.
    const eggMoment = this.genesisMoment();
    if (this.eggMomentShown !== eggMoment) {
      this.eggMomentShown = eggMoment;
      document.body.toggleAttribute('data-egg', eggMoment);
    }
    const alive = playingNow && app.session.player.alive;
    const child = offspring.child();
    if (child) {
      eggChild.tier = child.body.rarity;
      eggChild.maxBiomass = child.body.creature.stats.maxBiomass;
    }
    // A genesis egg sits alone at the screen's centre, its size a share of the view.
    eggStage.x = camera.x;
    eggStage.y = camera.y;
    eggStage.radius = GENESIS_EGG * camera.halfHeight;
    let pointer: Vec2 | null = null;
    if (eggs.mode === 'genesis' && eggs.reveal.phase === 'waiting') {
      const at = app.controller.pointerAt();
      if (at) {
        pointer = this.eggPointer;
        pointer.x = camera.x + (at.x - scene.width / 2) / scene.pxPerWu;
        pointer.y = camera.y - (at.y - scene.height / 2) / scene.pxPerWu;
      }
    }
    return eggs.frame({
      now,
      dt,
      reduced,
      self: alive ? this.cell : null,
      stage: eggs.mode === 'genesis' ? eggStage : null,
      pointer,
      child: alive && child ? eggChild : null,
      remotes: playingNow ? app.remoteViews : NO_REMOTES,
    });
  }

  /** Places the player's egg on screen and the waiting line under it. */
  private placeEgg(now: number): void {
    const { app, eggAt, eggWait, view } = this;
    const { scene } = app;
    const own = app.eggs.drawn;
    this.eggOnScreen = own !== null;
    if (own) {
      eggAt.x = (own.x - view.camX) * scene.pxPerWu + scene.width / 2;
      eggAt.y = scene.height / 2 - (own.y - view.camY) * scene.pxPerWu;
      eggAt.r = own.radius * scene.pxPerWu;
    }
    const line = app.eggs.waitLine(now);
    if (line !== this.eggWaitShown) {
      this.eggWaitShown = line;
      eggWait.hidden = !line;
    }
    if (line) {
      const x = Math.round(eggAt.x - eggWait.offsetWidth / 2);
      const y = Math.round(eggAt.y + eggAt.r * 1.15);
      const transform = `translate(${x}px, ${y}px)`;
      if (eggWait.style.transform !== transform) eggWait.style.transform = transform;
    }
  }

  /** A scripted remote's snapshot goes through the real codec and into the set, as a peer's would. */
  private feedScripted({ spec, sender, startedMs, ref }: Scripted, now: number): void {
    sender.update(now, false, () => {
      const seconds = (now - startedMs) / 1000;
      const vx = spec.vx ?? 0;
      const vy = spec.vy ?? 0;
      return {
        tick: Math.round((this.app.pondMs() * TICK_HZ) / 1000),
        x: spec.x + vx * seconds,
        y: spec.y + vy * seconds,
        heading: Math.atan2(vy, vx),
        vx,
        vy,
        biomass: spec.biomass ?? RULES.starter.biomass,
        energy: 1,
        health: 1,
        alive: true,
        dashing: false,
        ready: spec.ready === true,
        egg: spec.egg === true,
        genomeRef: ref,
      };
    });
  }

  render(alpha: number): void {
    const { app, view, cell, drawnCell, minimapView, projection } = this;
    const { camera, scene, fx, shake, eggs, hud, sound, keeper, social, pondMap, wheel } = app;
    const now = performance.now();
    const elapsed = (now - app.lastMs) / 1000;
    const dt = Math.min(elapsed, MAX_FRAME_SECONDS);
    if (app.scale === 0) app.heldMs += now - app.lastMs;
    app.lastMs = now;
    // Play waits for a genesis egg's stir and crack (M6b T11): the frame that finds it ripe begins
    // the life before it draws anything, so the shell bursts in this frame.
    if (app.life.ripeWaiter && eggs.reveal.ripe(now - app.heldMs)) app.life.ripeWaiter();
    const { player } = app.session;
    const { prev } = app;

    cell.x = lerp(prev.x, player.x, alpha);
    cell.y = lerp(prev.y, player.y, alpha);
    cell.heading = prev.heading + wrapAngle(player.heading - prev.heading) * alpha;
    cell.radius = Math.sqrt(player.biomass);
    this.beat = lerp(this.beat, app.input.throttle / MAX_THROTTLE, Math.min(1, dt * 6));
    cell.beat = this.beat;

    camera.update(dt, {
      x: cell.x,
      y: cell.y,
      radius: cell.radius,
      adult: adultRadius(player),
    });
    // Shaders animate on wall-clock time; a frozen world holds still, so `render.specks` matches a shot.
    view.time = (now - app.heldMs) / 1000;
    view.camX = camera.x;
    view.camY = camera.y;
    view.halfHeight = camera.halfHeight;
    // The water's flow carries the marine snow (M6 T17). It follows sim ticks, so a frozen world
    // holds it still and a new life (the tick starts over) leaves it as it is.
    const flowTicks = app.session.world.tick - this.flowTick;
    this.flowTick = app.session.world.tick;
    if (flowTicks > 0 && flowTicks <= MAX_FLOW_TICKS) {
      const water = currentAt(app.session.world, camera.x, camera.y);
      view.flow.x += (water.x * flowTicks) / TICK_HZ;
      view.flow.y += (water.y * flowTicks) / TICK_HZ;
    }
    // Cues run on wall-clock time: a slow frame must not stretch the dissolve. An exotic egg's
    // burst runs them in slow motion for a moment (M6 T20).
    const reduced = app.motionReduced();
    const eggNow = now - app.heldMs;
    fx.update(elapsed * eggs.reveal.slowFactor(eggNow, reduced));
    // The drawn size: the shrink of a mating's cost, and a hatchling's pop out of its egg.
    const emerge = app.session === app.emerging ? eggs.reveal.emerge(eggNow) : 1;
    cell.scale = (fx.drawnRadius(cell.radius) / cell.radius) * emerge;
    cell.hurt = fx.hurt;
    cell.dissolve = fx.dissolve;
    // The shake moves only what the scene draws: the body and the camera, never the sim or the DOM.
    shake.update(dt, reduced);
    const shift = cell.radius * cell.scale;
    const shaking = shake.body.x !== 0 || shake.body.y !== 0;
    if (shaking) {
      Object.assign(drawnCell, cell);
      drawnCell.x = cell.x + shake.body.x * shift;
      drawnCell.y = cell.y + shake.body.y * shift;
    }
    view.camX = camera.x + shake.camera.x / scene.pxPerWu;
    view.camY = camera.y + shake.camera.y / scene.pxPerWu;
    // A genesis egg is alone on screen: the title cell steps out of the way.
    view.creature = fx.dissolved || this.genesisMoment() ? null : shaking ? drawnCell : cell;
    view.sight = sightRadius(app.session.body.creature.stats.sense, cell.radius);
    hud.setHurt(fx.hurt > HURT_FLASH);
    minimapView.readout = null;
    if (!app.session.demo) {
      const { world } = app.session;
      const depth = depthAt(world.seed32, player.x, player.y);
      const readout = zoneReadout(depth, player.phys, world.options.hazards && player.alive);
      hud.setZone(readout);
      minimapView.readout = readout;
      sound.setZone(zoneOfDepth(depth), depth);
    }
    sound.setListener(camera.x, camera.y, scene.width / 2 / scene.pxPerWu);
    // The death screen waits for the body to dissolve, so the player sees what killed them.
    if (app.session.death !== null && fx.dissolved && app.screen === 'playing') {
      app.screen = 'dead';
      app.screenShownAt = now;
      app.screens.showDeath(app.session.death);
    }
    for (const script of app.scripted) this.feedScripted(script, now);
    const joined = app.livePond();
    if (joined && joined === app.pond && (keeper.current?.openCount() ?? 0) > 0) {
      app.sender.update(now, document.hidden, () => {
        this.marks.ready = app.mateReady;
        // Peers see the egg from the commitment on, as the owner does (M6 T20).
        this.marks.egg = app.offspring.child() !== null || app.mateNow === 'awaiting';
        return snapshotOf(player, app.session.world.tick, app.session.body.ref, this.marks);
      });
    }
    // A local pond life does not show the players of the hub's pond.
    app.remoteViews =
      !keeper.current || joined
        ? app.remoteBodies.resolve(app.remotes.sample(now, app.pondMs()), now)
        : NO_REMOTES;
    const { remoteViews } = app;
    app.online.updateNetUi(now, joined);
    app.ui.updateHatchNote();
    app.ui.updateMateUi();
    app.ui.updateOffspringUi();
    app.ui.updateHint();
    view.eggs = this.updateEggs(eggNow, dt, reduced);
    this.placeEgg(eggNow);
    if (app.cardDue && (app.cardDue !== app.session || app.screen !== 'playing')) {
      app.cardDue = null;
    }
    if (app.cardDue && eggs.mode !== 'genesis') {
      app.cardDue = null;
      app.revealCard.show(app.session.body, silhouetteOf(app.session.body.creature.plan), now);
    }
    app.revealCard.update(now, app.screen === 'playing' && !app.session.demo);
    const ghost = eggs.ghostOf(eggNow);
    if (ghost) {
      this.withGhost.length = 0;
      for (const r of remoteViews) this.withGhost.push(r);
      this.withGhost.push(ghost);
      view.remotes = this.withGhost;
    } else {
      view.remotes = remoteViews;
    }
    projection.camX = camera.x;
    projection.camY = camera.y;
    projection.pxPerWu = scene.pxPerWu;
    projection.width = scene.width;
    projection.height = scene.height;
    app.labels.update(remoteViews, projection);
    const finding = app.playing() && app.session.player.alive;
    this.indicators = finding ? edgeIndicators(cell, remoteViews, social.pings(), projection) : [];
    app.indicatorsUi.update(this.indicators, projection);
    if (finding) {
      minimapView.seed = app.session.world.seed32;
      minimapView.size = app.session.world.size;
      minimapView.self.x = cell.x;
      minimapView.self.y = cell.y;
      minimapView.self.heading = cell.heading;
      minimapView.self.radius = cell.radius;
      minimapView.halfHeight = camera.halfHeight;
      minimapView.aspect = scene.width / Math.max(1, scene.height);
      minimapView.players = remoteViews;
      minimapView.pings = social.pings();
      app.minimap.update(now, minimapView);
    }
    if (!finding) pondMap.close();
    else if (pondMap.isOpen) {
      pondMap.update({
        seed: app.session.world.seed32,
        size: app.session.world.size,
        self: {
          id: app.selfKey(),
          name: social.selfName,
          x: cell.x,
          y: cell.y,
          ready: app.mateReady,
        },
        players: remoteViews,
        pings: social.pings(),
      });
    }
    if (!finding) wheel.cancel();
    app.wheelUi.update(wheel.isOpen ? app.controller.pointerAt() : null);
    if (app.screen === 'playing') {
      const { anchors } = this;
      anchors.clear();
      anchors.set(app.selfKey(), { x: cell.x, y: cell.y, radius: cell.radius });
      for (const r of remoteViews) if (r.alpha >= 0.01) anchors.set(r.id, r);
      app.socialUi.update(now, anchors, keeper.current?.others() ?? NO_MEMBERS, projection);
    }
    app.field.flush();
    scene.draw(view);
  }
}
