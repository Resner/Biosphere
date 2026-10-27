import { genomeFromBase64url, genomeHash, parseGenomeText } from '../genome/codec';
import { hashPlan } from '../genome/develop';
import { rarityOfTraits } from '../genome/rarity';
import { buildCreature, hashStats } from '../genome/stats';
import { indexedDbKeyStore } from '../ledger/idb-keystore';
import type { Identity } from '../ledger/identity';
import {
  createIdentity,
  importRecoveryCode,
  memoryKeyStore,
  toBase64Url,
} from '../ledger/identity';
import { consumedParts } from '../net/claims';
import { PondClock } from '../net/clock';
import { GenomeSync } from '../net/genome-sync';
import { isFinalStatus, type Welcome } from '../net/hub-client';
import { RemoteSet, SnapshotSender, snapshotOf } from '../net/pond-sync';
import {
  decodeSnapshot,
  genomeRefOf,
  type Member,
  type PeerEvent,
  parsePeerEvent,
  type Vec2,
} from '../net/protocol';
import { FollowCamera, viewHalfHeight } from '../render/camera';
import type { CellView } from '../render/cell';
import type { CreatureSource } from '../render/creature-cache';
import { Effects } from '../render/effects';
import { GameScene } from '../render/scene';
import { colliderReach } from '../sim/body';
import { foodNear } from '../sim/food';
import { plumesNear } from '../sim/hazards';
import { angleToSteer, IDLE, type Input } from '../sim/input';
import { applyLife, lifespanMs } from '../sim/life';
import { atan2, lerp, wrapAngle } from '../sim/math';
import { replay } from '../sim/replay';
import { RULES, TICK_HZ } from '../sim/rules';
import { sizeTier } from '../sim/size';
import { findClearSpot } from '../sim/spawn';
import { step } from '../sim/step';
import type { CreatureState, FoodItem, StepEvent, World } from '../sim/types';
import { maxEnergy, maxHealth, starterEnergy } from '../sim/vitals';
import { createWorld, spawnCreature } from '../sim/world';
import { AloneHint } from './alone-hint';
import { type Body, bodyLabel, Hatcher, hatchBody } from './body';
import { type BsDebug, type BsGenome, installHook, type ScriptedRemote } from './debug';
import { pick } from './dom';
import { createFieldSync } from './field';
import { HistoryPanel } from './history';
import { Hud } from './hud';
import { enterHatches, InputController } from './input';
import { RemoteLabels } from './labels';
import { type LifeClock, LifeFlow, type Started, VERIFY_FAILED } from './life';
import { resetLife } from './life-reset';
import { countdownText } from './life-text';
import { attachVisibilityPause, createLoop } from './loop';
import { MateFlow, type Nearby, randomNonce } from './mate';
import { readyText } from './mate-text';
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
import { RecoveryPanel } from './recovery-panel';
import { type DrawnRemote, RemoteBodies } from './remote-bodies';
import { type DeathSummary, type Screen, Screens } from './screens';
import { MuteList, Social } from './social';
import { type Anchor, SocialUi } from './social-ui';

export interface GameParams {
  seed: string;
  debug: boolean;
  /** `?genome=`: pins the body to hatch with (a base64url genome or "starter"). */
  genome?: string | null;
}

/** Food drifts up to this far from its slot anchor; the field query reaches that much further. */
const FIELD_MARGIN = RULES.food.driftRadius + RULES.food.kinds.globule.radius;
const MAX_FRAME_SECONDS = 0.1;
/** `debug.steerTo` gives up after this many ticks (30 s). */
const STEER_TIMEOUT_TICKS = 30 * TICK_HZ;
/** With `timeScale`, a slow software-GL frame must still catch up: 120 ticks is 4 s of sim. */
const DEBUG_MAX_TICKS_PER_FRAME = 120;
const MAX_THROTTLE = RULES.movement.maxThrottle;
const NO_REMOTES: readonly DrawnRemote[] = [];
const NO_MEMBERS: readonly Member[] = [];
/** A hatch waits this long for the hub before the player swims in a local pond. */
const HATCH_WAIT_MS = 4000;
/** The creature's condition goes to the hub every 30 s of play (ADR 0019). */
const REPORT_EVERY_TICKS = 30 * TICK_HZ;
/** The first report comes early, so the life clock knows the hub's lifespan within seconds. */
const FIRST_REPORT_TICKS = 5 * TICK_HZ;
/** Once its time is up the creature asks the hub for the verdict every 2 s until it answers. */
const EXPIRY_RETRY_TICKS = 2 * TICK_HZ;

