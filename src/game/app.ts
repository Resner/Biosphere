import { FollowCamera, viewHalfHeight } from '../render/camera';
import type { CellView } from '../render/cell';
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
import { type BsDebug, installHook } from './debug';
import { Hud } from './hud';
import { InputController } from './input';
import { attachVisibilityPause, createLoop } from './loop';
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

function newSession(seed: string, demo: boolean): Session {
  const world = createWorld({ seed: demo ? `${seed}/title` : seed, hazards: !demo });
  const spot = findClearSpot(world, world.size / 2, world.size / 2);
  const player = spawnCreature(world, { id: 'player', ...spot });
  return { world, player, demo, counts: {}, peakBiomass: player.biomass, death: null };
}

/** Starts the title screen; the player hatches into the same scene. */
export function startApp(canvas: HTMLCanvasElement, params: GameParams): void {
  const scene = new GameScene(canvas, RULES.world.size);
  const camera = new FollowCamera();
  const controller = new InputController();
  controller.attach(window);
  const hud = new Hud();

  let session = newSession(params.seed, true);
  let screen: Screen = 'title';
  let food: FoodItem[] = [];
  let input: Input = IDLE;
  let beat = 0;
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

  const enter = (next: Session, nextScreen: Screen): void => {
    session = next;
    steering?.done(false);
    steering = null;
    const { player } = session;
    prev.x = player.x;
    prev.y = player.y;
    prev.heading = player.heading;
    camera.snap({ x: player.x, y: player.y, radius: Math.sqrt(player.biomass) });
    scene.setHalfHeight(camera.halfHeight);
    refreshField();
    hud.update(player);
    screen = nextScreen;
    screens.show(nextScreen);
  };

  const screens = new Screens({
    hatch: () => enter(newSession(params.seed, false), 'playing'),
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
    const { player } = session;
    const { target } = steering;
    const eaten = events.some((e) => e.type === 'eat' && e.food === target.id);
    const item = target.id === undefined ? undefined : food.find((f) => f.id === target.id);
    if (item) {
      target.x = item.x;
      target.y = item.y;
    }
    const reached =
      target.id === undefined && Math.hypot(target.x - player.x, target.y - player.y) <= 1;
    const gone = target.id !== undefined && !eaten && !item;
    steering.ticksLeft--;
    if (eaten || reached || gone || steering.ticksLeft <= 0 || !player.alive) {
      const finished = steering;
      steering = null;
      finished.done(eaten || reached);
    }
  };

  const tick = (): void => {
    const { world, player, counts } = session;
    // The world stops when the player has died: nothing changes behind the death screen.
    if (session.death !== null) return;
    prev.x = player.x;
    prev.y = player.y;
    prev.heading = player.heading;
    input = chooseInput();
    const events = step(world, { [player.id]: input });
    if (session.demo) {
      // The title cell lives on: keep it fed and healthy without growing.
      player.energy = starterEnergy(player.biomass);
      player.health = maxHealth(player.biomass);
    } else {
      for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
      session.peakBiomass = Math.max(session.peakBiomass, player.biomass);
      hud.update(player);
    }
    refreshField();
    settleSteering(events);
    if (!session.demo && player.cause !== null) {
      session.death = {
        cause: player.cause,
        survivedSeconds: (world.tick - player.bornTick) / TICK_HZ,
        peakBiomass: session.peakBiomass,
      };
      screen = 'dead';
      screens.showDeath(session.death);
    }
  };

  let lastMs = performance.now();
  const view = { time: 0, camX: 0, camY: 0, halfHeight: 1, creature: null as CellView | null };
  const cell: CellView = { x: 0, y: 0, heading: 0, radius: 1, beat: 0 };

  const render = (alpha: number): void => {
    const { player } = session;
    const now = performance.now();
    const dt = Math.min((now - lastMs) / 1000, MAX_FRAME_SECONDS);
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
    view.creature = player.alive ? cell : null;
    scene.draw(view);
  };

  // `timeScale` speeds the sim up by scaling the loop's clock.
  let scale = 1;
  let virtualMs = 0;
  let lastRealMs = performance.now();
  const clock = (): number => {
    const real = performance.now();
    virtualMs += (real - lastRealMs) * scale;
    lastRealMs = real;
    return virtualMs;
  };
  const loop = createLoop({ now: clock, tick, render, maxTicksPerFrame: params.debug ? 20 : 5 });
  attachVisibilityPause(document, loop);

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
      return new Promise<boolean>((resolve) => {
        steering = { target: { ...target }, ticksLeft: STEER_TIMEOUT_TICKS, done: resolve };
      });
    },
    spawnPlume(x, y, radius = 80) {
      const { extraPlumes } = session.world;
      extraPlumes.push({ id: `debug${extraPlumes.length}`, x, y, radius });
      refreshField();
    },
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
    }),
    events: () => ({ ...session.counts }),
    replay: (log) => {
      const { hash, events } = replay(log);
      return { hash, events };
    },
    render: { info: () => scene.info() },
    ...(params.debug ? { debug } : {}),
  });
}
