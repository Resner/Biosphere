import { plumesNear } from '../sim/hazards';
import { angleToSteer, IDLE, type Input } from '../sim/input';
import { applyLife, lifespanMs } from '../sim/life';
import { atan2 } from '../sim/math';
import { RULES, TICK_HZ } from '../sim/rules';
import { step } from '../sim/step';
import type { StepEvent } from '../sim/types';
import { maxEnergy, maxHealth, starterEnergy } from '../sim/vitals';
import type { App } from './app';
import { countItem, EXPIRY_RETRY_TICKS, MAX_THROTTLE, REPORT_EVERY_TICKS } from './app-session';
import { bodyLabel } from './body';
import { sizeShare } from './growth';
import { wheelInput } from './input';
import { nearestHazard } from './sound-cues';

/** Plumes are looked for this far, in body radii from the centre: past the hazard cue's clear line. */
const CUE_REACH_RADII = 5;

/** One sim tick of the current life: its input, the step, its cues, its reports and its death. */
export class Ticker {
  /** Whether the recovery-code reminder has been shown after a mating. */
  private reminded = false;

  constructor(private readonly app: App) {}

  /** The input the tick uses: a script on the title, the debug steering, or the player's own. */
  private chooseInput(): Input {
    const { app } = this;
    const { session, steering, controller, scene, wheel } = app;
    const { player, world } = session;
    if (session.demo) {
      return { steer: (world.tick >> 2) & 255, throttle: 5, dash: false };
    }
    if (steering) {
      const dx = steering.target.x - player.x;
      const dy = steering.target.y - player.y;
      return { steer: angleToSteer(atan2(dy, dx)), throttle: MAX_THROTTLE, dash: false };
    }
    const sampled = controller.sample(
      { x: scene.width / 2, y: scene.height / 2 },
      scene.pxPerWu,
      Math.sqrt(player.biomass),
    );
    // The cursor is choosing on the social wheel: the creature keeps the steering it had when the
    // wheel opened, and WASD still steers (M6b T2).
    const keys = controller.keyInput();
    if (!wheel.isOpen) {
      app.heldInput = sampled;
      app.heldFromKeys = keys !== null;
    } else if (keys) {
      app.heldInput = keys;
      app.heldFromKeys = true;
    } else if (app.heldFromKeys) {
      // WASD let go while the wheel is open: coast, as without the wheel.
      app.heldInput = IDLE;
      app.heldFromKeys = false;
    }
    return wheelInput(wheel.isOpen, app.heldInput, sampled, keys);
  }