/** Local storage, or null where the browser blocks it. */
function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Tallies one item's bites and give-backs under `<type>@<id>`, so a test can follow a single item. */
const countItem = (counts: Record<string, number>, type: string, id: string): void => {
  const key = `${type}@${id}`;
  counts[key] = (counts[key] ?? 0) + 1;
};

/** One creature in one world: the title screen's drifting cell, or a real hatch. */
interface Session {
  world: World;
  player: CreatureState;
  /** The genome this life hatched with. */
  body: Body;
  /** The title screen's cell: harmless, fed, and steered by a script. */
  demo: boolean;
  counts: Record<string, number>;
  peakBiomass: number;
  death: DeathSummary | null;
  /** The pond this life is in; null for the title cell and for a local pond. */
  pond: Pond | null;
  /** Ticks this life has been simulated, and the count at which its next report is due. */
  ticks: number;
  nextReport: number;
  /** The tick count of the last report sent because the lifespan ran out; -1 before any. */
  lastExpiryAsk: number;
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
  body: Body,
  pond: Pond | null = null,
  spawn: Vec2 | null = null,
  biomass: number = RULES.starter.biomass,
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
  const { phys } = body.creature;
  const reach = colliderReach(phys, biomass);
  const spot = findClearSpot(world, spawn?.x ?? world.size / 2, spawn?.y ?? world.size / 2, reach);
  const player = spawnCreature(world, { id: 'player', ...spot, phys, biomass });
  return {
    world,
    player,
    body,
    demo,
    counts: {},
    peakBiomass: player.biomass,
    death: null,
    pond,
    ticks: 0,
    nextReport: FIRST_REPORT_TICKS,
    lastExpiryAsk: -1,
  };
}

