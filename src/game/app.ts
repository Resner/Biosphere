import { indexedDbKeyStore } from '../ledger/idb-keystore';
import { createIdentity, memoryKeyStore } from '../ledger/identity';
import { PondClock } from '../net/clock';
import { RemoteSet, type RemoteView, SnapshotSender } from '../net/pond-sync';
import { decodeSnapshot, type PeerEvent, parsePeerEvent } from '../net/protocol';
import { FollowCamera, viewHalfHeight } from '../render/camera';
import type { CellView } from '../render/cell';
import { Effects } from '../render/effects';
import { GameScene } from '../render/scene';
import { foodNear } from '../sim/food';
import { plumesNear } from '../sim/hazards';
import { angleToSteer, IDLE, type Input } from '../sim/input';
import { atan2, lerp, wrapAngle } from '../sim/math';
import { replay } from '../sim/replay';
import { RULES, TICK_HZ } from '../sim/rules';
import { findClearSpot } from '../sim/spawn';
import { step } from '../sim/step';
import type { CreatureState, FoodItem, StepEvent, World } from '../sim/types';
import { maxEnergy, maxHealth, starterEnergy } from '../sim/vitals';
import { createWorld, spawnCreature } from '../sim/world';
import { type BsDebug, installHook, type ScriptedRemote } from './debug';
import { pick } from './dom';
import { createFieldSync } from './field';
import { Hud } from './hud';
import { enterHatches, InputController } from './input';
import { RemoteLabels } from './labels';
import { attachVisibilityPause, createLoop } from './loop';
import { PondFood } from './pond-food';
import { PondTime } from './pond-time';
import { type DeathSummary, type Screen, Screens } from './screens';

export interface GameParams {
  seed: string;
  debug: boolean;
}

/** Food drifts up to this far from its slot anchor; the field query reaches that much further. */
const FIELD_MARGIN = RULES.food.driftRadius + RULES.food.kinds.globule.radius;
const MAX_FRAME_SECONDS = 0.1;
/** `debug.steerTo` gives up after this many ticks (30 s). */
const STEER_TIMEOUT_TICKS = 30 * TICK_HZ;
/** With `timeScale`, a slow software-GL frame must still catch up: 120 ticks is 4 s of sim. */
const DEBUG_MAX_TICKS_PER_FRAME = 120;
const MAX_THROTTLE = RULES.movement.maxThrottle;

/** One creature in one world: the title screen's drifting cell, or a real hatch. */
interface Session {
  world: World;
  player: CreatureState;
  /** The title screen's cell: harmless, fed, and steered by a script. */
  demo: boolean;
  counts: Record<string, number>;
  peakBiomass: number;
  death: DeathSummary | null;
}

interface Steering {
  target: { id?: string; x: number; y: number };
  ticksLeft: number;
  done(reached: boolean): void;
}

/** The pond this tab has joined: one seed, one clock and one set of eaten food for every life. */
interface Pond {
  seed: string;
  time: PondTime;
  food: PondFood;
  /** Stands in for the world when a food event arrives between lives; never stepped. */
  world: World;
}

function newSession(seed: string, demo: boolean, pond: Pond | null = null): Session {
  const world = createWorld({ seed: demo ? `${seed}/title` : seed, hazards: !demo });
  if (pond) {
    world.consumed = pond.world.consumed;
    pond.time.join(world, performance.now());
  }
  const spot = findClearSpot(world, world.size / 2, world.size / 2);
  const player = spawnCreature(world, { id: 'player', ...spot });
  return { world, player, demo, counts: {}, peakBiomass: player.biomass, death: null };
}

