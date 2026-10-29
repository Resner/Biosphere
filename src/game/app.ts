import { genomeFromBase64url, genomeHash, parseGenomeText } from '../genome/codec';
import { hashPlan } from '../genome/develop';
import { rarityOfTraits } from '../genome/rarity';
import { buildCreature, hashStats } from '../genome/stats';
import { indexedDbKeyStore } from '../ledger/idb-keystore';
import type { Identity } from '../ledger/identity';
import { createIdentity, importRecoveryCode, memoryKeyStore } from '../ledger/identity';
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
import { EGG } from '../render/egg';
import { type PresetName, resolvePreset } from '../render/presets';
import type { RemoteCellView } from '../render/remotes';
import { GameScene } from '../render/scene';
import { nearestInZone, sightRadius } from '../render/zones';
import { depthAt, zoneOfDepth } from '../sim/bathymetry';
import { colliderReach } from '../sim/body';
import { currentAt } from '../sim/currents';
import { foodNear } from '../sim/food';
import { plumesNear } from '../sim/hazards';
import { angleToSteer, IDLE, type Input } from '../sim/input';
import { applyLife, lifespanMs } from '../sim/life';
import { atan2, lerp, wrapAngle } from '../sim/math';
import { type MateView, ownRefusal } from '../sim/mating';
import { replay } from '../sim/replay';
import { RULES, TICK_HZ } from '../sim/rules';
import { sizeTier } from '../sim/size';
import { findClearSpot } from '../sim/spawn';
import { step } from '../sim/step';
import type { CreatureState, FoodItem, StepEvent, World } from '../sim/types';
import { maxEnergy, maxHealth, starterEnergy } from '../sim/vitals';
import { createWorld, spawnCreature } from '../sim/world';
import { AloneHint } from './alone-hint';
import { AutoQuality } from './auto-quality';
import { setBadge } from './badge';
import { type Body, bodyLabel, Hatcher, hatchBody } from './body';
import {
  type BsDebug,
  type BsGenome,
  type BsState,
  installHook,
  type ScriptedRemote,
} from './debug';
import { listItem, pick } from './dom';
import { EggShow } from './eggs';
import { createFieldSync } from './field';
import { GrowthWatch, growthText, sizeShare } from './growth';
import { HistoryPanel } from './history';
import { Hud } from './hud';
import { EdgeIndicatorsUi, edgeIndicators, type Indicator } from './indicators';
import { enterHatches, InputController } from './input';
import { RemoteLabels } from './labels';
import { type LifeClock, LifeFlow, type Started, VERIFY_FAILED } from './life';
import { resetLife } from './life-reset';
import { countdownText } from './life-text';
import { LineagePanel } from './lineage-panel';
import { attachVisibilityPause, createLoop } from './loop';
import { MateFlow, type Nearby, randomNonce } from './mate';
import { inspectCard } from './mate-card';
import { readyText } from './mate-text';
import { OffspringFlow } from './offspring';
import { drawPreview } from './offspring-preview';
import { childLine, type FallbackId, fallbackOptions } from './offspring-text';
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
import { PondMap } from './pond-map';
import { PondTime } from './pond-time';
import { RecoveryPanel } from './recovery-panel';
import { type DrawnRemote, RemoteBodies } from './remote-bodies';
import { type DeathSummary, type Screen, Screens } from './screens';
import { loadSettings, type Settings, saveSettings } from './settings';
import { SettingsPanel } from './settings-panel';
import { MuteList, Social } from './social';
import { type Anchor, SocialUi } from './social-ui';
import { zoneReadout } from './zone-readout';

export interface GameParams {
  seed: string;
  debug: boolean;
  /** `?genome=`: pins the body to hatch with (a base64url genome or "starter"). */
  genome?: string | null;
  /** `?quality=`: a preset for this visit that beats the stored setting and is never written. */
  quality?: PresetName | null;
  /** `?dof=0`: a test switch that draws every preset without its depth of field. */
  dof?: boolean;
  /** `?light=0`: a test switch that draws no caustics and no god rays (M6 T17). */
  light?: boolean;
}

/** Food drifts up to this far from its slot anchor; the field query reaches that much further. */
const FIELD_MARGIN = RULES.food.driftRadius + RULES.food.kinds.globule.radius;
const MAX_FRAME_SECONDS = 0.1;
/** `debug.steerTo` gives up after this many ticks (30 s). */
/** The most sim ticks of water flow one frame integrates: a stalled tab must not fling the snow. */
const MAX_FLOW_TICKS = TICK_HZ;
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

