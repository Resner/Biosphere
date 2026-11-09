import { renderCueOffline, renderOffline } from '../audio/engine';
import { genomeFromBase64url, genomeHash, parseGenomeText } from '../genome/codec';
import { hashPlan } from '../genome/develop';
import { silhouetteOf } from '../genome/silhouette';
import { buildCreature, hashStats } from '../genome/stats';
import { PondClock } from '../net/clock';
import { DEFAULT_CAP } from '../net/connection-policy';
import { SnapshotSender } from '../net/pond-sync';
import { decodeSnapshot, genomeRefOf, parsePeerEvent } from '../net/protocol';
import { nearestInZone } from '../render/zones';
import { depthAt, zoneOfDepth } from '../sim/bathymetry';
import { livePieces } from '../sim/carrion';
import { replayEncounter } from '../sim/encounter/replay';
import { replay } from '../sim/replay';
import { RULES, TICK_HZ } from '../sim/rules';
import type { FoodItem } from '../sim/types';
import { maxEnergy, maxHealth } from '../sim/vitals';
import { createWorld } from '../sim/world';
import type { App } from './app';
import { adultRadius } from './app-session';
import { checkCrowdAt } from './crowd-view';
import { type BsDebug, type BsState, installHook } from './debug';
import { GOLDEN_SET_NAMES } from './golden-names';
import type { NetLinks } from './online';
import { PondFood } from './pond-food';
import { PondTime } from './pond-time';