  private settleSteering(events: StepEvent[]): void {
    const { app } = this;
    const { steering } = app;
    if (!steering) return;
    // Steering is a debug aid that reads the live field, so it refreshes every tick.
    app.field.now();
    const { player } = app.session;
    const { target } = steering;
    const eaten = events.some((e) => e.type === 'eat' && e.food === target.id);
    const item = target.id === undefined ? undefined : app.food.find((f) => f.id === target.id);
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
      app.steering = null;
      finished.done(eaten || reached);
    }
  }

  /** Where a cue belongs: an eat pops at the food, everything else at the creature. */
  private anchorFor(event: StepEvent): { x: number; y: number; radius: number } {
    const { player } = this.app.session;
    const radius = Math.sqrt(player.biomass);
    if (event.type === 'eat') {
      const item = this.app.food.find((f) => f.id === event.food);
      if (item) return { x: item.x, y: item.y, radius: Math.max(item.radius, radius * 0.6) };
    }
    return { x: player.x, y: player.y, radius };
  }

  /**
   * The life clock of a recorded creature: it turns elder at 85% of its lifespan, and the hub's
   * word that its time is up ends it. A creature past its time asks the hub for that verdict.
   */
  private ageCreature(): void {
    const { app } = this;
    const { session, flow, hud } = app;
    const { world, player } = session;
    if (flow.expired) {
      // The sim's own `expire` call, the one a replayed log carries.
      applyLife(world, player.id, 'expire');
      return;
    }
    const { creature } = session.body;
    const lastClock = flow.clock(
      session.ticks,
      player.biomass,
      creature.stats.maxBiomass,
      lifespanMs(creature.traits.physiology.lifespan),
    );
    app.lastClock = lastClock;
    hud.setLife(lastClock);
    if (!lastClock) return;
    if (lastClock.stage === 'old' && !player.elder) {
      applyLife(world, player.id, 'elder');
      hud.toast('Feeling old');
      app.sound.cue('old-age');
    }
    const lastAsk = session.lastExpiryAsk;
    if (
      lastClock.remainingMs <= 0 &&
      (lastAsk < 0 || session.ticks - lastAsk >= EXPIRY_RETRY_TICKS)
    ) {
      session.lastExpiryAsk = session.ticks;
      flow.report(session.ticks, player);
    }
  }

  tick(): void {
    const { app } = this;
    const { session, prev, fx, hud, cueWatch } = app;
    const { world, player, counts } = session;
    // The world stops when the player has died: nothing changes behind the death screen.
    if (session.death !== null) return;
    prev.x = player.x;
    prev.y = player.y;
    prev.heading = player.heading;
    app.input = this.chooseInput();
    // The authority committed a mating: pay its cost here, at a tick boundary.
    if (!session.demo && app.mate.takeCost()) {
      // The price lands where it is felt: the body shrinks with a pulse, the bars drain (M6 T20).
      const shares = () => ({
        energy: player.energy / maxEnergy(player.biomass),
        size: sizeShare(player.biomass, player.phys.maxBiomass),
      });
      const before = shares();
      const fromRadius = fx.drawnRadius(Math.sqrt(player.biomass));
      applyLife(world, player.id, 'mate');
      fx.matePulse({ x: player.x, y: player.y, radius: Math.sqrt(player.biomass) });
      fx.costPulse(fromRadius);
      app.sound.cue('mate');
      hud.drain(before, shares());
      if (app.recovery.needsSaving && !this.reminded) {
        this.reminded = true;
        hud.toast('Save your recovery code');
      }
    }
    const live = app.livePond();
    if (live && app.scale === 1) app.loop.setSpeed(live.time.update(world, performance.now()));
    const at = world.tick;
    const events = step(world, { [player.id]: app.input });
    session.ticks++;
    live?.food.onEat(events, at);
    for (const event of events) {
      if (event.creature !== player.id) continue;
      fx.onEvent(event, this.anchorFor(event));
      if (event.type === 'damage') app.shake.hit(event.cause);
      if (!session.demo) cueWatch.onEvent(event, session.ticks);
      if (event.type === 'eat') hud.pulseEnergy();
    }
    if (session.demo) {
      // The title cell lives on: keep it fed and healthy without growing.
      player.biomass = RULES.starter.biomass;
      player.energy = starterEnergy(player.biomass);
      player.health = maxHealth(player.biomass);
    } else {
      for (const event of events) {
        counts[event.type] = (counts[event.type] ?? 0) + 1;
        if (event.type === 'eat') countItem(counts, 'eat', event.food);
      }
      session.peakBiomass = Math.max(session.peakBiomass, player.biomass);
      hud.update(player);
      if (player.alive) {
        const radius = Math.sqrt(player.biomass);
        const reach = radius * CUE_REACH_RADII;
        cueWatch.vitals(
          session.ticks,
          player.energy / maxEnergy(player.biomass),
          nearestHazard(plumesNear(world, player.x, player.y, reach), player.x, player.y, radius),
        );
      }
    }
    app.field.markDirty();
    this.settleSteering(events);
    if (!session.demo && player.cause === null && session.ticks >= session.nextReport) {
      session.nextReport += REPORT_EVERY_TICKS;
      if (!document.hidden) app.flow.report(session.ticks, player);
    }
    if (!session.demo && player.cause === null) this.ageCreature();
    if (!session.demo && player.cause !== null) {
      // A recorded creature lived by its life clock; a practice cell by sim time.
      const lived = app.lastClock
        ? app.lastClock.activeMs / 1000
        : (world.tick - player.bornTick) / TICK_HZ;
      app.flow.died(player.cause, session.ticks);
      app.lastClock = null;
      hud.setLife(null);
      session.death = {
        cause: player.cause,
        survivedSeconds: lived,
        peakBiomass: session.peakBiomass,
        body: bodyLabel(session.body),
      };
      fx.startDissolve();
      // Never a silent death: every cause ends in the death tone.
      cueWatch.died();
      app.endLifeState();
    }
  }
}
