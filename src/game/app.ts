import { GameSound } from '../audio/engine';
import { indexedDbKeyStore } from '../ledger/idb-keystore';
import type { Identity } from '../ledger/identity';
import { createIdentity, importRecoveryCode, memoryKeyStore } from '../ledger/identity';
import { GenomeSync } from '../net/genome-sync';
import { isFinalStatus } from '../net/hub-client';
import { RemoteSet, SnapshotSender } from '../net/pond-sync';
import type { Vec2 } from '../net/protocol';
import { FollowCamera, viewHalfHeight } from '../render/camera';
import { Effects } from '../render/effects';
import { EGG } from '../render/egg';
import { type PresetName, resolvePreset } from '../render/presets';
import { GameScene } from '../render/scene';
import { Shake } from '../render/shake';
import { foodNear } from '../sim/food';
import { plumesNear } from '../sim/hazards';
import { IDLE, type Input } from '../sim/input';
import type { MateView } from '../sim/mating';
import { RULES } from '../sim/rules';
import type { FoodItem } from '../sim/types';
import { installAppHook } from './app-hook';
import { attachKeys, attachPointer } from './app-keys';
import { LifeStarts } from './app-life';
import { OnlineWiring } from './app-online';
import { Frame } from './app-render';
import {
  adultRadius,
  motionQuery,
  newSession,
  type Pond,
  type Scripted,
  type Session,
  type Steering,
  safeStorage,
} from './app-session';
import { Ticker } from './app-tick';
import { PlayUi } from './app-ui';
import { AutoQuality } from './auto-quality';
import { Hatcher } from './body';
import { pick } from './dom';
import { EggShow } from './eggs';
import { createFieldSync } from './field';
import { GrowthWatch } from './growth';
import { Hints } from './hints';
import { HistoryPanel } from './history';
import { Hud } from './hud';
import { HudMenu } from './hud-menu';
import { EdgeIndicatorsUi } from './indicators';
import { InputController } from './input';
import { RemoteLabels } from './labels';
import { type LifeClock, LifeFlow } from './life';
import { resetLife } from './life-reset';
import { LineagePanel } from './lineage-panel';
import { attachVisibilityPause, createLoop, type Loop } from './loop';
import { MateFlow, type Nearby, randomNonce } from './mate';
import { Minimap } from './minimap';
import { OffspringFlow } from './offspring';
import type { OnlineSession } from './online';
import { cleanName, hubSocketUrl, loadName } from './online-config';
import { OnlineKeeper } from './online-keeper';
import { PondMap } from './pond-map';
import { RecoveryPanel } from './recovery-panel';
import { type DrawnRemote, RemoteBodies } from './remote-bodies';
import { RenewalNotice } from './renewal';
import { RevealCard } from './reveal-card';
import { type Screen, Screens } from './screens';
import { loadSettings, reducedMotion, type Settings, saveSettings } from './settings';
import { SettingsPanel } from './settings-panel';
import { MuteList, Social } from './social';
import { SocialUi } from './social-ui';
import { CueWatch } from './sound-cues';
import { Wheel, WheelUi } from './wheel';

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
/** With `timeScale`, a slow software-GL frame must still catch up: 600 ticks is 20 s of sim. */
const DEBUG_MAX_TICKS_PER_FRAME = 600;

/** The offspring card slides in this long after its egg's stir and crack times, just as the egg bursts (M6 T20). */
const CARD_AFTER_CRACK_MS = 250;

/** The ambience's noise seed: one sound for every pond, so the water sounds the same to everyone. */
const AUDIO_SEED = 1;

/** Starts the title screen; the player hatches into the same scene. */
export function startApp(canvas: HTMLCanvasElement, params: GameParams): void {
  new App(canvas, params).start();
}

/**
 * The running game: every part, the state they share, and the wiring between them. The areas
 * (online, life starts, the play UI, the tick, the frame, the keys and the test hook) live in
 * their own modules and take this as their context.
 */