/** `state().net`'s links without a session. */
const NO_NET: NetLinks = {
  links: [],
  known: { snapshot: 0, gossip: 0, directory: 0, signal: 0 },
  crowded: false,
  where: { sent: 0, leaf: null },
  signals: { hub: 0, relayed: 0, forwarded: 0, forged: 0 },
  helloFailed: 0,
  instance: { n: 0, changes: 0, crowded: false, crowdSent: 0 },
};

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
    setHealth(hp) {
      const { player } = app.session;
      player.health = Math.max(0, Math.min(hp, maxHealth(player.biomass)));
      app.hud.update(player);
    },
    autoBrace(on) {
      app.fight.autoBrace = on;
    },
    hover(target) {
      app.steering?.done(false);
      app.steering = null;
      app.hover = target && { id: target.id, distance: target.distance };
    },
    skipDraw(on) {
      app.scene.skipDraw = on;
    },
    audit: (audit, beacon, keys) => app.duty.audit(audit, beacon, keys),
    holdBelly(on) {
      app.fight.holdBelly = on;
    },
    netCap(cap) {
      if (!Number.isInteger(cap) || cap < 1 || cap > DEFAULT_CAP) {
        throw new RangeError(`netCap takes 1 to ${DEFAULT_CAP}, got ${cap}`);
      }
      app.netCap = cap;
      app.keeper.current?.setCap(cap);
    },
    aloneMs(ms) {
      if (!Number.isInteger(ms) || ms < 0)
        throw new RangeError(`aloneMs takes whole ms, got ${ms}`);
      app.ride.aloneMs = ms;
    },
    crowdAt(n) {
      app.crowdAt = checkCrowdAt(n);
      app.keeper.current?.setCrowdAt(n);
    },
    async progressNow() {
      await app.keeper.current?.readRelay();
      const { session } = app;
      if (!session.demo && session.player.cause === null)
        app.flow.report(session.ticks, session.player);
    },
    teleport(x, y) {
      const { player } = app.session;
      player.x = x;
      player.y = y;
      player.vx = 0;
      player.vy = 0;
      app.prev.x = x;
      app.prev.y = y;
      // The zones' depth window fills at once there, as a new life's does.
      app.scene.settleZones();
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
      app.hover = null;
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
    setKnown(known) {
      const now = performance.now();
      app.debugKnown = known.map(({ id, name, x, y, age }) => ({ id, name, x, y, at: now - age }));
    },
    joinWorld(spec) {
      const clock = new PondClock();
      const now = performance.now();
      clock.addSample(now, now, spec.hubNow);
      const world = createWorld({ seed: spec.seed });
      app.pond = {
        id: 'debug',
        seed: spec.seed,
        size: RULES.world.size,
        centre: { x: RULES.world.size / 2, y: RULES.world.size / 2 },
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
    dutyFrameMs(ms) {
      app.duty.frameMs = ms;
    },
    timeScale(next) {
      app.clock();
      app.scale = next;
    },
    freezeAt(tick, x, y) {
      debug.timeScale(0);
      // The loop may still hold the real time of frames that ran before the freeze (a slow runner
      // draws seldom); dropping it keeps those ticks from moving the player off its place.
      app.loop.pause();
      app.loop.resume();
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
  const depth = depthAt(world.seed32, player.x, player.y, world.size);
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

/** The egg's charge, hint, paced crack and still scene (M6c T11). */
const eggCharge = (app: App) => {
  const { reveal } = app.eggs;
  const { phase } = reveal;
  const known = (ms: number) => (Number.isFinite(ms) ? ms : null);
  return {
    charge: reveal.charge,
    hint:
      phase === 'none'
        ? null
        : phase === 'waiting' || reveal.tier === null
          ? ('cycling' as const)
          : reveal.tier,
    paced: reveal.paced,
    beaconAt: known(reveal.beaconAt),
    crackAt: known(reveal.crackedAt()),
    crackedBy: reveal.crackedBy,
    still: app.eggs.still(),
    dim: app.frame.view.dim,
  };
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
        report: app.awayReport.told,
        visibleFood: app.food.length,
        carrion: livePieces(session.world).map(({ id, x, y, value, radius }) => ({
          id,
          x,
          y,
          value,
          radius,
        })),
        encounter: app.fightShow.view(),
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
          ({
            id,
            name,
            x,
            y,
            alpha,
            radius,
            genomeHash,
            species,
            egg,
            spawnProtected,
            fighting,
            away,
            pace,
          }) => ({
            instance: keeper.current?.crowd.of(id) ?? 0,
            id,
            name,
            x,
            y,
            alpha,
            radius,
            genomeHash,
            species,
            egg,
            protected: spawnProtected,
            fighting,
            away,
            pace,
          }),
        ),
        attack: app.attack.info(),
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
          ...eggCharge(app),
        },
        world: pond
          ? {
              id: pond.id,
              seed: pond.seed,
              size: pond.size,
              centre: { ...pond.centre },
            }
          : null,
        spawn: app.spawnAsk.last ? { ...app.spawnAsk.last } : null,
        queue: keeper.current?.queue ? { ...keeper.current.queue } : null,
        ride: app.ride.view(),
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
          signed: app.online.signed.size,
          badSignatures: app.online.signed.badSignatures,
          heldTicks: app.online.signed.ticks(),
          proxyDropped: app.online.proxies.dropped,
          proxyFrom: app.online.proxies.senders(),
          dutyLinks: keeper.current?.dutyLinks() ?? [],
          strangers: keeper.current?.strangers ?? 0,
          relay: app.flow.relaySent,
          ...(keeper.current?.netInfo() ?? NO_NET),
        },
        witness: {
          avail: app.duty.avail.on,
          duty: app.duty.witness?.view() ?? null,
          last: app.duty.witness?.last ?? null,
          duties: app.duty.witness?.duties ?? 0,
          declined: app.duty.witness?.declined ?? 0,
          batches: app.duty.witness?.batches ?? 0,
          dutyMs: [...(app.duty.witness?.dutyMs ?? [])],
          auditing: app.duty.audits?.auditing ?? null,
          audits: [...(app.duty.audits?.audits ?? [])],
        },
      };
    },
    events: () => ({ ...app.session.counts }),
    replayEncounter: (log) => replayEncounter(log),
    goldens: {
      sets: () => [...GOLDEN_SET_NAMES],
      run: async (set, input) => (await import('./goldens')).runGolden(set, input),
    },
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
      info: () => ({ ...scene.info(), telegraphs: app.fightShow.telegraphs.info() }),
      specks: (layer) => scene.specks(layer),
      outlines: () => scene.outlinesDrawn(),
      gpu: () => scene.gpuExtent(),
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
            hits: shake.hits,
          },
          halfHeight: camera.halfHeight,
          camX: camera.x,
          camY: camera.y,
        };
      },
    },
    ...(app.params.debug ? { debug } : {}),
  });
}