/** Starts the title screen; the player hatches into the same scene. */
export function startApp(canvas: HTMLCanvasElement, params: GameParams): void {
  const scene = new GameScene(canvas, RULES.world.size);
  const camera = new FollowCamera();
  const controller = new InputController();
  const hud = new Hud();
  const history = new HistoryPanel();
  const fx = new Effects();
  const vignette = pick('[data-testid="vignette"]');
  const labels = new RemoteLabels(pick('[data-testid="remote-labels"]'));

  // Other players, drawn from the snapshots they send. Pond time is the hub's clock once a pond is
  // joined; until then it is this tab's own clock.
  const remotes = new RemoteSet();
  let pond: Pond | null = null;
  const pondMs = (): number => (pond ? pond.time.pondMs(performance.now()) : performance.now());
  const remoteBodies = new RemoteBodies();
  let remoteViews: readonly DrawnRemote[] = [];
  interface Scripted {
    spec: ScriptedRemote;
    sender: SnapshotSender;
    startedMs: number;
    /** The genome ref its snapshots carry. */
    ref: number;
  }
  let scripted: Scripted[] = [];

  // Without IndexedDB (a private window, say) the identity lasts for this visit only.
  let playerId: string | null = null;
  let identity: Identity | null = null;
  let keyStore = indexedDbKeyStore();
  let keyKept = true;
  const identityReady = createIdentity(keyStore)
    .catch(() => {
      keyStore = memoryKeyStore();
      keyKept = false;
      return createIdentity(keyStore);
    })
    .then((loaded) => {
      // A reload would lose a code kept only in memory, so there is nothing to import into.
      if (!keyKept) recovery.disable();
      identity = loaded;
      playerId = loaded.playerId;
    });

  // A recovery code moves the identity to another browser. After a replace the page reloads, so
  // the new identity connects and the old tab's session is replaced by the hub (single session).
  const recovery = new RecoveryPanel({
    code: () => identity?.exportRecoveryCode() ?? '',
    replace: async (code) => {
      await identityReady;
      await importRecoveryCode(keyStore, code);
      location.reload();
    },
  });

  // The recorded life (M4): genesis from the hub, resume, progress and death. A cell it does not
  // know (a pinned body, no hub, an empty hatch bucket) is a practice cell and sends nothing.
  const flow = new LifeFlow({
    identity: () => identity as Identity,
    nonce: () => toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    // BLS12-381 is heavy: its code loads when the first genesis arrives.
    verify: async (g) => {
      const { checkGenesis } = await import('../ledger/genesis');
      return checkGenesis(g.record.record, g.commit.commitment, g.beacon, g.genome);
    },
  });
  const hatchNote = pick('[data-testid="hatch-note"]');
  const practiceBadge = pick('[data-testid="practice-badge"]');
  /** Why the last hatch did not start; shown until the next one. */
  let hatchError = '';
  /** When the recorded hatches are used up: the time (performance.now) the next one frees; 0 when free. */
  let limitUntil = 0;
  const limitLeft = (): number => Math.max(0, limitUntil - performance.now());
  /** The life clock as of the last tick; null for a practice cell and between lives. */
  let lastClock: LifeClock | null = null;

  // Courting (M5): the creature as the mating rules see it, and what the hub is asked.
  const mate = new MateFlow({
    identity: () => identity as Identity,
    nonce: randomNonce,
    now: () => performance.now(),
    nameOf: (id) => keeper.current?.nameOf(id),
    own: () => {
      const life = flow.view();
      const { player } = session;
      if (session.demo || life.status !== 'playing' || !life.creature || !player.alive) return null;
      return {
        creature: life.creature,
        owner: playerId ?? '',
        active: true,
        activeMs: lastClock?.activeMs ?? life.activeMs,
        // The first ack brings the real numbers; until then nobody is mature.
        matureAtMs: life.matureAtMs > 0 ? life.matureAtMs : Number.POSITIVE_INFINITY,
        cooldownUntilMs: life.cooldownUntilMs,
        biomass: player.biomass,
        energy: player.energy,
        hasPending: life.pending,
        inFlight: false,
        locked: false,
      };
    },
  });
  const mateHint = pick('[data-testid="mate-hint"]');
  const invitePanel = pick('[data-testid="invite"]');
  const inviteName = pick('[data-testid="invite-name"]');
  const inviteBody = pick('[data-testid="invite-body"]');
  const inviteBand = pick('[data-testid="invite-band"]');
  const inviteLeft = pick('[data-testid="invite-left"]');
  /** The creature in reach that E would court, as of the last frame. */
  let nearby: Nearby | null = null;
  let reminded = false;

  let scale = 1;
  // Genesis DNA needs a number the sim never sees; the browser supplies it.
  const hatcher = new Hatcher({
    pinned: params.genome ?? null,
    random: () => crypto.getRandomValues(new Uint32Array(2)).join('-'),
    warn: (message) => console.warn(message),
  });
  let session = newSession(params.seed, true, hatcher.title());
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
    if (!session.demo) {
      hud.setBody(bodyLabel(session.body));
      genomeSync.setOwn(session.body.text);
    }
    view.body = session.body.creature;
    lastClock = null;
    hud.setLife(null);
    practiceBadge.hidden = session.demo || flow.view().status !== 'practice';
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
      for (const { playerId: id } of link.others()) dropPeer(id);
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
  // Bodies on the wire (M3 T16): the genome goes out when a link opens and after every rehatch.
  const dropPeer = (id: string): void => {
    remotes.removeMember(id);
    remoteBodies.remove(id);
    genomeSync.forget(id);
  };
  const genomeSync = new GenomeSync({
    send: (id, event) => keeper.current?.sendEvent(id, event),
    broadcast: (event) => keeper.current?.broadcastEvent(event),
    hasLink: (id) => keeper.current?.hasLink(id) === true,
    accept: (id, text) => remoteBodies.add(id, text),
  });

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
          mate.attach(link);
        },
        life(msg) {
          flow.receive(msg);
          mate.receive(msg);
          if (msg.t === 'born') hud.toast('Your offspring is ready');
          if (msg.t === 'history') history.show(msg.lives, Date.now());
          // Past lives are asked for once the hub has said who the player is, and after each death.
          if (msg.t === 'life' || msg.t === 'died') link.send({ t: 'history' });
        },
        member(op, member) {
          if (op === 'join') {
            remotes.setMember(member.playerId, member.name);
          } else {
            dropPeer(member.playerId);
          }
        },
        peerOpen(id) {
          // The new peer learns what has been eaten; the reliable channel keeps the parts in order.
          if (pond) for (const part of consumedParts(pond.world)) link.sendEvent(id, part);
          genomeSync.peerOpen(id);
        },
        state(id, snapshot) {
          remotes.receive(id, snapshot, performance.now());
        },
        event(id, event) {
          receiveFoodEvent(id, event);
          social.receive(id, event);
          genomeSync.receive(id, event, performance.now());
        },
      },
    });
    flow.attach(link);
    mate.attach(link);
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
  const begin = (inPond: boolean, recorded?: { body: Body; start: Started }): void => {
    const target = inPond ? pond : null;
    const seed = hatches === 0 ? params.seed : `${params.seed}/${hatches}`;
    hatches++;
    let spawn: Vec2 | null = null;
    if (target?.ring) spawn = ringSpawn(target.ring.centre, target.ring.hint, target.lives);
    if (target) target.lives++;
    hatchError = '';
    const next = newSession(
      target ? target.seed : seed,
      false,
      recorded?.body ?? hatcher.next(),
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
    enter(next, 'playing');
  };

  let hatching = false;
  const hatch = (): void => {
    if (hatching || limitLeft() > 0) return;
    limitUntil = 0;
    if (!hubUrl) {
      flow.practice();
      begin(pond !== null);
      return;
    }
    const name = cleanName(nameInput.value);
    nameError.hidden = name !== null;
    if (!name) return;
    saveName(storage, name);
    hatching = true;
    hatchError = '';
    screens.setBusy(true);
    // A hub that cannot be reached (or a failing connector) means a local pond, never a stuck screen.
    void tryOnline(() =>
      identityReady.then(() => {
        ensureOnline(name);
        return keeper.current?.whenReady(HATCH_WAIT_MS) ?? null;
      }),
    )
      .then(async (welcome) => {
        const joined = welcome !== null && pond !== null;
        // A pinned body is a test or a debug cell: it never touches the ledger.
        if (!joined || params.genome) {
          flow.practice();
          begin(joined);
          return;
        }
        const outcome = await flow.hatch(HATCH_WAIT_MS);
        if (outcome.kind === 'failed') {
          hatchError = outcome.message;
        } else if (outcome.kind === 'practice') {
          // Out of recorded hatches: wait out the countdown or swim in a practice cell.
          if (outcome.reason === 'limit' && (outcome.genesisIn ?? 0) > 0) {
            limitUntil = performance.now() + (outcome.genesisIn ?? 0);
          } else {
            begin(true);
          }
        } else {
          const genome = parseGenomeText(outcome.start.genome);
          if (genome) begin(true, { body: hatchBody(genome), start: outcome.start });
          else hatchError = VERIFY_FAILED;
        }
      })
      .catch((error: unknown) => {
        console.warn('hatch failed', error);
        hatchError = 'Could not hatch. Try again.';
      })
      .finally(() => {
        hatching = false;
        screens.setBusy(false);
      });
  };
  const screens = new Screens({
    hatch,
    practice: () => {
      limitUntil = 0;
      flow.practice();
      begin(pond !== null);
    },
  });
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
        if (mate.view().state === 'invited') {
          if (key === 'e' || key === 'E') mate.accept();
          else if (key === 'Escape') mate.decline();
        } else if ((key === 'e' || key === 'E') && nearby) {
          mate.court(nearby.id);
        }
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
    countItem(counts, 'stolen', `${stolen.slot}_k${stolen.k}`);
    hud.update(player);
  };

  /** The pond, while a real life (not the title screen's cell) is running in it. */
  const livePond = (): Pond | null => (session.demo ? null : session.pond);

  /**
   * The life clock of a recorded creature: it turns elder at 85% of its lifespan, and the hub's
   * word that its time is up ends it. A creature past its time asks the hub for that verdict.
   */
  const ageCreature = (): void => {
    const { world, player } = session;
    if (flow.expired) {
      // The sim's own `expire` call, the one a replayed log carries.
      applyLife(world, player.id, 'expire');
      return;
    }
    const { creature } = session.body;
    lastClock = flow.clock(
      session.ticks,
      player.biomass,
      creature.stats.maxBiomass,
      lifespanMs(creature.traits.physiology.lifespan),
    );
    hud.setLife(lastClock);
    if (!lastClock) return;
    if (lastClock.stage === 'old' && !player.elder) {
      applyLife(world, player.id, 'elder');
      hud.toast('Feeling old');
    }
    const lastAsk = session.lastExpiryAsk;
    if (
      lastClock.remainingMs <= 0 &&
      (lastAsk < 0 || session.ticks - lastAsk >= EXPIRY_RETRY_TICKS)
    ) {
      session.lastExpiryAsk = session.ticks;
      flow.report(session.ticks, player);
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
    // The authority committed a mating: pay its cost here, at a tick boundary.
    if (!session.demo && mate.takeCost()) {
      applyLife(world, player.id, 'mate');
      fx.matePulse({ x: player.x, y: player.y, radius: Math.sqrt(player.biomass) });
      if (recovery.needsSaving && !reminded) {
        reminded = true;
        hud.toast('Save your recovery code');
      }
    }
    const live = livePond();
    if (live && scale === 1) loop.setSpeed(live.time.update(world, performance.now()));
    const at = world.tick;
    const events = step(world, { [player.id]: input });
    session.ticks++;
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
      for (const event of events) {
        counts[event.type] = (counts[event.type] ?? 0) + 1;
        if (event.type === 'eat') countItem(counts, 'eat', event.food);
      }
      session.peakBiomass = Math.max(session.peakBiomass, player.biomass);
      hud.update(player);
    }
    field.markDirty();
    settleSteering(events);
    if (!session.demo && player.cause === null && session.ticks >= session.nextReport) {
      session.nextReport += REPORT_EVERY_TICKS;
      if (!document.hidden) flow.report(session.ticks, player);
    }
    if (!session.demo && player.cause === null) ageCreature();
    if (!session.demo && player.cause !== null) {
      // A recorded creature lived by its life clock; a practice cell by sim time.
      const lived = lastClock
        ? lastClock.activeMs / 1000
        : (world.tick - player.bornTick) / TICK_HZ;
      flow.died(player.cause, session.ticks);
      lastClock = null;
      hud.setLife(null);
      session.death = {
        cause: player.cause,
        survivedSeconds: lived,
        peakBiomass: session.peakBiomass,
        body: bodyLabel(session.body),
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
        : statusText(
            keeper.current?.status ?? 'connecting',
            keeper.current?.count ?? 1,
            keeper.current?.queue ?? null,
          );
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

  /** Courting on screen: the key beside a creature in reach, the invitation, and the cooldown. */
  const updateMateUi = (): void => {
    const playingNow = screen === 'playing' && !session.demo;
    mate.tick();
    const { player } = session;
    nearby = null;
    if (playingNow && player.alive) {
      let best = Number.POSITIVE_INFINITY;
      for (const r of remoteViews) {
        if (r.alpha < 0.5) continue;
        const gap = Math.hypot(r.x - player.x, r.y - player.y);
        const reach = RULES.mating.reachBodies * 2 * Math.max(r.radius, Math.sqrt(player.biomass));
        if (gap > reach || gap >= best) continue;
        best = gap;
        nearby = { id: r.id, name: r.name, biomass: r.radius * r.radius };
      }
    }
    if (nearby) mate.check(nearby.id);
    const view = mate.view();
    const hint = nearby ? mate.hint(nearby) : null;
    const text = view.invite ? '' : (hint?.text ?? view.note);
    if (mateHint.textContent !== text) mateHint.textContent = text;
    mateHint.toggleAttribute('hidden', !playingNow || text === '');
    mateHint.dataset.court = String(hint?.court === true);
    const { invite } = view;
    invitePanel.toggleAttribute('hidden', !playingNow || !invite);
    if (invite) {
      const remote = remoteViews.find((r) => r.id === invite.from);
      const body = [
        remote?.species ?? 'A new creature',
        remote?.body ? rarityOfTraits(remote.body.traits).tier : '',
        remote ? `size ${sizeTier(remote.radius * remote.radius)}` : '',
        `generation ${invite.generation}`,
      ].filter(Boolean);
      inviteName.textContent = `${invite.name} wants to mate`;
      inviteBody.textContent = body.join(' · ');
      inviteBand.textContent = invite.band;
      inviteLeft.textContent = `${Math.ceil(view.inviteLeftMs / 1000)} s`;
    }
    const life = flow.view();
    const rest = life.cooldownUntilMs - (lastClock?.activeMs ?? life.activeMs);
    const ready =
      playingNow &&
      lastClock !== null &&
      life.matureAtMs > 0 &&
      lastClock.activeMs >= life.matureAtMs;
    hud.setReady(ready ? readyText(rest) : '');
  };

  let shownNote = '';
  let shownLimit = false;
  const updateHatchNote = (): void => {
    const status = flow.state;
    const waiting = hatching && (status === 'awaiting' || status === 'verifying');
    const left = limitLeft();
    if (limitUntil > 0 && left <= 0) limitUntil = 0;
    if (left > 0 !== shownLimit) {
      shownLimit = left > 0;
      screens.setLimited(shownLimit);
    }
    let text = hatchError;
    if (left > 0) text = countdownText(left);
    if (waiting) text = status === 'awaiting' ? 'Awaiting beacon…' : 'Checking your creature…';
    if (text !== shownNote) {
      shownNote = text;
      hatchNote.textContent = text;
      hatchNote.hidden = text === '';
    }
    if (hatchNote.hasAttribute('data-waiting') !== waiting) {
      hatchNote.toggleAttribute('data-waiting', waiting);
    }
  };

  let lastMs = performance.now();
  const view = {
    time: 0,
    camX: 0,
    camY: 0,
    halfHeight: 1,
    creature: null as CellView | null,
    body: null as CreatureSource | null,
    remotes: [] as readonly DrawnRemote[],
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
  const feedScripted = ({ spec, sender, startedMs, ref }: Scripted, now: number): void => {
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
        genomeRef: ref,
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
      sender.update(now, document.hidden, () =>
        snapshotOf(player, session.world.tick, session.body.ref),
      );
    }
    // A local pond life does not show the players of the hub's pond.
    remoteViews =
      !keeper.current || joined
        ? remoteBodies.resolve(remotes.sample(now, pondMs()), now)
        : NO_REMOTES;
    updateNetUi(now, joined);
    updateHatchNote();
    updateMateUi();
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
    nearestFood(kind) {
      const { player } = session;
      let best: FoodItem | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const item of food) {
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
      for (const { spec } of scripted) {
        dropPeer(spec.id);
      }
      scripted = specs.map((spec) => {
        remotes.setMember(spec.id, spec.name);
        if (spec.genome !== undefined && !spec.withholdGenome)
          remoteBodies.add(spec.id, spec.genome);
        const sender = new SnapshotSender((bytes) => {
          const snapshot = decodeSnapshot(bytes);
          if (snapshot) remotes.receive(spec.id, snapshot, performance.now());
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
      if (!event) return;
      receiveFoodEvent(from, event);
      if (event.t === 'genome') remoteBodies.add(from, event.data);
    },
    hasFood: (id) => food.some((f) => f.id === id),
    timeScale(next) {
      clock();
      scale = next;
    },
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
            speed: Math.hypot(session.player.vx, session.player.vy),
            elder: session.player.elder,
            genomeHash: session.body.hash,
            species: session.body.species,
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
        limitMs: limitLeft(),
      },
      mate: {
        state: mate.view().state,
        text: mateHint.textContent ?? '',
        invite: mate.view().invite && {
          name: mate.view().invite?.name ?? '',
          from: mate.view().invite?.from ?? '',
          leftMs: mate.view().inviteLeftMs,
        },
        visited: [...mate.visited],
        ready: pick('[data-testid="hud-ready"]').textContent ?? '',
      },
      remotes: remoteViews.map(({ id, name, x, y, alpha, radius, genomeHash, species }) => ({
        id,
        name,
        x,
        y,
        alpha,
        radius,
        genomeHash,
        species,
      })),
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
        dropped: genomeSync.dropped + remoteBodies.dropped,
      },
    }),
    events: () => ({ ...session.counts }),
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
          round: g.beacon.round,
          commit,
          genomeHash: genomeHash(genesisFor(randomnessOf(g.beacon), commit)),
        };
      },
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
    ...(params.debug ? { debug, genome } : {}),
  });
}