export class App {
  readonly scene: GameScene;
  readonly camera: FollowCamera;
  readonly controller: InputController;
  readonly hud: Hud;
  /** The play screen's one button and its menu (M6b T9). */
  readonly menu: HudMenu;
  readonly history: HistoryPanel;
  readonly renewal: RenewalNotice;
  /** The hub link of the current online session, for the Lineage panel's question. */
  hubLink: { send(msg: { t: 'lineage' }): void } | null = null;
  readonly lineagePanel: LineagePanel;
  readonly storage: Storage | null;
  /** First-life hints (M6b T9): the play screen has no permanent control lines. */
  readonly hints: Hints;
  /**
   * The stored settings; this visit's `?quality=` beats the stored quality without being written,
   * until the player picks one in the panel.
   */
  private readonly stored: Settings;
  settings: Settings;
  private qualityPinned: boolean;
  private readonly systemMotion: MediaQueryList | null;
  /** Sound (M6 T22): one context, started on the first gesture, quiet while the tab is hidden. */
  readonly sound: GameSound;
  /** Event sounds (M6 T23): the life's cues, from its sim events and its state each tick. */
  readonly cueWatch: CueWatch;
  /**
   * Auto-detect and adaptive resolution (M6 T4). Test automation and `?quality=` never measure, so
   * every other E2E and the gallery draw at medium and full resolution unless a test forces it.
   */
  readonly autoQuality: AutoQuality;
  readonly settingsPanel: SettingsPanel;
  readonly fx: Effects;
  /** The result card after a genesis (M6b T11), due once the burst has played out. */
  readonly revealCard: RevealCard;
  cardDue: Session | null = null;
  /** The egg (M6 T20, M6b T11): the beacon reveal, the carried egg, peers' eggs and the hatch. */
  readonly eggs: EggShow;
  /** The life whose creature grows out of an egg; its drawn size follows the egg's pop. */
  emerging: Session | null = null;
  /** Damage shakes the body and the camera slightly (M6b T10), in place of the red edge. */
  readonly shake: Shake;
  readonly labels: RemoteLabels;
  /** Finding other players (M6 T19): arrows on the screen's edge and the pond map. */
  readonly indicatorsUi: EdgeIndicatorsUi;
  readonly pondMap: PondMap;
  /** The minimap (M6b T10): a click on it opens the pond map, as M does. */
  readonly minimap: Minimap;

  /**
   * Other players, drawn from the snapshots they send. Pond time is the hub's clock once a pond is
   * joined; until then it is this tab's own clock.
   */
  readonly remotes: RemoteSet;
  pond: Pond | null = null;
  readonly remoteBodies: RemoteBodies;
  remoteViews: readonly DrawnRemote[] = [];
  scripted: Scripted[] = [];

  /** Without IndexedDB (a private window, say) the identity lasts for this visit only. */
  playerId: string | null = null;
  identity: Identity | null = null;
  readonly identityReady: Promise<void>;
  /**
   * A recovery code moves the identity to another browser. After a replace the page reloads, so
   * the new identity connects and the old tab's session is replaced by the hub (single session).
   */
  readonly recovery: RecoveryPanel;

  /**
   * The recorded life (M4): genesis from the hub, resume, progress and death. A cell it does not
   * know (a pinned body, no hub, an empty hatch bucket) is a practice cell and sends nothing.
   */
  readonly flow: LifeFlow;
  /** The pending child (M5): verified here, drawn as an egg and a card, become-able with H. */
  readonly offspring: OffspringFlow;
  /** Generation of each of the player's creatures, from the hub's lineage answers (for the return choice). */
  readonly generations = new Map<string, number>();
  generationsSeen = 0;
  /** Why the last hatch did not start; shown until the next one. */
  hatchError = '';
  /** When the recorded hatches are used up: the time (performance.now) the next one frees; 0 when free. */
  limitUntil = 0;
  /** The life clock as of the last tick; null for a practice cell and between lives. */
  lastClock: LifeClock | null = null;

