import { renderCueOffline, renderOffline } from '../audio/engine';
import { genomeFromBase64url, genomeHash, parseGenomeText } from '../genome/codec';
import { hashPlan } from '../genome/develop';
import { silhouetteOf } from '../genome/silhouette';
import { buildCreature, hashStats } from '../genome/stats';
import { PondClock } from '../net/clock';
import { SnapshotSender } from '../net/pond-sync';
import { decodeSnapshot, genomeRefOf, parsePeerEvent } from '../net/protocol';
import { nearestInZone } from '../render/zones';
import { depthAt, zoneOfDepth } from '../sim/bathymetry';
import { replay } from '../sim/replay';
import { RULES, TICK_HZ } from '../sim/rules';
import type { FoodItem } from '../sim/types';
import { maxEnergy, maxHealth } from '../sim/vitals';
import { createWorld } from '../sim/world';
import type { App } from './app';
import { adultRadius } from './app-session';
import { type BsDebug, type BsGenome, type BsState, installHook } from './debug';
import { PondFood } from './pond-food';
import { PondTime } from './pond-time';

/** `debug.steerTo` gives up after this many ticks (30 s). */
const STEER_TIMEOUT_TICKS = 30 * TICK_HZ;

/** The `?debug=1` helpers: they change only this tab's state, never the authority's. */
function debugHelpers(app: App): BsDebug {
  /** Teleports the player and snaps the camera onto it (`setZone`, `freezeAt`). */
  const placeCamera = (x: number, y: number): void => {
    const { player } = app.session;
    debug.teleport(x, y);
    app.camera.snap({ x, y, radius: Math.sqrt(player.biomass), adult: adultRadius(player) });
    app.field.now();
  };
  const debug: BsDebug = {
    setEnergy(energy) {
      const { player } = app.session;
      player.energy = Math.min(energy, maxEnergy(player.biomass));
      app.hud.update(player);
    },
    setBiomass(biomass) {
      const { session } = app;
      const { player } = session;
      const energy = player.energy / maxEnergy(player.biomass);
      const health = player.health / maxHealth(player.biomass);
      player.biomass = biomass;
      player.energy = energy * maxEnergy(biomass);
      player.health = health * maxHealth(biomass);
      session.peakBiomass = Math.max(session.peakBiomass, biomass);
      app.hud.update(player);
    },
    teleport(x, y) {
      const { player } = app.session;
      player.x = x;
      player.y = y;
      player.vx = 0;
      player.vy = 0;
      app.prev.x = x;
      app.prev.y = y;
    },
    setZone(zone) {
      const { world, player } = app.session;
      const at = nearestInZone(world.seed32, world.size, player.x, player.y, zone);
      placeCamera(at.x, at.y);
      return at;
    },
    nearestFood(kind) {
      const { player } = app.session;
      let best: FoodItem | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const item of app.food) {
        if (kind !== undefined && item.kind !== kind) continue;
        const distance = Math.hypot(item.x - player.x, item.y - player.y);
        if (distance < bestDistance) {
          best = item;
          bestDistance = distance;
        }
      }
      return best;
    },
    steerTo(target) {
      app.steering?.done(false);
      app.steering = null;
      if (!app.session.player.alive) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        app.steering = { target: { ...target }, ticksLeft: STEER_TIMEOUT_TICKS, done: resolve };
      });
    },
    spawnPlume(x, y, radius = 80) {
      const { extraPlumes } = app.session.world;
      extraPlumes.push({ id: `debug${extraPlumes.length}`, x, y, radius });
      app.field.now();
    },
    setRemotes(specs) {
      for (const { spec } of app.scripted) {
        app.dropPeer(spec.id);
      }
      app.scripted = specs.map((spec) => {
        app.remotes.setMember(spec.id, spec.name);
        if (spec.genome !== undefined && !spec.withholdGenome)
          app.remoteBodies.add(spec.id, spec.genome);
        const sender = new SnapshotSender((bytes) => {
          const snapshot = decodeSnapshot(bytes);
          if (snapshot) app.remotes.receive(spec.id, snapshot, performance.now());
        });
        const genome = spec.genome === undefined ? null : parseGenomeText(spec.genome);
        const ref = genome ? genomeRefOf(genomeHash(genome)) : 0;
        return { spec, sender, startedMs: performance.now(), ref };
      });
    },
    joinPond(spec) {
      const clock = new PondClock();
      const now = performance.now();
      clock.addSample(now, now, spec.hubNow);
      const world = createWorld({ seed: spec.seed });
      app.pond = {
        id: 'debug',
        seed: spec.seed,
        size: RULES.world.size,
        ring: null,
        lives: 0,
        time: new PondTime(clock, spec.epoch),
        food: new PondFood(app.playerId ?? 'local', spec.send),
        world,
      };
    },
    deliver(from, raw) {
      const event = parsePeerEvent(JSON.stringify(raw));
      if (!event) return;
      app.online.receiveFoodEvent(from, event);
      app.social.receive(from, event);
      if (event.t === 'genome') app.remoteBodies.add(from, event.data);
    },
    hasFood: (id) => app.food.some((f) => f.id === id),
    setBench(ms) {
      app.autoQuality.setBench(ms, performance.now());
    },
    timeScale(next) {
      app.clock();
      app.scale = next;
    },
    freezeAt(tick, x, y) {
      debug.timeScale(0);
      app.session.world.tick = tick;
      placeCamera(x, y);
    },
    resetWater() {
      app.frame.view.flow.x = 0;
      app.frame.view.flow.y = 0;
      app.heldMs = app.lastMs;
    },
    setClock(seconds) {
      app.heldMs = app.lastMs - seconds * 1000;
    },
  };
  return debug;
}