/** Starts the title screen; the player hatches into the same scene. */
export function startApp(canvas: HTMLCanvasElement, params: GameParams): void {
  const scene = new GameScene(canvas, RULES.world.size);
  const camera = new FollowCamera();
  const controller = new InputController();
  const hud = new Hud();
  const fx = new Effects();
  const vignette = pick('[data-testid="vignette"]');
  const labels = new RemoteLabels(pick('[data-testid="remote-labels"]'));

  // Other players, drawn from the snapshots they send. The pond clock arrives with the online
  // session; until then pond time is this tab's own clock.
  const remotes = new RemoteSet();
  const pondMs = (): number => performance.now();
  let remoteViews: readonly RemoteView[] = [];
  interface Scripted {
    spec: ScriptedRemote;
    sender: SnapshotSender;
    startedMs: number;
  }
  let scripted: Scripted[] = [];

  // Without IndexedDB (a private window, say) the identity lasts for this visit only.
  let playerId: string | null = null;
  createIdentity(indexedDbKeyStore())
    .catch(() => createIdentity(memoryKeyStore()))
    .then((identity) => {
      playerId = identity.playerId;
    });

  // Set once a pond is joined (T13 wires the hub; until then tests join through `debug.joinPond`).
  let pond: Pond | null = null;
  let scale = 1;
  let session = newSession(params.seed, true);
  let screen: Screen = 'title';
  let food: FoodItem[] = [];
  let input: Input = IDLE;
  let beat = 0;
  let screenShownAt = 0;
  let steering: Steering | null = null;
  const prev = { x: 0, y: 0, heading: 0 };

  const refreshField = (): void => {
    const { world, player } = session;
    const radius = Math.sqrt(player.biomass);
    const half = Math.max(camera.halfHeight, viewHalfHeight(radius));
    const reach = Math.hypot(half * scene.aspect, half) + FIELD_MARGIN;
    food = foodNear(world, player.x, player.y, reach);
    scene.setField(food, plumesNear(world, player.x, player.y, reach));
  };

  const field = createFieldSync(refreshField);

  const enter = (next: Session, nextScreen: Screen): void => {
    session = next;
    fx.reset();
    controller.reset();
    steering?.done(false);
    steering = null;
    const { player } = session;
    prev.x = player.x;
    prev.y = player.y;
    prev.heading = player.heading;
    camera.snap({ x: player.x, y: player.y, radius: Math.sqrt(player.biomass) });
    scene.setHalfHeight(camera.halfHeight);
    field.now();
    hud.update(player);
    screen = nextScreen;
    screenShownAt = performance.now();
    screens.show(nextScreen);
  };

  // The first hatch uses the pond seed as given; each later one gets its own pond.
  let hatches = 0;
  const hatch = (): void => {
    const seed = hatches === 0 ? params.seed : `${params.seed}/${hatches}`;
    hatches++;
    enter(newSession(pond ? pond.seed : seed, false, pond), 'playing');
  };
  const screens = new Screens({ hatch });
  // Enter hatches from the title and death screens (Space stays the dash key).
  controller.attach(window, document, () => {
    if (enterHatches(screen, performance.now() - screenShownAt)) hatch();
  });

  /** The input the tick uses: a script on the title, the debug steering, or the player's own. */
  const chooseInput = (): Input => {
    const { player, world } = session;
    if (session.demo) {
      return { steer: (world.tick >> 2) & 255, throttle: 5, dash: false };
    }
    if (steering) {
      const dx = steering.target.x - player.x;
      const dy = steering.target.y - player.y;
      return { steer: angleToSteer(atan2(dy, dx)), throttle: MAX_THROTTLE, dash: false };
    }
    return controller.sample(
      { x: scene.width / 2, y: scene.height / 2 },
      scene.pxPerWu,
      Math.sqrt(player.biomass),
    );
  };

  const settleSteering = (events: StepEvent[]): void => {
    if (!steering) return;
    // Steering is a debug aid that reads the live field, so it refreshes every tick.
    field.now();
    const { player } = session;
    const { target } = steering;
    const eaten = events.some((e) => e.type === 'eat' && e.food === target.id);
    const item = target.id === undefined ? undefined : food.find((f) => f.id === target.id);
    if (item) {
      target.x = item.x;
      target.y = item.y;
    }
    const reached =
      target.id === undefined &&
      Math.hypot(target.x - player.x, target.y - player.y) <= Math.sqrt(player.biomass);
    const gone = target.id !== undefined && !eaten && !item;
    steering.ticksLeft--;
    if (eaten || reached || gone || steering.ticksLeft <= 0 || !player.alive) {
      const finished = steering;
      steering = null;
      finished.done(eaten || reached);
    }
  };

  /** Where a cue belongs: an eat pops at the food, everything else at the creature. */
  const anchorFor = (event: StepEvent): { x: number; y: number; radius: number } => {
    const { player } = session;
    const radius = Math.sqrt(player.biomass);
    if (event.type === 'eat') {
      const item = food.find((f) => f.id === event.food);
      if (item) return { x: item.x, y: item.y, radius: Math.max(item.radius, radius * 0.6) };
    }
    return { x: player.x, y: player.y, radius };
  };

  /** A peer's claim or consumed set: update the shared food and give back a bite that lost. */
  const receiveFoodEvent = (from: string, event: PeerEvent): void => {
    if (!pond) return;
    const stolen = pond.food.receive(pond.world, from, event);
    field.now();
    if (!stolen || session.demo) return;
    const { player, counts } = session;
    player.energy = Math.max(0, player.energy - stolen.value);
    counts.stolen = (counts.stolen ?? 0) + 1;
    hud.update(player);
  };

  const tick = (): void => {
    const { world, player, counts } = session;
    // The world stops when the player has died: nothing changes behind the death screen.
    if (session.death !== null) return;
    prev.x = player.x;
    prev.y = player.y;
    prev.heading = player.heading;
    input = chooseInput();
    if (pond && !session.demo && scale === 1) {
      loop.setSpeed(pond.time.update(world, performance.now()));
    }
    const at = world.tick;
    const events = step(world, { [player.id]: input });
    if (pond && !session.demo) pond.food.onEat(events, at);
    for (const event of events) {
      if (event.creature !== player.id) continue;
      fx.onEvent(event, anchorFor(event));
      if (event.type === 'eat') hud.pulseEnergy();
    }
    if (session.demo) {
      // The title cell lives on: keep it fed and healthy without growing.
      player.biomass = RULES.starter.biomass;
      player.energy = starterEnergy(player.biomass);
      player.health = maxHealth(player.biomass);
    } else {
      for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
      session.peakBiomass = Math.max(session.peakBiomass, player.biomass);
      hud.update(player);
    }
    field.markDirty();
    settleSteering(events);
    if (!session.demo && player.cause !== null) {
      session.death = {
        cause: player.cause,
        survivedSeconds: (world.tick - player.bornTick) / TICK_HZ,
        peakBiomass: session.peakBiomass,
      };
      fx.startDissolve();
    }
  };

  let lastMs = performance.now();
  const view = {
    time: 0,
    camX: 0,
    camY: 0,
    halfHeight: 1,
    creature: null as CellView | null,
    remotes: [] as readonly RemoteView[],
    rings: fx.rings,
  };
  const cell: CellView = { x: 0, y: 0, heading: 0, radius: 1, beat: 0, hurt: 0, dissolve: 0 };
  let shownVignette = -1;
  const setVignette = (amount: number): void => {
    // Rounded so a steady fade does not rewrite the style every frame.
    const rounded = Math.round(amount * 100) / 100;
    if (rounded === shownVignette) return;
    shownVignette = rounded;
    vignette.style.opacity = String(rounded);
  };

  /** A scripted remote's snapshot goes through the real codec and into the set, as a peer's would. */
  const feedScripted = ({ spec, sender, startedMs }: Scripted, now: number): void => {
    sender.update(now, false, () => {
      const seconds = (now - startedMs) / 1000;
      const vx = spec.vx ?? 0;
      const vy = spec.vy ?? 0;
      return {
        tick: Math.round((pondMs() * TICK_HZ) / 1000),
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
      };
    });
  };

  const render = (alpha: number): void => {
    const { player } = session;
    const now = performance.now();
    const elapsed = (now - lastMs) / 1000;
    const dt = Math.min(elapsed, MAX_FRAME_SECONDS);
    lastMs = now;

    cell.x = lerp(prev.x, player.x, alpha);
    cell.y = lerp(prev.y, player.y, alpha);
    cell.heading = prev.heading + wrapAngle(player.heading - prev.heading) * alpha;
    cell.radius = Math.sqrt(player.biomass);
    beat = lerp(beat, input.throttle / MAX_THROTTLE, Math.min(1, dt * 6));
    cell.beat = beat;

    camera.update(dt, { x: cell.x, y: cell.y, radius: cell.radius });
    view.time = now / 1000;
    view.camX = camera.x;
    view.camY = camera.y;
    view.halfHeight = camera.halfHeight;
    // Cues run on wall-clock time: a slow frame must not stretch the dissolve.
    fx.update(elapsed);
    cell.hurt = fx.vignette;
    cell.dissolve = fx.dissolve;
    view.creature = fx.dissolved ? null : cell;
    setVignette(fx.vignette);
    // The death screen waits for the body to dissolve, so the player sees what killed them.
    if (session.death !== null && fx.dissolved && screen === 'playing') {
      screen = 'dead';
      screenShownAt = now;
      screens.showDeath(session.death);
    }
    for (const script of scripted) feedScripted(script, now);
    remoteViews = remotes.sample(now, pondMs());
    view.remotes = remoteViews;
    labels.update(remoteViews, {
      camX: camera.x,
      camY: camera.y,
      pxPerWu: scene.pxPerWu,
      width: scene.width,
      height: scene.height,
    });
    field.flush();
    scene.draw(view);
  };

  // `timeScale` speeds the sim up by scaling the loop's clock.
  let virtualMs = 0;
  let lastRealMs = performance.now();
  const clock = (): number => {
    const real = performance.now();
    virtualMs += (real - lastRealMs) * scale;
    lastRealMs = real;
    return virtualMs;
  };
  const loop = createLoop({
    now: clock,
    tick,
    render,
    maxTicksPerFrame: params.debug ? DEBUG_MAX_TICKS_PER_FRAME : 5,
  });
  attachVisibilityPause(document, loop);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // The pond moved on while the tab was hidden: skip ahead instead of simulating it.
    if (pond && !session.demo) pond.time.resnap(session.world, performance.now());
    // Cues run on wall-clock time: hidden time must not skip the death dissolve.
    lastMs = performance.now();
    fx.resume();
  });

  let frames = 0;
  scene.start(() => {
    loop.frame();
    frames += 1;
    canvas.dataset.frames = String(frames);
  });

  enter(session, 'title');

  const debug: BsDebug = {
    setEnergy(energy) {
      const { player } = session;
      player.energy = Math.min(energy, maxEnergy(player.biomass));
    },
    setBiomass(biomass) {
      const { player } = session;
      const energy = player.energy / maxEnergy(player.biomass);
      const health = player.health / maxHealth(player.biomass);
      player.biomass = biomass;
      player.energy = energy * maxEnergy(biomass);
      player.health = health * maxHealth(biomass);
      session.peakBiomass = Math.max(session.peakBiomass, biomass);
      hud.update(player);
    },
    teleport(x, y) {
      const { player } = session;
      player.x = x;
      player.y = y;
      player.vx = 0;
      player.vy = 0;
      prev.x = x;
      prev.y = y;
    },
    nearestFood() {
      const { player } = session;
      let best: FoodItem | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const item of food) {
        const distance = Math.hypot(item.x - player.x, item.y - player.y);
        if (distance < bestDistance) {
          best = item;
          bestDistance = distance;
        }
      }
      return best;
    },
    steerTo(target) {
      steering?.done(false);
      steering = null;
      if (!session.player.alive) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        steering = { target: { ...target }, ticksLeft: STEER_TIMEOUT_TICKS, done: resolve };
      });
    },
    spawnPlume(x, y, radius = 80) {
      const { extraPlumes } = session.world;
      extraPlumes.push({ id: `debug${extraPlumes.length}`, x, y, radius });
      field.now();
    },
    setRemotes(specs) {
      for (const { spec } of scripted) remotes.removeMember(spec.id);
      scripted = specs.map((spec) => {
        remotes.setMember(spec.id, spec.name);
        const sender = new SnapshotSender((bytes) => {
          const snapshot = decodeSnapshot(bytes);
          if (snapshot) remotes.receive(spec.id, snapshot, performance.now());
        });
        return { spec, sender, startedMs: performance.now() };
      });
    },
    joinPond(spec) {
      const clock = new PondClock();
      const now = performance.now();
      clock.addSample(now, now, spec.hubNow);
      const world = createWorld({ seed: spec.seed });
      pond = {
        seed: spec.seed,
        time: new PondTime(clock, spec.epoch),
        food: new PondFood(playerId ?? 'local', spec.send),
        world,
      };
    },
    deliver(from, raw) {
      const event = parsePeerEvent(JSON.stringify(raw));
      if (!pond || !event) return;
      receiveFoodEvent(from, event);
    },
    hasFood: (id) => food.some((f) => f.id === id),
    timeScale(next) {
      clock();
      scale = next;
    },
  };

  installHook({
    ready: true,
    state: () => ({
      screen,
      tick: session.world.tick,
      playerId,
      visibleFood: food.length,
      player: session.demo
        ? null
        : {
            x: session.player.x,
            y: session.player.y,
            radius: Math.sqrt(session.player.biomass),
            biomass: session.player.biomass,
            energy: session.player.energy,
            health: session.player.health,
            alive: session.player.alive,
          },
      death: session.death,
      remotes: remoteViews.map(({ id, name, x, y, alpha }) => ({ id, name, x, y, alpha })),
    }),
    events: () => ({ ...session.counts }),
    replay: (log) => {
      const { hash, events } = replay(log);
      return { hash, events };
    },
    render: {
      info: () => scene.info(),
      fx: () => ({
        ...fx.snapshot(),
        halfHeight: camera.halfHeight,
        camX: camera.x,
        camY: camera.y,
      }),
    },
    ...(params.debug ? { debug } : {}),
  });
}