  readonly mate: MateFlow;
  readonly ui: PlayUi;
  inspected: string | null = null;
  /** The creature in reach that E would court, as of the last frame. */
  nearby: Nearby | null = null;
  readyShown = '';
  /** Mature, rested and with no pending child: the snapshot's ready mark (a hint for peers). */
  mateReady = false;
  /** The mating flow's state as of the last frame (the egg waits while it is `awaiting`). */
  mateNow = 'idle';

  scale = 1;
  /** Genesis DNA needs a number the sim never sees; the browser supplies it. */
  readonly hatcher: Hatcher;
  session: Session;
  screen: Screen = 'title';
  food: FoodItem[] = [];
  input: Input = IDLE;
  screenShownAt = 0;
  steering: Steering | null = null;
  /** What the creature keeps swimming on while the social wheel is open (M6b T2); a new life clears it. */
  heldInput: Input = IDLE;
  /** Whether `heldInput` came from the movement keys, so releasing them stops the creature. */
  heldFromKeys = false;
  readonly prev = { x: 0, y: 0, heading: 0 };
  readonly field: ReturnType<typeof createFieldSync>;
  readonly growth: GrowthWatch;

  /**
   * The online session (ADRs 0007, 0016): the hub roster, the mesh and the pond they share. Without
   * a hub URL the game runs offline, as in M1.
   */
  readonly hubUrl: string | null;
  readonly keeper: OnlineKeeper<OnlineSession>;
  readonly nameInput: HTMLInputElement;
  readonly nameError: HTMLElement;
  readonly online: OnlineWiring;
  readonly sender: SnapshotSender;
  readonly genomeSync: GenomeSync;
  /** Chat, emotes and pings travel on the reliable event channel; the rules live in `Social`. */
  readonly social: Social;
  /** The quick social wheel (M6 T24): G picks a ping or an emote on purpose. */
  readonly wheel: Wheel;
  readonly wheelUi: WheelUi;
  readonly socialUi: SocialUi;
  readonly life: LifeStarts;
  readonly screens: Screens;