/** The zone and depth under the player (M6 T16); null on the title screen. */
const zoneState = (app: App): Pick<BsState, 'zone' | 'depth'> => {
  const { session } = app;
  if (session.demo) return { zone: null, depth: null };
  const { world, player } = session;
  const depth = depthAt(world.seed32, player.x, player.y);
  return { zone: zoneOfDepth(depth), depth };
};

const mateState = (app: App): BsState['mate'] => {
  const m = app.mate.view();
  return {
    state: m.state,
    text: app.ui.mateHint.textContent ?? '',
    invite: m.invite && { name: m.invite.name, from: m.invite.from, leftMs: m.inviteLeftMs },
    visited: [...app.mate.visited],
    ready: app.readyShown,
  };
};

const offspringState = (app: App): BsState['offspring'] => {
  const { offspring } = app;
  const view = offspring.view();
  const child = offspring.child();
  return {
    kind: view.kind,
    creature: child?.born.record.hash ?? null,
    species: child?.body.species ?? null,
    rarity: child?.body.rarity ?? null,
    generation: child?.generation ?? null,
    genomeHash: child?.body.hash ?? null,
    cardShown: !app.ui.cardElement.hidden,
    eggShown: app.eggs.ownShown,
    options: app.screens.optionIds,
  };
};

const genome: BsGenome = {
  hashes: (list) =>
    list.map((text) => {
      const g = genomeFromBase64url(text);
      if (!g) throw new RangeError('not a base64url genome');
      const c = buildCreature(g);
      return { planHash: hashPlan(c.plan), statsHash: hashStats(c.stats) };
    }),
};

