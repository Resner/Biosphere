import { parseGenomeText } from '../genome/codec';
import type { Vec2 } from '../net/protocol';
import { EGG } from '../render/egg';
import { IDLE } from '../sim/input';
import { maxEnergy, maxHealth } from '../sim/vitals';
import type { App } from './app';
import { adultRadius, newSession, type Session } from './app-session';
import { type Body, bodyLabel, hatchBody } from './body';
import { type Started, VERIFY_FAILED } from './life';
import type { FallbackId } from './offspring-text';
import { cleanName, ringSpawn, saveName, tryOnline } from './online-config';
import type { Screen } from './screens';

/** A hatch waits this long for the hub before the player swims in a local pond. */
const HATCH_WAIT_MS = 4000;

/**
 * The longest a hatch waits for its egg to be ripe (wall time): the exotic stir and crack, and a
 * margin. It only matters while the egg's clock is held (a frozen world) or frames stop.
 */
const EGG_RIPE_CAP_MS = EGG.stirMs.exotic + EGG.crackMs.exotic + 1000;

/** Starting a life: a hatch, the pending child or an ancestor, and the switch into it. */
export class LifeStarts {
  /**
   * A hatch waits for its egg's stir and crack before play begins (M6b T11): `run` starts the life
   * in the frame that finds the egg ripe, so the shell bursts in that same frame, or after
   * `EGG_RIPE_CAP_MS` at the latest. The promise settles once it ran.
   */
  ripeWaiter: (() => void) | null = null;
  /** The rarity of the body a genesis's beacon gave, read while its check runs; by genome text. */
  private arriving: { text: string; tier: Body['rarity'] | null } | null = null;
  /** The first local hatch uses the pond seed as given; each later one gets its own pond. */
  private hatches = 0;
  hatching = false;
  private switching = false;

  constructor(private readonly app: App) {}