  lastMs: number;
  /** Wall-clock time spent with the world frozen (`timeScale(0)`), which the animation clock skips. */
  heldMs = 0;
  readonly frame: Frame;
  readonly ticker: Ticker;
  /** `timeScale` speeds the sim up by scaling the loop's clock. */
  private virtualMs = 0;
  private lastRealMs: number;
  readonly loop: Loop;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly params: GameParams,
  ) {
    this.scene = new GameScene(canvas, RULES.world.size, {
      dof: params.dof ?? true,
      light: params.light ?? true,
    });
    this.camera = new FollowCamera();
    this.controller = new InputController();
    this.hud = new Hud();
    this.menu = new HudMenu();
    this.history = new HistoryPanel();
    this.renewal = new RenewalNotice();
    this.lineagePanel = new LineagePanel(() => this.hubLink?.send({ t: 'lineage' }));
    pick('[data-testid="menu-lineage"]').addEventListener('click', () => this.lineagePanel.open());
    this.storage = safeStorage();
    this.hints = new Hints(this.storage);
    this.stored = loadSettings(this.storage);
    this.settings = params.quality ? { ...this.stored, quality: params.quality } : this.stored;
    this.qualityPinned = Boolean(params.quality);
    this.systemMotion = motionQuery();
    this.sound = new GameSound({
      seed: AUDIO_SEED,
      volume: this.settings.volume,
      muted: this.settings.muted,
    });
    this.sound.attach(window, document);
    this.cueWatch = new CueWatch((c, at) => this.sound.cue(c, at));
    this.autoQuality = new AutoQuality({
      store: this.storage,
      gpu: this.scene.gpu(),
      measure: !navigator.webdriver && !params.quality,
      onDetect: () => this.applySettings(),
      onScale: (scale) => this.scene.setRenderScale(scale),
    });
    this.settingsPanel = new SettingsPanel(
      (next) => {
        if (next.quality !== this.settings.quality) this.qualityPinned = false;
        this.settings = next;
        saveSettings(
          this.qualityPinned ? { ...next, quality: this.stored.quality } : next,
          this.storage,
        );
        this.applySettings();
      },
      ['settings-open', 'lineage-settings', 'menu-settings'],
    );
    this.applySettings();
    this.systemMotion?.addEventListener?.('change', () =>
      this.settingsPanel.show(
        this.settings,
        resolvePreset(this.settings.quality, this.autoQuality.detected),
        this.autoQuality.detected,
        this.motionReduced(),
      ),
    );
    this.fx = new Effects();
    this.revealCard = new RevealCard(window);
    this.eggs = new EggShow(
      (x, y, radius, rings, mode) => {
        this.fx.burst({ x, y, radius }, rings);
        this.sound.cue('reveal');
        // A genesis's creature has just begun (play waits for the burst): once the shell is gone,
        // the card shows what hatched.
        if (mode === 'genesis' && !this.session.demo) this.cardDue = this.session;
      },
      () => this.sound.cue('stir'),
    );
    this.shake = new Shake();
    this.labels = new RemoteLabels(pick('[data-testid="remote-labels"]'));
    this.indicatorsUi = new EdgeIndicatorsUi(pick('[data-testid="edge-indicators"]'));
    this.pondMap = new PondMap();
    this.minimap = new Minimap(() => {
      if (this.playing() && this.session.player.alive) this.pondMap.toggle();
    });

    this.remotes = new RemoteSet();
    this.remoteBodies = new RemoteBodies();

    let keyStore = indexedDbKeyStore();
    let keyKept = true;
    this.identityReady = createIdentity(keyStore)
      .catch(() => {
        keyStore = memoryKeyStore();
        keyKept = false;
        return createIdentity(keyStore);
      })
      .then((loaded) => {
        // A reload would lose a code kept only in memory, so there is nothing to import into.
        if (!keyKept) this.recovery.disable();
        this.identity = loaded;
        this.playerId = loaded.playerId;
      });
    this.recovery = new RecoveryPanel({
      code: () => this.identity?.exportRecoveryCode() ?? '',
      replace: async (code) => {
        await this.identityReady;
        await importRecoveryCode(keyStore, code);
        location.reload();
      },
    });

    this.flow = new LifeFlow({
      identity: () => this.identity as Identity,
      nonce: randomNonce,
      // BLS12-381 is heavy: its code loads when the first genesis arrives.
      verify: async (g) => {
        const { checkGenesis } = await import('../ledger/genesis');
        return checkGenesis(g.record.record, g.commit.commitment, g.beacon, g.genome);
      },
    });
    this.offspring = new OffspringFlow({
      now: () => performance.now(),
      verify: async (born) => {
        const { birthProblems } = await import('./offspring-check');
        return birthProblems(born, this.playerId ?? '');
      },
      eggMs: (child) =>
        EGG.stirMs[child.body.rarity] + EGG.crackMs[child.body.rarity] + CARD_AFTER_CRACK_MS,
    });

    // Courting (M5): the creature as the mating rules see it, and what the hub is asked.
    this.mate = new MateFlow({
      identity: () => this.identity as Identity,
      nonce: randomNonce,
      now: () => performance.now(),
      nameOf: (id) => this.keeper.current?.nameOf(id),
      own: () => this.ownMateView(),
    });
    this.ui = new PlayUi(this);
    attachPointer(this);

    this.hatcher = new Hatcher({
      pinned: params.genome ?? null,
      random: () => crypto.getRandomValues(new Uint32Array(2)).join('-'),
      warn: (message) => console.warn(message),
    });
    this.session = newSession(params.seed, true, this.hatcher.title());
    this.field = createFieldSync(() => this.refreshField());
    this.growth = new GrowthWatch();

    this.hubUrl = hubSocketUrl(window.location.search, __AUTHORITY_URL__);
    this.keeper = new OnlineKeeper<OnlineSession>({
      start: (name) => {
        this.social.selfName = name;
        this.social.reset();
        return this.online.start(name, this.identity as Identity);
      },
      stop: (link) => {
        for (const { playerId: id } of link.others()) this.dropPeer(id);
        link.dispose();
      },
      isFinal: (link) => isFinalStatus(link.status),
    });
    const nameField = pick('[data-testid="name-field"]');
    this.nameInput = pick<HTMLInputElement>('[data-testid="name-input"]');
    this.nameError = pick('[data-testid="name-error"]');
    this.online = new OnlineWiring(this);
    this.sender = new SnapshotSender((bytes) => this.keeper.current?.broadcastState(bytes));
    // Bodies on the wire (M3 T16): the genome goes out when a link opens and after every rehatch.
    this.genomeSync = new GenomeSync({
      send: (id, event) => this.keeper.current?.sendEvent(id, event),
      broadcast: (event) => this.keeper.current?.broadcastEvent(event),
      hasLink: (id) => this.keeper.current?.hasLink(id) === true,
      accept: (id, text) => this.remoteBodies.add(id, text),
    });

    this.social = new Social({
      now: () => performance.now(),
      // Scripted remotes (`?debug=1` only) are in the roster as a peer is.
      nameOf: (id) =>
        this.keeper.current?.nameOf(id) ?? this.scripted.find((r) => r.spec.id === id)?.spec.name,
      send: (event) => this.keeper.current?.broadcastEvent(event),
      muted: new MuteList(this.storage),
      selfName: 'You',
      heard: ({ kind, from, at }) => {
        if (kind !== 'emote' || from === this.selfKey()) {
          this.sound.cue(kind, at ?? undefined);
          return;
        }
        // A peer's emote sounds over its creature; one that is not drawn here is not heard.
        const r = this.remoteViews.find((v) => v.id === from);
        if (r) this.sound.cue('emote', { x: r.x, y: r.y });
      },
    });
    this.wheel = new Wheel(({ item, world }) => {
      if (item.kind === 'ping') this.social.ping(world, this.selfKey(), item.id);
      else this.social.sendEmote(item.id, this.selfKey());
    });
    this.wheelUi = new WheelUi(this.wheel);
    window.addEventListener('blur', () => this.wheel.cancel());
    this.socialUi = new SocialUi(this.social, {
      submit: (text) => this.social.sendChat(text, this.selfKey()),
      typing: (on) => {
        this.controller.typing = on;
        if (on) {
          this.controller.reset();
          this.wheel.cancel();
        }
      },
    });

    this.life = new LifeStarts(this);
    this.screens = new Screens({
      hatch: () => this.life.hatch(),
      choose: (choice) => this.life.become(choice),
      practice: () => {
        this.limitUntil = 0;
        this.flow.practice();
        this.life.begin(this.pond !== null);
      },
    });
    if (this.hubUrl) {
      nameField.hidden = false;
      this.nameInput.value = loadName(this.storage);
      void this.identityReady
        .then(() => this.online.ensure(cleanName(this.nameInput.value) ?? loadName(this.storage)))
        .catch(() => {});
      // Leave the roster promptly instead of waiting for the hub to notice the dead socket. A page
      // restored from the back/forward cache joins again.
      window.addEventListener('pagehide', () => this.keeper.suspend());
      window.addEventListener('pageshow', () => this.keeper.resume());
    }
    attachKeys(this);

    this.lastMs = performance.now();
    this.frame = new Frame(this);
    this.ticker = new Ticker(this);
    this.lastRealMs = performance.now();
    this.loop = createLoop({
      now: () => this.clock(),
      tick: () => this.ticker.tick(),
      render: (alpha) => this.frame.render(alpha),
      maxTicksPerFrame: params.debug ? DEBUG_MAX_TICKS_PER_FRAME : 5,
    });
  }

  /** Starts the loop on the title screen and installs the test hook. */
  start(): void {
    const { loop, scene, autoQuality } = this;
    attachVisibilityPause(document, loop);
    let lastFrameMs = performance.now();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      // The pond moved on while the tab was hidden: skip ahead instead of simulating it.
      this.livePond()?.time.resnap(this.session.world, performance.now());
      // Cues run on wall-clock time: hidden time must not skip the death dissolve.
      this.lastMs = performance.now();
      this.fx.resume();
      lastFrameMs = performance.now();
      autoQuality.resume(lastFrameMs);
    });

    let frames = 0;
    scene.start(() => {
      loop.frame();
      frames += 1;
      this.canvas.dataset.frames = String(frames);
      const now = performance.now();
      const auto = this.settings.quality === 'auto';
      autoQuality.frame(now - lastFrameMs, now, this.screen === 'title', auto, scene.quality);
      lastFrameMs = now;
    });

    this.life.enter(this.session, 'title');
    installAppHook(this);
  }

  /** The loop's clock: real time scaled by `timeScale`. */
  clock(): number {
    const real = performance.now();
    this.virtualMs += (real - this.lastRealMs) * this.scale;
    this.lastRealMs = real;
    return this.virtualMs;
  }

  private applySettings(): void {
    const preset = resolvePreset(this.settings.quality, this.autoQuality.detected);
    this.scene.setPreset(preset);
    this.sound.setVolume(this.settings.volume);
    this.sound.setMuted(this.settings.muted);
    this.settingsPanel.show(this.settings, preset, this.autoQuality.detected, this.motionReduced());
  }

  /** Reduced motion now: the player's choice, else the system's (M6 T22). */
  motionReduced(): boolean {
    return reducedMotion(this.settings, this.systemMotion?.matches === true);
  }

  /** The eggs' clock: wall time, held still while the world is frozen (`timeScale(0)`), as the shaders' is. */
  eggClock(): number {
    return performance.now() - this.heldMs;
  }

  pondMs(): number {
    return this.pond ? this.pond.time.pondMs(performance.now()) : performance.now();
  }

  limitLeft(): number {
    return Math.max(0, this.limitUntil - performance.now());
  }

  /** The creature as the mating rules see it; null when it cannot court. */
  ownMateView(): MateView | null {
    const life = this.flow.view();
    const { player } = this.session;
    if (this.session.demo || life.status !== 'playing' || !life.creature || !player.alive) {
      return null;
    }
    return {
      creature: life.creature,
      owner: this.playerId ?? '',
      active: true,
      activeMs: this.lastClock?.activeMs ?? life.activeMs,
      // The first ack brings the real numbers; until then nobody is mature.
      matureAtMs: life.matureAtMs > 0 ? life.matureAtMs : Number.POSITIVE_INFINITY,
      cooldownUntilMs: life.cooldownUntilMs,
      biomass: player.biomass,
      energy: player.energy,
      hasPending: life.pending,
      inFlight: false,
      locked: false,
    };
  }

  private refreshField(): void {
    const { world, player } = this.session;
    const radius = Math.sqrt(player.biomass);
    const half = Math.max(this.camera.halfHeight, viewHalfHeight(radius, adultRadius(player)));
    const reach = Math.hypot(half * this.scene.aspect, half) + FIELD_MARGIN;
    this.food = foodNear(world, player.x, player.y, reach);
    this.scene.setField(this.food, plumesNear(world, player.x, player.y, reach));
  }

  /** A slew factor belongs to the pond clock it chases, and an open chat would swallow Enter. */
  endLifeState(): void {
    resetLife({
      setSpeed: (speed) => this.loop.setSpeed(speed),
      closeChat: () => this.socialUi.close(),
    });
  }

  dropPeer(id: string): void {
    this.remotes.removeMember(id);
    this.remoteBodies.remove(id);
    this.genomeSync.forget(id);
  }

  selfKey(): string {
    return this.playerId ?? 'local';
  }

  worldAt(px: number, py: number): Vec2 {
    return {
      x: this.camera.x + (px - this.scene.width / 2) / this.scene.pxPerWu,
      y: this.camera.y - (py - this.scene.height / 2) / this.scene.pxPerWu,
    };
  }

  playing(): boolean {
    return this.screen === 'playing' && !this.session.demo && this.session.death === null;
  }

  /** The pond, while a real life (not the title screen's cell) is running in it. */
  livePond(): Pond | null {
    return this.session.demo ? null : this.session.pond;
  }
}
