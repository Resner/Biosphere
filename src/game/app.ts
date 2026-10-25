import { FollowCamera, viewHalfHeight } from '../render/camera';
import type { CellView } from '../render/cell';
import { GameScene } from '../render/scene';
import { foodNear } from '../sim/food';
import { type Plume, plumesNear } from '../sim/hazards';
import { IDLE, type Input } from '../sim/input';
import { lerp, wrapAngle } from '../sim/math';
import { RULES } from '../sim/rules';
import { step } from '../sim/step';
import type { CreatureState, FoodItem, StepEvent } from '../sim/types';
import { createWorld, spawnCreature } from '../sim/world';
import { type BsDebug, installHook } from './debug';
import { InputController } from './input';
import { attachVisibilityPause, createLoop } from './loop';

export interface GameParams {
  seed: string;
  debug: boolean;
}

/** Food drifts up to this far from its slot anchor; the field query reaches that much further. */
const FIELD_MARGIN = RULES.food.driftRadius + RULES.food.kinds.globule.radius;
const MAX_FRAME_SECONDS = 0.1;

/** Hatches one creature in a fresh world and runs the game loop. */
export function startGame(canvas: HTMLCanvasElement, params: GameParams): void {
  const world = createWorld({ seed: params.seed });
  const player = spawnCreature(world, { id: 'player', x: world.size / 2, y: world.size / 2 });
  const scene = new GameScene(canvas, world.size);
  const camera = new FollowCamera();
  const controller = new InputController();
  controller.attach(window);
  camera.snap({ x: player.x, y: player.y, radius: Math.sqrt(player.biomass) });
  scene.setHalfHeight(camera.halfHeight);

  const counts: Record<string, number> = {};
  const extraPlumes: Plume[] = [];
  let food: FoodItem[] = [];
  let input: Input = IDLE;
  let beat = 0;
  const prev = { x: player.x, y: player.y, heading: player.heading };

  const refreshField = (creature: CreatureState): void => {
    const radius = Math.sqrt(creature.biomass);
    const half = Math.max(camera.halfHeight, viewHalfHeight(radius));
    const reach = Math.hypot(half * scene.aspect, half) + FIELD_MARGIN;
    food = foodNear(world, creature.x, creature.y, reach);
    const plumes = plumesNear(world, creature.x, creature.y, reach);
    scene.setField(food, extraPlumes.length > 0 ? [...plumes, ...extraPlumes] : plumes);
  };

  const tick = (): void => {
    prev.x = player.x;
    prev.y = player.y;
    prev.heading = player.heading;
    input = controller.sample(
      { x: scene.width / 2, y: scene.height / 2 },
      scene.pxPerWu,
      Math.sqrt(player.biomass),
    );
    const events: StepEvent[] = step(world, { [player.id]: input });
    for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
    refreshField(player);
  };

  let lastMs = performance.now();
  const view = {
    time: 0,
    camX: 0,
    camY: 0,
    halfHeight: 1,
    creature: null as CellView | null,
  };
  const cell: CellView = { x: 0, y: 0, heading: 0, radius: 1, beat: 0 };

  const render = (alpha: number): void => {
    const now = performance.now();
    const dt = Math.min((now - lastMs) / 1000, MAX_FRAME_SECONDS);
    lastMs = now;

    cell.x = lerp(prev.x, player.x, alpha);
    cell.y = lerp(prev.y, player.y, alpha);
    cell.heading = prev.heading + wrapAngle(player.heading - prev.heading) * alpha;
    cell.radius = Math.sqrt(player.biomass);
    beat = lerp(beat, input.throttle / RULES.movement.maxThrottle, Math.min(1, dt * 6));
    cell.beat = beat;

    camera.update(dt, { x: cell.x, y: cell.y, radius: cell.radius });
    view.time = now / 1000;
    view.camX = camera.x;
    view.camY = camera.y;
    view.halfHeight = camera.halfHeight;
    view.creature = player.alive ? cell : null;
    scene.draw(view);
  };

  const loop = createLoop({ now: () => performance.now(), tick, render });
  attachVisibilityPause(document, loop);

  let frames = 0;
  scene.start(() => {
    loop.frame();
    frames += 1;
    if (params.debug) canvas.dataset.frames = String(frames);
  });

  document.body.dataset.screen = 'playing';
  refreshField(player);

  const debug: BsDebug = {
    spawnPlume(x, y, radius = 80) {
      extraPlumes.push({ id: `debug${extraPlumes.length}`, x, y, radius });
      refreshField(player);
    },
  };

  installHook({
    ready: true,
    state: () => ({
      screen: 'playing',
      tick: world.tick,
      visibleFood: food.length,
      player: {
        x: player.x,
        y: player.y,
        radius: Math.sqrt(player.biomass),
        biomass: player.biomass,
        energy: player.energy,
        health: player.health,
        alive: player.alive,
      },
    }),
    events: () => ({ ...counts }),
    render: { info: () => scene.info() },
    ...(params.debug ? { debug } : {}),
  });
}
