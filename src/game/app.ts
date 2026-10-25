import { indexedDbKeyStore } from '../ledger/idb-keystore';
import type { Identity } from '../ledger/identity';
import { createIdentity, memoryKeyStore } from '../ledger/identity';
import { consumedParts } from '../net/claims';
import { PondClock } from '../net/clock';
import { isFinalStatus, type Welcome } from '../net/hub-client';
import { RemoteSet, type RemoteView, SnapshotSender, snapshotOf } from '../net/pond-sync';
import {
  decodeSnapshot,
  type Member,
  type PeerEvent,
  parsePeerEvent,
  type Vec2,
} from '../net/protocol';
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
import { AloneHint } from './alone-hint';
import { type BsDebug, installHook, type ScriptedRemote } from './debug';
import { pick } from './dom';
import { createFieldSync } from './field';
import { Hud } from './hud';
import { enterHatches, InputController } from './input';
import { RemoteLabels } from './labels';
import { resetLife } from './life-reset';
import { attachVisibilityPause, createLoop } from './loop';
import { connectOnline, type OnlineSession } from './online';
import {
  cleanName,
  hubSocketUrl,
  loadName,
  ringSpawn,
  saveName,
  statusText,
  switchPond,
  tryOnline,
} from './online-config';
import { OnlineKeeper } from './online-keeper';
import { PondFood } from './pond-food';
import { PondTime } from './pond-time';
import { type DeathSummary, type Screen, Screens } from './screens';
import { MuteList, Social } from './social';
import { type Anchor, SocialUi } from './social-ui';

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
const NO_REMOTES: readonly RemoteView[] = [];
const NO_MEMBERS: readonly Member[] = [];
/** A hatch waits this long for the hub before the player swims in a local pond. */
const HATCH_WAIT_MS = 4000;

/** Local storage, or null where the browser blocks it. */
function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** One creature in one world: the title screen's drifting cell, or a real hatch. */
interface Session {
  world: World;
  player: CreatureState;
  /** The title screen's cell: harmless, fed, and steered by a script. */
  demo: boolean;
  counts: Record<string, number>;
  peakBiomass: number;
  death: DeathSummary | null;
  /** The pond this life is in; null for the title cell and for a local pond. */
  pond: Pond | null;
}

interface Steering {
  target: { id?: string; x: number; y: number };
  ticksLeft: number;
  done(reached: boolean): void;
}

/** The pond this tab has joined: one seed, one clock and one set of eaten food for every life. */
interface Pond {
  id: string;
  seed: string;
  size: number;
  /** The hub's spawn ring: centre and this player's first spawn; null without a hub. */
  ring: { centre: Vec2; hint: Vec2 } | null;
  /** Lives started in this pond, to turn the spawn point on the ring. */
  lives: number;
  time: PondTime;
  food: PondFood;
  /** Stands in for the world when a food event arrives between lives; never stepped. */
  world: World;
}