/** Installs `window.__bs`: read-only views and replay always, the debug helpers under `?debug=1`. */
export function installAppHook(app: App): void {
  const debug = debugHelpers(app);
  const { scene, fx, shake, camera, eggs, flow, keeper, social } = app;
  installHook({
    ready: true,
    state: () => {
      const { session, pond, settings, autoQuality, lastClock, playerId } = app;
      const { cardElement, cardTier } = app.ui;
      const { eggOnScreen, eggAt } = app.frame;
      return {
        screen: app.screen,
        quality: {
          setting: settings.quality,
          detected: autoQuality.detected,
          bench: autoQuality.status,
        },
        tick: session.world.tick,
        ...zoneState(app),
        playerId,
        renewed: app.renewal.heard,
        visibleFood: app.food.length,
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
              speed: Math.hypot(session.player.vx, session.player.vy),
              elder: session.player.elder,
              genomeHash: session.body.hash,
              species: session.body.species,
              silhouette: silhouetteOf(session.body.creature.plan),
              rarity: session.body.rarity,
              tier: session.body.tier,
              stats: session.player.phys,
            },
        death: session.death,
        life: {
          ...flow.view(),
          genome: session.demo ? null : session.body.hash,
          stage: lastClock?.stage ?? null,
          remainingMs: lastClock?.remainingMs ?? null,
          limitMs: app.limitLeft(),
        },
        mate: mateState(app),
        offspring: offspringState(app),
        remotes: app.remoteViews.map(
          ({ id, name, x, y, alpha, radius, genomeHash, species, egg }) => ({
            id,
            name,
            x,
            y,
            alpha,
            radius,
            genomeHash,
            species,
            egg,
          }),
        ),
        audio: app.sound.view(),
        hud: { menu: app.menu.isOpen, ...app.hud.view(), hints: app.ui.shownHint },
        egg: {
          phase: eggs.reveal.phase,
          phases: [...eggs.reveal.visited],
          carried: app.offspring.child() !== null,
          shown: eggs.ownShown,
          peers: [...eggs.peerIds],
          ghost: eggs.ghostOf(app.eggClock()) !== null,
          motion: app.motionReduced() ? 'fade' : 'shake',
          angle: eggs.angleAt(app.eggClock(), app.motionReduced()),
          glow: eggs.pose.glow,
          at: eggOnScreen ? { ...eggAt } : null,
          card: app.revealCard.shown
            ? { shown: true, tier: app.revealCard.tier }
            : { shown: !cardElement.hidden, tier: cardElement.hidden ? null : cardTier },
        },
        pond: pond
          ? {
              id: pond.id,
              seed: pond.seed,
              members: [
                playerId ?? 'local',
                ...(keeper.current?.others().map((m) => m.playerId) ?? []),
              ].sort(),
            }
          : null,
        social: {
          chat: social.log().map((line) => ({ ...line })),
          muted: [...social.muted.ids()],
          emotes: [...social.emotes()].map(([from, cue]) => ({ from, emote: cue.id })),
          pings: social.pings().map(({ from, kind, x, y }) => ({ from, kind, x, y })),
          dropped: social.dropped,
        },
        indicators: app.frame.indicators.map((i) => ({ ...i })),
        wheel: app.wheel.info(),
        map: app.pondMap.info(),
        minimap: app.minimap.info(),
        net: {
          text: app.online.shownStatus,
          status: keeper.current?.status ?? 'none',
          open: keeper.current?.openCount() ?? 0,
          foodIgnored: pond?.food.ignored ?? 0,
          dropped: app.genomeSync.dropped + app.remoteBodies.dropped,
        },
      };
    },
    events: () => ({ ...app.session.counts }),
    audio: { render: renderOffline, renderCue: renderCueOffline },
    replay: (log) => {
      const { hash, events } = replay(log);
      return { hash, events };
    },
    life: {
      // Recomputes the DNA from the genesis the hub sent, so a test can compare it with the fixtures.
      recompute: async () => {
        const g = flow.lastGenesis();
        if (!g) return null;
        const [{ commitmentId, genesisFor }, { randomnessOf }] = await Promise.all([
          import('../ledger/genesis'),
          import('../ledger/drand'),
        ]);
        const commit = commitmentId(g.commit.commitment);
        return {
          rules: g.record.record.rules,
          round: g.beacon.round,
          commit,
          genomeHash: genomeHash(genesisFor(randomnessOf(g.beacon), commit)),
        };
      },
    },
    render: {
      info: () => scene.info(),
      specks: (layer) => scene.specks(layer),
      outlines: () => scene.outlinesDrawn(),
      eggAngle: (atMs) => eggs.angleAt(atMs, app.motionReduced()),
      fx: () => {
        const { cell } = app.frame;
        return {
          ...fx.snapshot(),
          shake: {
            body:
              Math.hypot(shake.body.x, shake.body.y) *
              cell.radius *
              (cell.scale ?? 1) *
              scene.pxPerWu,
            camera: Math.hypot(shake.camera.x, shake.camera.y),
            kind: shake.kind,
          },
          halfHeight: camera.halfHeight,
          camX: camera.x,
          camY: camera.y,
        };
      },
    },
    ...(app.params.debug ? { debug, genome } : {}),
  });
}