  private whenRipe(tier: Body['rarity'], run: () => void): Promise<void> {
    const { eggs } = this.app;
    return new Promise((resolve) => {
      // A check quicker than a frame never showed the egg the beacon: it stirs now.
      if (eggs.mode === 'genesis' && eggs.reveal.phase === 'waiting') {
        eggs.genesisBeacon(this.app.eggClock(), tier);
      }
      const { phase } = eggs.reveal;
      let settled = false;
      const timer = setTimeout(() => done(), EGG_RIPE_CAP_MS);
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.ripeWaiter === done) this.ripeWaiter = null;
        run();
        resolve();
      };
      if (eggs.mode !== 'genesis' || (phase !== 'stirring' && phase !== 'cracking')) {
        done();
        return;
      }
      this.ripeWaiter = done;
    });
  }

  arrivingTier(): Body['rarity'] | null {
    const text = this.app.flow.arriving();
    if (text === null) return null;
    if (this.arriving?.text !== text) {
      const genome = parseGenomeText(text);
      this.arriving = { text, tier: genome ? hatchBody(genome).rarity : null };
    }
    return this.arriving.tier;
  }

  enter(next: Session, nextScreen: Screen): void {
    const { app } = this;
    const { camera, scene, hud, flow, prev } = app;
    app.session = next;
    app.endLifeState();
    app.fx.reset();
    app.shake.reset();
    app.minimap.invalidate();
    app.growth.reset();
    app.controller.reset();
    app.heldInput = IDLE;
    app.heldFromKeys = false;
    app.steering?.done(false);
    app.steering = null;
    const { player } = app.session;
    prev.x = player.x;
    prev.y = player.y;
    prev.heading = player.heading;
    camera.snap({
      x: player.x,
      y: player.y,
      radius: Math.sqrt(player.biomass),
      adult: adultRadius(player),
    });
    scene.setHalfHeight(camera.halfHeight);
    scene.setZones(app.session.world.seed32, app.session.world.size);
    app.field.now();
    hud.update(player);
    if (!app.session.demo) {
      app.sound.resetCues();
      app.cueWatch.reset();
      hud.setBody(bodyLabel(app.session.body));
      app.genomeSync.setOwn(app.session.body.text);
      app.hints.startLife();
    }
    app.frame.view.body = app.session.body.creature;
    app.lastClock = null;
    hud.setLife(null);
    hud.setPractice(!app.session.demo && flow.view().status === 'practice');
    app.screen = nextScreen;
    app.screenShownAt = performance.now();
    app.screens.show(nextScreen);
  }

  /** Starts a life, in the joined pond or (`inPond` false) in a local one. */
  begin(inPond: boolean, recorded?: { body: Body; start: Started }, at?: Vec2): void {
    const { app } = this;
    const target = inPond ? app.pond : null;
    const seed = this.hatches === 0 ? app.params.seed : `${app.params.seed}/${this.hatches}`;
    this.hatches++;
    let spawn: Vec2 | null = null;
    if (at) spawn = at;
    else if (target?.ring) spawn = ringSpawn(target.ring.centre, target.ring.hint, target.lives);
    if (target) target.lives++;
    app.hatchError = '';
    const next = newSession(
      target ? target.seed : seed,
      false,
      recorded?.body ?? app.hatcher.next(),
      target,
      spawn,
      recorded?.start.condition?.biomass,
    );
    const saved = recorded?.start.condition;
    if (saved) {
      const { player } = next;
      player.energy = Math.min(saved.energy, maxEnergy(saved.biomass));
      player.health = Math.min(saved.health, maxHealth(saved.biomass));
    }
    this.enter(next, 'playing');
    // After a genesis or a hatch, the creature grows out of its egg.
    app.emerging = app.eggs.hatched(app.eggClock(), next.body.rarity) ? next : null;
    if (app.emerging) app.sound.cue('hatch');
  }

  hatch(): void {
    const { app } = this;
    const { flow, screens } = app;
    if (this.hatching || app.limitLeft() > 0) return;
    app.limitUntil = 0;
    if (!app.hubUrl) {
      flow.practice();
      this.begin(app.pond !== null);
      return;
    }
    const name = cleanName(app.nameInput.value);
    app.nameError.hidden = name !== null;
    if (!name) return;
    saveName(app.storage, name);
    this.hatching = true;
    app.hatchError = '';
    screens.setBusy(true);
    // A hub that cannot be reached (or a failing connector) means a local pond, never a stuck screen.
    void tryOnline(() =>
      app.identityReady.then(() => {
        app.online.ensure(name);
        return app.keeper.current?.whenReady(HATCH_WAIT_MS) ?? null;
      }),
    )
      .then(async (welcome) => {
        const joined = welcome !== null && app.pond !== null;
        // A pinned body is a test or a debug cell: it never touches the ledger.
        if (!joined || app.params.genome) {
          flow.practice();
          this.begin(joined);
          return;
        }
        const outcome = await flow.hatch(HATCH_WAIT_MS);
        if (outcome.kind === 'failed') {
          app.hatchError = outcome.message;
        } else if (outcome.kind === 'practice') {
          // Out of recorded hatches: wait out the countdown or swim in a practice cell.
          if (outcome.reason === 'limit' && (outcome.genesisIn ?? 0) > 0) {
            app.limitUntil = performance.now() + (outcome.genesisIn ?? 0);
          } else {
            this.begin(true);
          }
        } else {
          const genome = parseGenomeText(outcome.start.genome);
          if (!genome) {
            app.hatchError = VERIFY_FAILED;
            return;
          }
          // The egg stirs and cracks first; play begins with its burst.
          const body = hatchBody(genome);
          await this.whenRipe(body.rarity, () => this.begin(true, { body, start: outcome.start }));
        }
      })
      .catch((error: unknown) => {
        console.warn('hatch failed', error);
        app.hatchError = 'Could not hatch. Try again.';
      })
      .finally(() => {
        this.hatching = false;
        screens.setBusy(false);
      });
  }

  /** Becoming the pending child, or returning to the nearest ancestor (M5 T11). */
  become(choice: FallbackId): void {
    const { app } = this;
    const { flow, eggs, hud, screens } = app;
    if (this.switching || this.hatching) return;
    const child = app.offspring.child();
    const ancestor = flow.view().fallback?.ancestor ?? null;
    const task =
      choice === 'child' && child
        ? () => flow.promote(child.born)
        : ancestor && choice === 'ancestor'
          ? () => flow.restore(ancestor)
          : null;
    if (!task) return;
    if (!app.hubUrl || app.pond === null || !app.playerId) {
      hud.toast('Not connected to the pond');
      return;
    }
    this.switching = true;
    app.hatchError = '';
    screens.setBusy(true);
    // A living parent hands over to the child, which hatches out of the egg it carries.
    const alive = app.screen === 'playing' && app.session.player.alive;
    const hatchingChild = choice === 'child' && child !== null;
    const at = alive
      ? ((hatchingChild ? eggs.ownAt() : null) ?? {
          x: app.session.player.x,
          y: app.session.player.y,
        })
      : undefined;
    if (hatchingChild) eggs.hatchStart(app.eggClock(), child.body.rarity, alive && eggs.ownShown);
    let begun = false;
    void task()
      .then((outcome) => {
        if (outcome.kind === 'failed') {
          app.hatchError = outcome.message;
          hud.toast(outcome.message);
          return;
        }
        if (outcome.kind !== 'recorded') return;
        const genome = parseGenomeText(outcome.start.genome);
        if (!genome) {
          app.hatchError = VERIFY_FAILED;
          return;
        }
        // The parent stays behind as it was and dissolves there.
        if (hatchingChild && alive) {
          const { cell } = app.frame;
          eggs.leave(
            {
              x: cell.x,
              y: cell.y,
              heading: cell.heading,
              radius: cell.radius,
              body: app.session.body.creature,
              hue: 0,
            },
            app.eggClock(),
          );
        }
        begun = true;
        this.begin(true, { body: hatchBody(genome), start: outcome.start }, at);
        hud.toast(
          choice === 'child'
            ? `You are now ${app.session.body.species}`
            : `Back as ${app.session.body.species}`,
        );
      })
      .catch((error: unknown) => {
        console.warn('switch failed', error);
        app.hatchError = 'Could not switch creatures. Try again.';
      })
      .finally(() => {
        this.switching = false;
        screens.setBusy(false);
        // A hatch the hub did not make puts the carried egg back.
        if (hatchingChild && !begun && eggs.mode === 'hatch') eggs.cancel();
      });
  }
}