/** The offspring card slides in this long after its egg's crack time, just as the egg bursts (M6 T20). */
const CARD_AFTER_CRACK_MS = 250;

/** `prefers-reduced-motion` (T22 adds a setting that defaults to it): the egg fades instead of shaking. */
const motionQuery = (): MediaQueryList | null => {
  try {
    return typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  } catch {
    return null;
  }
};

/** A click this close (in CSS pixels) to a creature's centre picks it, however small it is drawn. */
const INSPECT_MIN_PX = 24;

/** Starts the title screen; the player hatches into the same scene. */
export function startApp(canvas: HTMLCanvasElement, params: GameParams): void {
  const scene = new GameScene(canvas, RULES.world.size, {
    dof: params.dof ?? true,
    light: params.light ?? true,
  });
  const camera = new FollowCamera();
  const controller = new InputController();
  const hud = new Hud();
  const history = new HistoryPanel();
  /** The hub link of the current online session, for the Lineage panel's question. */
  let hubLink: { send(msg: { t: 'lineage' }): void } | null = null;
  const lineagePanel = new LineagePanel(() => hubLink?.send({ t: 'lineage' }));
  const storage = safeStorage();
  // The stored setting, or this visit's `?quality=` until the player picks one in the panel.
  let settings: Settings = params.quality ? { quality: params.quality } : loadSettings(storage);
  // Auto-detect and adaptive resolution (M6 T4). Test automation and `?quality=` never measure, so
  // every other E2E and the gallery draw at medium and full resolution unless a test forces it.
  const autoQuality = new AutoQuality({
    store: storage,
    gpu: scene.gpu(),
    measure: !navigator.webdriver && !params.quality,
    onDetect: () => applySettings(),
    onScale: (scale) => scene.setRenderScale(scale),
  });
  const applySettings = (): void => {
    const preset = resolvePreset(settings.quality, autoQuality.detected);
    scene.setPreset(preset);
    settingsPanel.show(settings, preset, autoQuality.detected);
  };
  const settingsPanel = new SettingsPanel(
    (next) => {
      settings = next;
      saveSettings(settings, storage);
      applySettings();
    },
    ['settings-open', 'lineage-settings'],
  );
  applySettings();
  const fx = new Effects();
  // The egg (M6 T20): the beacon reveal, the carried egg, peers' eggs and the hatch.
  const eggs = new EggShow((x, y, radius, rings) => fx.burst({ x, y, radius }, rings));
  const reducedMotion = motionQuery();
  /** The life whose creature grows out of an egg; its drawn size follows the egg's pop. */
  let emerging: Session | null = null;
  /** The eggs' clock: wall time, held still while the world is frozen (`timeScale(0)`), as the shaders' is. */
  const eggClock = (): number => performance.now() - heldMs;
  const vignette = pick('[data-testid="vignette"]');
  const labels = new RemoteLabels(pick('[data-testid="remote-labels"]'));
  // Finding other players (M6 T19): arrows on the screen's edge and the pond map.
  const indicatorsUi = new EdgeIndicatorsUi(pick('[data-testid="edge-indicators"]'));
  let indicators: Indicator[] = [];
  const pondMap = new PondMap();

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
    nonce: randomNonce,
    // BLS12-381 is heavy: its code loads when the first genesis arrives.
    verify: async (g) => {
      const { checkGenesis } = await import('../ledger/genesis');
      return checkGenesis(g.record.record, g.commit.commitment, g.beacon, g.genome);
    },
  });
  // The pending child (M5): verified here, drawn as an egg and a card, become-able with H.
  const offspring = new OffspringFlow({
    now: () => performance.now(),
    verify: async (born) => {
      const { birthProblems } = await import('./offspring-check');
      return birthProblems(born, playerId ?? '');
    },
    eggMs: (child) => EGG.crackMs[child.body.rarity] + CARD_AFTER_CRACK_MS,
  });
  /** Generation of each of the player's creatures, from the hub's lineage answers (for the return choice). */
  const generations = new Map<string, number>();
  let generationsSeen = 0;
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
  const ownMateView = (): MateView | null => {
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
  };
  const mate = new MateFlow({
    identity: () => identity as Identity,
    nonce: randomNonce,
    now: () => performance.now(),
    nameOf: (id) => keeper.current?.nameOf(id),
    own: ownMateView,
  });
  const mateHint = pick('[data-testid="mate-hint"]');
  const invitePanel = pick('[data-testid="invite"]');
  const inviteName = pick('[data-testid="invite-name"]');
  const inviteBody = pick('[data-testid="invite-body"]');
  const inviteBand = pick('[data-testid="invite-band"]');
  const inviteLeft = pick('[data-testid="invite-left"]');
  const inviteBadge = pick('[data-testid="invite-badge"]');
  // The inspect card (M5 T12): click another creature to read it before courting.
  const inspectPanel = pick('[data-testid="inspect"]');
  const inspectName = pick('[data-testid="inspect-name"]');
  const inspectBadge = pick('[data-testid="inspect-badge"]');
  const inspectSpecies = pick('[data-testid="inspect-species"]');
  const inspectMeta = pick('[data-testid="inspect-meta"]');
  const inspectTraits = pick('[data-testid="inspect-traits"]');
  const inspectKinship = pick('[data-testid="inspect-kinship"]');
  const inspectVerdict = pick('[data-testid="inspect-verdict"]');
  const inspectHints = pick('[data-testid="inspect-hints"]');
  let inspected: string | null = null;
  /** What the card on screen was built from; it is rebuilt only when one of these changes. */
  let inspectFrom: readonly unknown[] = [];
  pick('[data-testid="inspect-close"]').addEventListener('click', () => {
    inspected = null;
  });
  canvas.addEventListener('click', (e) => {
    if (!playing() || !session.player.alive || controller.typing) return;
    const rect = canvas.getBoundingClientRect();
    const at = worldAt(e.clientX - rect.left, e.clientY - rect.top);
    let best = Number.POSITIVE_INFINITY;
    inspected = null;
    for (const r of remoteViews) {
      if (r.alpha < 0.5) continue;
      const gap = Math.hypot(r.x - at.x, r.y - at.y);
      if (gap > Math.max(r.radius, INSPECT_MIN_PX / scene.pxPerWu) || gap >= best) continue;
      best = gap;
      inspected = r.id;
    }
  });
  /** The creature in reach that E would court, as of the last frame. */
  let nearby: Nearby | null = null;
  let reminded = false;
  let readyShown = '';
  /** Mature, rested and with no pending child: the snapshot's ready mark (a hint for peers). */
  let mateReady = false;
  const marks = { ready: false, egg: false };
  const setIfChanged = (el: HTMLElement, text: string): void => {
    if (el.textContent !== text) el.textContent = text;
  };

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

  const adultRadius = (c: CreatureState): number => Math.sqrt(c.phys.maxBiomass);

  const refreshField = (): void => {
    const { world, player } = session;
    const radius = Math.sqrt(player.biomass);
    const half = Math.max(camera.halfHeight, viewHalfHeight(radius, adultRadius(player)));
    const reach = Math.hypot(half * scene.aspect, half) + FIELD_MARGIN;
    food = foodNear(world, player.x, player.y, reach);
    scene.setField(food, plumesNear(world, player.x, player.y, reach));
  };

  const field = createFieldSync(refreshField);

  // A slew factor belongs to the pond clock it chases, and an open chat would swallow Enter.
  const endLifeState = (): void =>
    resetLife({ setSpeed: (speed) => loop.setSpeed(speed), closeChat: () => socialUi.close() });

  const growth = new GrowthWatch();

  /** The size line and bar, and a ring each time the creature has grown another tenth. */
  const updateGrowth = (matureAtMs: number): void => {
    const { player } = session;
    const { maxBiomass } = player.phys;
    hud.setGrowth(
      growthText({
        biomass: player.biomass,
        maxBiomass,
        activeMs: lastClock?.activeMs ?? 0,
        matureAtMs,
        stage: lastClock?.stage ?? 'young',
      }),
      sizeShare(player.biomass, maxBiomass),
    );
    const cue = growth.update(player.biomass, maxBiomass);
    if (cue) {
      fx.growPulse({ x: player.x, y: player.y, radius: Math.sqrt(player.biomass) }, cue === 'tier');
    }
  };

  const enter = (next: Session, nextScreen: Screen): void => {
    session = next;
    endLifeState();
    fx.reset();
    growth.reset();
    controller.reset();
    steering?.done(false);
    steering = null;
    const { player } = session;
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
    scene.setZones(session.world.seed32, session.world.size);
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
          offspring.receive(msg);
          if (msg.t === 'lineage') {
            lineagePanel.receive(msg.creatures, msg.pedigree);
            for (const c of msg.creatures) generations.set(c.creature, c.generation);
            generationsSeen++;
          }
          // The return choice names the ancestor's generation, which only the lineage knows.
          const ancestor = msg.t === 'life' || msg.t === 'died' ? msg.fallback?.ancestor : null;
          if (ancestor && !generations.has(ancestor.creature)) {
            link.send({ t: 'lineage' });
          }
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
    hubLink = link;
    // A panel opened before the link was up asks again once it is.
    if (lineagePanel.isOpen) link.send({ t: 'lineage' });
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
  const begin = (inPond: boolean, recorded?: { body: Body; start: Started }, at?: Vec2): void => {
    const target = inPond ? pond : null;
    const seed = hatches === 0 ? params.seed : `${params.seed}/${hatches}`;
    hatches++;
    let spawn: Vec2 | null = null;
    if (at) spawn = at;
    else if (target?.ring) spawn = ringSpawn(target.ring.centre, target.ring.hint, target.lives);
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
    // After a genesis or a hatch, the creature grows out of its egg.
    emerging = eggs.hatched(eggClock(), next.body.rarity) ? next : null;
  };

  let hatching = false;
  let titleEggShown = false;
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
  // Becoming the pending child, or returning to the nearest ancestor (M5 T11).
  let switching = false;
  const become = (choice: FallbackId): void => {
    if (switching || hatching) return;
    const child = offspring.child();
    const ancestor = flow.view().fallback?.ancestor ?? null;
    const task =
      choice === 'child' && child
        ? () => flow.promote(child.born)
        : ancestor && choice === 'ancestor'
          ? () => flow.restore(ancestor)
          : null;
    if (!task) return;
    if (!hubUrl || pond === null || !playerId) {
      hud.toast('Not connected to the pond');
      return;
    }
    switching = true;
    hatchError = '';
    screens.setBusy(true);
    // A living parent hands over to the child, which hatches out of the egg it carries.
    const alive = screen === 'playing' && session.player.alive;
    const hatchingChild = choice === 'child' && child !== null;
    const at = alive
      ? ((hatchingChild ? eggs.ownAt() : null) ?? { x: session.player.x, y: session.player.y })
      : undefined;
    if (hatchingChild) eggs.hatchStart(eggClock(), child.body.rarity, alive && eggs.ownShown);
    let begun = false;
    void task()
      .then((outcome) => {
        if (outcome.kind === 'failed') {
          hatchError = outcome.message;
          hud.toast(outcome.message);
          return;
        }
        if (outcome.kind !== 'recorded') return;
        const genome = parseGenomeText(outcome.start.genome);
        if (!genome) {
          hatchError = VERIFY_FAILED;
          return;
        }
        // The parent stays behind as it was and dissolves there.
        if (hatchingChild && alive) {
          eggs.leave(
            {
              x: cell.x,
              y: cell.y,
              heading: cell.heading,
              radius: cell.radius,
              body: session.body.creature,
              hue: 0,
            },
            eggClock(),
          );
        }
        begun = true;
        begin(true, { body: hatchBody(genome), start: outcome.start }, at);
        hud.toast(
          choice === 'child'
            ? `You are now ${session.body.species}`
            : `Back as ${session.body.species}`,
        );
      })
      .catch((error: unknown) => {
        console.warn('switch failed', error);
        hatchError = 'Could not switch creatures. Try again.';
      })
      .finally(() => {
        switching = false;
        screens.setBusy(false);
        // A hatch the hub did not make puts the carried egg back.
        if (hatchingChild && !begun && eggs.mode === 'hatch') eggs.cancel();
      });
  };
  const screens = new Screens({
    hatch,
    choose: become,
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
      if (lineagePanel.isOpen || settingsPanel.isOpen) return;
      if (playing()) socialUi.open();
      else if (enterHatches(screen, performance.now() - screenShownAt)) {
        const first = screens.firstOption;
        if (first) become(first);
        else hatch();
      }
    },
    {
      key: (key) => {
        if (settingsPanel.isOpen) {
          if (key === 'Escape') settingsPanel.close();
          return;
        }
        if (lineagePanel.isOpen) {
          if (key === 'Escape') lineagePanel.close();
          return;
        }
        if (!playing()) return;
        if ((key === 'h' || key === 'H') && offspring.child()) {
          become('child');
          return;
        }
        if (key === 'm' || key === 'M') pondMap.toggle();
        if (key === 'Escape' && pondMap.isOpen) {
          pondMap.close();
        } else if (mate.view().state === 'invited') {
          if (key === 'e' || key === 'E') mate.accept();
          else if (key === 'Escape') mate.decline();
        } else if (key === 'Escape' && inspected) {
          inspected = null;
        } else if (key === 'Escape') {
          lineagePanel.open();
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
      hud.drain(before, shares());
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

  // The offspring card and the choice after a death (M5 T11); the egg is drawn in the scene (M6 T20).
  const cardElement = pick('[data-testid="offspring"]');
  const cardPreview = pick<HTMLCanvasElement>('[data-testid="offspring-preview"]');
  const cardName = pick('[data-testid="offspring-name"]');
  const cardLine = pick('[data-testid="offspring-line"]');
  pick('[data-testid="offspring-become"]').addEventListener('click', () => become('child'));
  pick('[data-testid="offspring-later"]').addEventListener('click', () => offspring.postpone());
  let previewOf: string | null = null;
  let offspringKind = 'none';
  let optionsKey: unknown[] = [];
  const updateOffspringUi = (): void => {
    offspring.tick();
    const playingNow = screen === 'playing' && !session.demo && session.death === null;
    const state = offspring.view();
    hud.setEgg(playingNow && session.player.alive && offspring.child() !== null);
    const card = playingNow && state.kind === 'card' && !state.later;
    if (cardElement.hidden === card) cardElement.hidden = !card;
    if (state.kind === 'card' || state.kind === 'egg') {
      setIfChanged(cardName, state.child.body.species);
      setIfChanged(cardLine, childLine(state.child));
      if (previewOf !== state.child.body.hash) {
        previewOf = state.child.body.hash;
        drawPreview(cardPreview, state.child.body);
      }
    }
    if (state.kind === 'failed' && offspringKind !== 'failed') hud.toast(state.message);
    offspringKind = state.kind;
    // The choice for a dead or not-yet-hatched player, rebuilt only when what it names changes.
    const fallback = flow.view().fallback;
    const child = offspring.child();
    const key = [fallback, child, generationsSeen];
    if (key.some((v, i) => v !== optionsKey[i])) {
      optionsKey = key;
      screens.setFallback(fallbackOptions(fallback, child, (id) => generations.get(id)));
    }
  };

  /** The inspect card beside a clicked creature: closed when it leaves, dies or the game stops. */
  const updateInspectUi = (playingNow: boolean, invited: boolean): void => {
    if (!playingNow || invited) inspected = null;
    const remote = inspected ? remoteViews.find((r) => r.id === inspected) : undefined;
    if (inspected && !remote) inspected = null;
    if (!remote || remote.alpha < 0.5) {
      if (!inspectPanel.hidden) inspectPanel.hidden = true;
      return;
    }
    mate.check(remote.id);
    const info = mate.info(remote.id);
    const from = [
      remote.id,
      remote.body,
      remote.genomeText,
      session.body.text,
      info,
      sizeTier(remote.radius * remote.radius),
    ];
    if (from.some((v, i) => v !== inspectFrom[i])) {
      inspectFrom = from;
      const card = inspectCard({
        name: remote.name,
        radius: remote.radius,
        species: remote.species,
        body: remote.body,
        genomeText: remote.genomeText,
        ownGenomeText: session.body.text,
        info,
      });
      setIfChanged(inspectName, card.name);
      setBadge(inspectBadge, card.rarity);
      setIfChanged(inspectSpecies, card.species);
      setIfChanged(inspectMeta, card.meta);
      inspectTraits.replaceChildren(...card.traits.map(listItem));
      setIfChanged(inspectKinship, card.kinship);
      setIfChanged(inspectVerdict, card.verdict);
      inspectVerdict.dataset.can = String(card.canMate);
      inspectHints.replaceChildren(...(card.hints?.lines ?? []).map(listItem));
    }
    // Beside the creature, never over it: on the side of the screen it is not on.
    const side = remote.x < camera.x ? 'right' : 'left';
    if (inspectPanel.dataset.side !== side) inspectPanel.dataset.side = side;
    if (inspectPanel.hidden) inspectPanel.hidden = false;
  };

  /** The mating flow's state as of the last frame (the egg waits while it is `awaiting`). */
  let mateNow = 'idle';
  /** Courting on screen: the key beside a creature in reach, the invitation, and the cooldown. */
  const updateMateUi = (): void => {
    const playingNow = screen === 'playing' && !session.demo;
    mate.tick();
    const { player } = session;
    nearby = null;
    if (playingNow && player.alive && remoteViews.length > 0) {
      const own = Math.sqrt(player.biomass);
      let best = Number.POSITIVE_INFINITY;
      let near: DrawnRemote | null = null;
      for (const r of remoteViews) {
        if (r.alpha < 0.5) continue;
        const gap = Math.hypot(r.x - player.x, r.y - player.y);
        const reach = RULES.mating.reachBodies * 2 * Math.max(r.radius, own);
        if (gap > reach || gap >= best) continue;
        best = gap;
        near = r;
      }
      if (near) nearby = { id: near.id, name: near.name, biomass: near.radius * near.radius };
    }
    if (nearby) mate.check(nearby.id);
    const view = mate.view();
    mateNow = view.state;
    const hint = nearby ? mate.hint(nearby) : null;
    const text = view.invite ? '' : (hint?.text ?? view.note);
    if (mateHint.textContent !== text) mateHint.textContent = text;
    const hideHint = !playingNow || text === '';
    if (mateHint.hidden !== hideHint) mateHint.hidden = hideHint;
    const court = String(hint?.court === true);
    if (mateHint.dataset.court !== court) mateHint.dataset.court = court;
    updateInspectUi(playingNow, view.invite !== null);
    const { invite } = view;
    const hideInvite = !playingNow || !invite;
    if (invitePanel.hidden !== hideInvite) invitePanel.hidden = hideInvite;
    if (invite) {
      const remote = remoteViews.find((r) => r.id === invite.from);
      setBadge(inviteBadge, remote?.body ? rarityOfTraits(remote.body.traits).tier : '');
      const body = [
        remote?.species ?? 'A new creature',
        remote ? `size ${sizeTier(remote.radius * remote.radius)}` : '',
        `generation ${invite.generation}`,
      ].filter(Boolean);
      setIfChanged(inviteName, `${invite.name} wants to mate`);
      setIfChanged(inviteBody, body.join(' · '));
      setIfChanged(inviteBand, invite.band);
      setIfChanged(inviteLeft, `${Math.ceil(view.inviteLeftMs / 1000)} s`);
    }
    const life = flow.view();
    const active = lastClock?.activeMs ?? life.activeMs;
    const ready =
      playingNow && lastClock !== null && life.matureAtMs > 0 && active >= life.matureAtMs;
    readyShown = ready ? readyText(life.cooldownUntilMs - active) : '';
    const own = ready ? ownMateView() : null;
    mateReady = own !== null && ownRefusal(own) === null;
    hud.setReady(readyShown);
    if (playingNow && player.alive) updateGrowth(life.matureAtMs);
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
  /** Wall-clock time spent with the world frozen (`timeScale(0)`), which the animation clock skips. */
  let heldMs = 0;
  const view = {
    time: 0,
    camX: 0,
    camY: 0,
    halfHeight: 1,
    creature: null as CellView | null,
    body: null as CreatureSource | null,
    remotes: [] as readonly RemoteCellView[],
    rings: fx.rings,
    eggs: [] as ReturnType<EggShow['frame']>,
    sight: 1,
    flow: { x: 0, y: 0 },
  };
  const cell: CellView = {
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
  const withGhost: RemoteCellView[] = [];
  /** The pending child as the eggs need it; reused. */
  const eggChild = { tier: 'common' as Body['rarity'], maxBiomass: 1 };

  /**
   * The egg (M6 T20): a genesis waits on the title screen, a mating beside the parent; the child's
   * check cracks it; a pending child is carried. Returns the eggs to draw.
   */
  const updateEggs = (now: number, dt: number, reduced: boolean): ReturnType<EggShow['frame']> => {
    const status = flow.state;
    if (hatching && status === 'awaiting') eggs.awaitGenesis(now);
    else if (hatching && status === 'verifying') eggs.genesisBeacon(now);
    else if (!hatching && eggs.mode === 'genesis' && session.demo) eggs.cancel();
    const playingNow = playing();
    const kid = offspring.view();
    if (playingNow && mateNow === 'awaiting') eggs.awaitMate(now);
    else if (kid.kind === 'egg')
      eggs.childRevealed(now, kid.child.born.record.hash, kid.child.body.rarity);
    else if (eggs.mode === 'mate' && eggs.reveal.phase === 'waiting' && kid.kind !== 'verifying') {
      // The mating ended without a child to show (a failed check, a lost connection).
      eggs.cancel();
    }
    // While a genesis egg waits on the title screen, the menu steps back so the egg is the moment.
    const titleEgg = eggs.mode === 'genesis' && screen === 'title';
    if (titleEggShown !== titleEgg) {
      titleEggShown = titleEgg;
      document.body.toggleAttribute('data-egg', titleEgg);
    }
    const alive = playingNow && session.player.alive;
    const child = offspring.child();
    if (child) {
      eggChild.tier = child.body.rarity;
      eggChild.maxBiomass = child.body.creature.stats.maxBiomass;
    }
    return eggs.frame({
      now,
      dt,
      reduced,
      self: alive || eggs.mode === 'genesis' ? cell : null,
      child: alive && child ? eggChild : null,
      remotes: playingNow ? remoteViews : NO_REMOTES,
    });
  };
  let flowTick = 0;
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
        ready: spec.ready === true,
        egg: spec.egg === true,
        genomeRef: ref,
      };
    });
  };

  const render = (alpha: number): void => {
    const { player } = session;
    const now = performance.now();
    const elapsed = (now - lastMs) / 1000;
    const dt = Math.min(elapsed, MAX_FRAME_SECONDS);
    if (scale === 0) heldMs += now - lastMs;
    lastMs = now;

    cell.x = lerp(prev.x, player.x, alpha);
    cell.y = lerp(prev.y, player.y, alpha);
    cell.heading = prev.heading + wrapAngle(player.heading - prev.heading) * alpha;
    cell.radius = Math.sqrt(player.biomass);
    beat = lerp(beat, input.throttle / MAX_THROTTLE, Math.min(1, dt * 6));
    cell.beat = beat;

    camera.update(dt, {
      x: cell.x,
      y: cell.y,
      radius: cell.radius,
      adult: adultRadius(player),
    });
    // Shaders animate on wall-clock time; a frozen world holds still, so `render.specks` matches a shot.
    view.time = (now - heldMs) / 1000;
    view.camX = camera.x;
    view.camY = camera.y;
    view.halfHeight = camera.halfHeight;
    // The water's flow carries the marine snow (M6 T17). It follows sim ticks, so a frozen world
    // holds it still and a new life (the tick starts over) leaves it as it is.
    const flowTicks = session.world.tick - flowTick;
    flowTick = session.world.tick;
    if (flowTicks > 0 && flowTicks <= MAX_FLOW_TICKS) {
      const water = currentAt(session.world, camera.x, camera.y);
      view.flow.x += (water.x * flowTicks) / TICK_HZ;
      view.flow.y += (water.y * flowTicks) / TICK_HZ;
    }
    // Cues run on wall-clock time: a slow frame must not stretch the dissolve. An exotic egg's
    // burst runs them in slow motion for a moment (M6 T20).
    const reduced = reducedMotion?.matches === true;
    const eggNow = now - heldMs;
    fx.update(elapsed * eggs.reveal.slowFactor(eggNow, reduced));
    // The drawn size: the shrink of a mating's cost, and a hatchling's pop out of its egg.
    const emerge = session === emerging ? eggs.reveal.emerge(eggNow) : 1;
    cell.scale = (fx.drawnRadius(cell.radius) / cell.radius) * emerge;
    cell.hurt = fx.vignette;
    cell.dissolve = fx.dissolve;
    view.creature = fx.dissolved ? null : cell;
    view.sight = sightRadius(session.body.creature.stats.sense, cell.radius);
    if (!session.demo) {
      const { world } = session;
      const depth = depthAt(world.seed32, player.x, player.y);
      hud.setZone(zoneReadout(depth, player.phys, world.options.hazards && player.alive));
    }
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
      sender.update(now, document.hidden, () => {
        marks.ready = mateReady;
        // Peers see the egg from the commitment on, as the owner does (M6 T20).
        marks.egg = offspring.child() !== null || mateNow === 'awaiting';
        return snapshotOf(player, session.world.tick, session.body.ref, marks);
      });
    }
    // A local pond life does not show the players of the hub's pond.
    remoteViews =
      !keeper.current || joined
        ? remoteBodies.resolve(remotes.sample(now, pondMs()), now)
        : NO_REMOTES;
    updateNetUi(now, joined);
    updateHatchNote();
    updateMateUi();
    updateOffspringUi();
    view.eggs = updateEggs(eggNow, dt, reduced);
    const ghost = eggs.ghostOf(eggNow);
    if (ghost) {
      withGhost.length = 0;
      for (const r of remoteViews) withGhost.push(r);
      withGhost.push(ghost);
      view.remotes = withGhost;
    } else {
      view.remotes = remoteViews;
    }
    const projection = {
      camX: camera.x,
      camY: camera.y,
      pxPerWu: scene.pxPerWu,
      width: scene.width,
      height: scene.height,
    };
    labels.update(remoteViews, projection);
    const finding = playing() && session.player.alive;
    indicators = finding ? edgeIndicators(cell, remoteViews, social.pings(), projection) : [];
    indicatorsUi.update(indicators, projection);
    if (!finding) pondMap.close();
    else if (pondMap.isOpen) {
      pondMap.update({
        seed: session.world.seed32,
        size: session.world.size,
        self: { id: selfKey(), name: social.selfName, x: cell.x, y: cell.y, ready: mateReady },
        players: remoteViews,
        pings: social.pings(),
      });
    }
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
  let lastFrameMs = performance.now();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // The pond moved on while the tab was hidden: skip ahead instead of simulating it.
    livePond()?.time.resnap(session.world, performance.now());
    // Cues run on wall-clock time: hidden time must not skip the death dissolve.
    lastMs = performance.now();
    fx.resume();
    lastFrameMs = performance.now();
    autoQuality.resume(lastFrameMs);
  });

  let frames = 0;
  scene.start(() => {
    loop.frame();
    frames += 1;
    canvas.dataset.frames = String(frames);
    const now = performance.now();
    const auto = settings.quality === 'auto';
    autoQuality.frame(now - lastFrameMs, now, screen === 'title', auto, scene.quality);
    lastFrameMs = now;
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
    setZone(zone) {
      const { world, player } = session;
      const at = nearestInZone(world.seed32, world.size, player.x, player.y, zone);
      debug.teleport(at.x, at.y);
      camera.snap({
        x: at.x,
        y: at.y,
        radius: Math.sqrt(player.biomass),
        adult: adultRadius(player),
      });
      field.now();
      return at;
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
    setBench(ms) {
      autoQuality.setBench(ms, performance.now());
    },
    timeScale(next) {
      clock();
      scale = next;
    },
    resetWater() {
      view.flow.x = 0;
      view.flow.y = 0;
      heldMs = lastMs;
    },
  };

  /** The zone and depth under the player (M6 T16); null on the title screen. */
  const zoneState = (): Pick<BsState, 'zone' | 'depth'> => {
    if (session.demo) return { zone: null, depth: null };
    const { world, player } = session;
    const depth = depthAt(world.seed32, player.x, player.y);
    return { zone: zoneOfDepth(depth), depth };
  };

  const mateState = (): BsState['mate'] => {
    const m = mate.view();
    return {
      state: m.state,
      text: mateHint.textContent ?? '',
      invite: m.invite && { name: m.invite.name, from: m.invite.from, leftMs: m.inviteLeftMs },
      visited: [...mate.visited],
      ready: readyShown,
    };
  };

  const offspringState = (): BsState['offspring'] => {
    const view = offspring.view();
    const child = offspring.child();
    return {
      kind: view.kind,
      creature: child?.born.record.hash ?? null,
      species: child?.body.species ?? null,
      rarity: child?.body.rarity ?? null,
      generation: child?.generation ?? null,
      genomeHash: child?.body.hash ?? null,
      cardShown: !cardElement.hidden,
      eggShown: eggs.ownShown,
      options: screens.optionIds,
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

  installHook({
    ready: true,
    state: () => ({
      screen,
      quality: {
        setting: settings.quality,
        detected: autoQuality.detected,
        bench: autoQuality.status,
      },
      tick: session.world.tick,
      ...zoneState(),
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
      mate: mateState(),
      offspring: offspringState(),
      remotes: remoteViews.map(({ id, name, x, y, alpha, radius, genomeHash, species, egg }) => ({
        id,
        name,
        x,
        y,
        alpha,
        radius,
        genomeHash,
        species,
        egg,
      })),
      egg: {
        phase: eggs.reveal.phase,
        phases: [...eggs.reveal.visited],
        carried: offspring.child() !== null,
        shown: eggs.ownShown,
        peers: [...eggs.peerIds],
        ghost: eggs.ghostOf(eggClock()) !== null,
        motion: reducedMotion?.matches === true ? 'fade' : 'shake',
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
      indicators: indicators.map((i) => ({ ...i })),
      map: pondMap.info(),
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
          genomeHash: genomeHash(genesisFor(randomnessOf(g.beacon), commit, g.record.record.rules)),
        };
      },
    },
    render: {
      info: () => scene.info(),
      specks: (layer) => scene.specks(layer),
      outlines: () => scene.outlinesDrawn(),
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