function newSession(
  seed: string,
  demo: boolean,
  pond: Pond | null = null,
  spawn: Vec2 | null = null,
): Session {
  const world = createWorld({
    seed: demo ? `${seed}/title` : seed,
    hazards: !demo,
    ...(pond ? { size: pond.size } : {}),
  });
  if (pond) {
    world.consumed = pond.world.consumed;
    pond.time.join(world, performance.now());
  }
  const spot = findClearSpot(world, spawn?.x ?? world.size / 2, spawn?.y ?? world.size / 2);
  const player = spawnCreature(world, { id: 'player', ...spot });
  return { world, player, demo, counts: {}, peakBiomass: player.biomass, death: null, pond };
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

  // Other players, drawn from the snapshots they send. Pond time is the hub's clock once a pond is
  // joined; until then it is this tab's own clock.
  const remotes = new RemoteSet();
  let pond: Pond | null = null;
  const pondMs = (): number => (pond ? pond.time.pondMs(performance.now()) : performance.now());
  let remoteViews: readonly RemoteView[] = [];
  interface Scripted {
    spec: ScriptedRemote;
    sender: SnapshotSender;
    startedMs: number;
  }
  let scripted: Scripted[] = [];

  // Without IndexedDB (a private window, say) the identity lasts for this visit only.
  let playerId: string | null = null;
  let identity: Identity | null = null;
  const identityReady = createIdentity(indexedDbKeyStore())
    .catch(() => createIdentity(memoryKeyStore()))
    .then((loaded) => {
      identity = loaded;
      playerId = loaded.playerId;
    });

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

  // A slew factor belongs to the pond clock it chases, and an open chat would swallow Enter.
  const endLifeState = (): void =>
    resetLife({ setSpeed: (speed) => loop.setSpeed(speed), closeChat: () => socialUi.close() });

  const enter = (next: Session, nextScreen: Screen): void => {
    session = next;
    endLifeState();
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

  // The online session (ADRs 0007, 0016): the hub roster, the mesh and the pond they share. Without
  // a hub URL the game runs offline, as in M1.
  const hubUrl = hubSocketUrl(window.location.search, __AUTHORITY_URL__);
  const keeper = new OnlineKeeper<OnlineSession>({
    start: (name) => {
      social.selfName = name;
      social.reset();
      return startOnline(name, identity as Identity);
    },
    stop: (link) => {
      for (const { playerId: id } of link.others()) remotes.removeMember(id);
      link.dispose();
    },
    isFinal: (link) => isFinalStatus(link.status),
  });
  const storage = safeStorage();
  const nameField = pick('[data-testid="name-field"]');
  const nameInput = pick<HTMLInputElement>('[data-testid="name-input"]');
  const nameError = pick('[data-testid="name-error"]');
  const netStatus = pick('[data-testid="net-status"]');
  const aloneElement = pick('[data-testid="alone-hint"]');
  const alone = new AloneHint();
  const sender = new SnapshotSender((bytes) => keeper.current?.broadcastState(bytes));

  // Chat, emotes and pings travel on the reliable event channel; the rules live in `Social`.
  const selfKey = (): string => playerId ?? 'local';
  const social = new Social({
    now: () => performance.now(),
    nameOf: (id) => keeper.current?.nameOf(id),
    send: (event) => keeper.current?.broadcastEvent(event),
    muted: new MuteList(storage),
    selfName: 'You',
  });
  const socialUi = new SocialUi(social, {
    submit: (text) => social.sendChat(text, selfKey()),
    typing: (on) => {
      controller.typing = on;
      if (on) controller.reset();
    },
  });
  const worldAt = (px: number, py: number): Vec2 => ({
    x: camera.x + (px - scene.width / 2) / scene.pxPerWu,
    y: camera.y - (py - scene.height / 2) / scene.pxPerWu,
  });
  const playing = (): boolean => screen === 'playing' && !session.demo && session.death === null;
  const anchors = new Map<string, Anchor>();

  const makePond = (w: Welcome, hubClock: PondClock): Pond => ({
    id: w.pond.id,
    seed: w.pond.seed,
    size: w.pond.size,
    ring: { centre: w.pond.centre, hint: w.you.spawnHint },
    lives: 0,
    time: new PondTime(hubClock, w.pond.epoch),
    food: new PondFood(playerId ?? 'local', (event) => keeper.current?.broadcastEvent(event)),
    world: createWorld({ seed: w.pond.seed, size: w.pond.size }),
  });

  const startOnline = (name: string, loaded: Identity): OnlineSession => {
    const link = connectOnline({
      url: hubUrl as string,
      identity: loaded,
      name,
      handlers: {
        welcome(w) {
          const life = session.demo ? null : session.pond;
          const next = switchPond(pond, life, w.pond.id, () => makePond(w, link.clock));
          if (next.changed) {
            pond = next.pond;
            social.reset();
            // A life in the old pond carries on in a local one; the chip says so.
            if (life && !next.life) {
              session.pond = null;
              // The old pond's eaten food is not this life's any more.
              session.world.consumed = { ...session.world.consumed };
              loop.setSpeed(1);
            }
          }
          social.worldSize = w.pond.size;
        },
        member(op, member) {
          if (op === 'join') remotes.setMember(member.playerId, member.name);
          else remotes.removeMember(member.playerId);
        },
        peerOpen(id) {
          // The new peer learns what has been eaten; the reliable channel keeps the parts in order.
          if (pond) for (const part of consumedParts(pond.world)) link.sendEvent(id, part);
        },
        state(id, snapshot) {
          remotes.receive(id, snapshot, performance.now());
        },
        event(id, event) {
          receiveFoodEvent(id, event);
          social.receive(id, event);
        },
      },
    });
    return link;
  };

  /** Connects (or reconnects under a new name) once the identity is loaded. */
  const ensureOnline = (name: string): void => {
    if (!hubUrl || !identity) return;
    keeper.ensure(name);
  };

  /** Starts a life, in the joined pond or (`inPond` false) in a local one. */
  // The first local hatch uses the pond seed as given; each later one gets its own pond.
  let hatches = 0;
  const begin = (inPond: boolean): void => {
    const target = inPond ? pond : null;
    const seed = hatches === 0 ? params.seed : `${params.seed}/${hatches}`;
    hatches++;
    let spawn: Vec2 | null = null;
    if (target?.ring) spawn = ringSpawn(target.ring.centre, target.ring.hint, target.lives);
    if (target) target.lives++;
    enter(newSession(target ? target.seed : seed, false, target, spawn), 'playing');
  };

  let hatching = false;
  const hatch = (): void => {
    if (hatching) return;
    if (!hubUrl) {
      begin(pond !== null);
      return;
    }
    const name = cleanName(nameInput.value);
    nameError.hidden = name !== null;
    if (!name) return;
    saveName(storage, name);
    hatching = true;
    screens.setBusy(true);
    // A hub that cannot be reached (or a failing connector) means a local pond, never a stuck screen.
    void tryOnline(() =>
      identityReady.then(() => {
        ensureOnline(name);
        return keeper.current?.whenReady(HATCH_WAIT_MS) ?? null;
      }),
    ).then((welcome) => {
      hatching = false;
      screens.setBusy(false);
      begin(welcome !== null && pond !== null);
    });
  };
  const screens = new Screens({ hatch });
  if (hubUrl) {
    nameField.hidden = false;
    nameInput.value = loadName(storage);
    void identityReady
      .then(() => ensureOnline(cleanName(nameInput.value) ?? loadName(storage)))
      .catch(() => {});
    // Leave the roster promptly instead of waiting for the hub to notice the dead socket. A page
    // restored from the back/forward cache joins again.
    window.addEventListener('pagehide', () => keeper.suspend());
    window.addEventListener('pageshow', () => keeper.resume());
  }
  // Enter hatches from the title and death screens (Space stays the dash key).
  // Enter opens the chat input while playing. T then 1-6, G and the middle button are social keys.
  controller.attach(
    window,
    document,
    () => {
      if (playing()) socialUi.open();
      else if (enterHatches(screen, performance.now() - screenShownAt)) hatch();
    },
    {
      key: (key) => {
        if (!playing()) return;
        const at = controller.pointerAt();
        social.key(key, selfKey(), at && worldAt(at.x, at.y));
      },
      middle: (x, y) => {
        if (playing()) social.ping(worldAt(x, y), selfKey());
      },
    },
  );

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
    // The stand-in world is never stepped; its tick is the pond clock the claims are judged by.
    pond.world.tick = pond.time.tickAt(performance.now());
    const stolen = pond.food.receive(pond.world, from, event);
    field.markDirty();
    // A bite is only given back by a life in this pond, never by a local one.
    if (!stolen || session.demo || session.pond !== pond) return;
    const { player, counts } = session;
    player.energy = Math.max(0, player.energy - stolen.value);
    counts.stolen = (counts.stolen ?? 0) + 1;
    hud.update(player);
  };

  /** The pond, while a real life (not the title screen's cell) is running in it. */
  const livePond = (): Pond | null => (session.demo ? null : session.pond);

  const tick = (): void => {
    const { world, player, counts } = session;
    // The world stops when the player has died: nothing changes behind the death screen.
    if (session.death !== null) return;
    prev.x = player.x;
    prev.y = player.y;
    prev.heading = player.heading;
    input = chooseInput();
    const live = livePond();
    if (live && scale === 1) loop.setSpeed(live.time.update(world, performance.now()));
    const at = world.tick;
    const events = step(world, { [player.id]: input });
    live?.food.onEat(events, at);
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
      endLifeState();
    }
  };

  let shownStatus = '';
  const updateNetUi = (now: number, joined: Pond | null): void => {
    // A life in a local pond is alone, whatever the hub says about its own pond.
    const apart = screen === 'playing' && !session.demo && session.pond === null;
    let text = '';
    if (hubUrl) {
      text = apart
        ? statusText('offline', 1)
        : statusText(keeper.current?.status ?? 'connecting', keeper.current?.count ?? 1);
    }
    if (text !== shownStatus) {
      shownStatus = text;
      netStatus.textContent = text;
    }
    const lonely = alone.update(
      now,
      joined !== null && keeper.current?.status === 'online',
      (keeper.current?.count ?? 1) - 1,
    );
    if (aloneElement.hidden === lonely) aloneElement.hidden = !lonely;
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
    const joined = livePond();
    if (joined && joined === pond && (keeper.current?.openCount() ?? 0) > 0) {
      sender.update(now, document.hidden, () => snapshotOf(player, session.world.tick));
    }
    // A local pond life does not show the players of the hub's pond.
    remoteViews = !keeper.current || joined ? remotes.sample(now, pondMs()) : NO_REMOTES;
    updateNetUi(now, joined);
    view.remotes = remoteViews;
    const projection = {
      camX: camera.x,
      camY: camera.y,
      pxPerWu: scene.pxPerWu,
      width: scene.width,
      height: scene.height,
    };
    labels.update(remoteViews, projection);
    if (screen === 'playing') {
      anchors.clear();
      anchors.set(selfKey(), { x: cell.x, y: cell.y, radius: cell.radius });
      for (const r of remoteViews) if (r.alpha >= 0.01) anchors.set(r.id, r);
      socialUi.update(now, anchors, keeper.current?.others() ?? NO_MEMBERS, projection);
    }
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
    livePond()?.time.resnap(session.world, performance.now());
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
        id: 'debug',
        seed: spec.seed,
        size: RULES.world.size,
        ring: null,
        lives: 0,
        time: new PondTime(clock, spec.epoch),
        food: new PondFood(playerId ?? 'local', spec.send),
        world,
      };
    },
    deliver(from, raw) {
      const event = parsePeerEvent(JSON.stringify(raw));
      if (event) receiveFoodEvent(from, event);
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
      net: {
        text: shownStatus,
        status: keeper.current?.status ?? 'none',
        open: keeper.current?.openCount() ?? 0,
        foodIgnored: pond?.food.ignored ?? 0,
      },
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
