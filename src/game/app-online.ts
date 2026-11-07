import { parseGenomeText } from '../genome/codec';
import { speciesName } from '../genome/names';
import type { Identity } from '../ledger/identity';
import { signSnap, verifySnap } from '../ledger/snapshot-sig';
import { consumedParts } from '../net/claims';
import type { PondClock } from '../net/clock';
import type { FightMsg, LifeMsg, Welcome } from '../net/hub-client';
import { type SnapshotFields, type SnapshotMarks, snapshotOf } from '../net/pond-sync';
import { encodeSnapshot, type PeerEvent, type SignedSnap } from '../net/protocol';
import { ProxyReceiver, ProxyRelay } from '../net/proxy-snaps';
import { SignedSnaps } from '../net/signed-snaps';
import { dropCarrion } from '../sim/carrion';
import { survivedOutcome } from '../sim/encounter/types';
import { createWorld } from '../sim/world';
import { AloneHint } from './alone-hint';
import type { App } from './app';
import { adultRadius, countItem, type Pond } from './app-session';
import { pick } from './dom';
import { CandidateSigner, lockState, SpawnShield } from './engage';
import { fightEnded } from './fight-end';
import { type CreatureNow, connectOnline, type OnlineSession } from './online';
import { offlineChip, statusText, switchPond } from './online-config';
import { PondFood } from './pond-food';
import { PondTime } from './pond-time';

/** The online session's wiring (ADRs 0007, 0016): the hub's messages, peers' events and the net chip. */
export class OnlineWiring {
  private readonly netStatus = pick('[data-testid="net-status"]');
  private readonly menuNet = pick('[data-testid="menu-net"]');
  private readonly aloneElement = pick('[data-testid="alone-hint"]');
  private readonly alone = new AloneHint();
  /** The connection line as last shown. */
  shownStatus = '';
  /** Spawn protection as the own snapshot shows it (M7 T7). */
  readonly shield = new SpawnShield();
  /** Signs every second snapshot for the engage candidates; `signer.ids` names them. */
  readonly signer: CandidateSigner;
  /** Each peer's newest signed snapshot, verified on receipt, to forward at an engage (M7 T8). */
  readonly signed: SignedSnaps;
  /** The own fight's away opponents: drawn here, and relayed to the pond by the lowest slot (M8 T11). */
  readonly relay: ProxyRelay;
  /** Proxies from the pond's fighters, checked before they draw anyone (M8 T11). */
  readonly proxies: ProxyReceiver;
  private readonly marks: SnapshotMarks = {
    ready: false,
    egg: false,
    spawnProtected: false,
    fighting: false,
  };

  constructor(private readonly app: App) {
    this.signer = new CandidateSigner(() => {
      const { identity, pond } = this.app;
      return identity && pond ? { identity, pondId: pond.id } : null;
    });
    this.signed = new SignedSnaps((id, s) => {
      const pond = this.app.pond;
      return pond ? verifySnap(id, pond.id, s) : null;
    });
    const link = () => this.app.keeper.current;
    this.relay = new ProxyRelay({
      get self() {
        return app.playerId ?? '';
      },
      present: (player) => link()?.present(player) === true,
      peers: () => link()?.openPeers() ?? [],
      send: (peer, frame) => link()?.sendState(peer, frame),
      show: (player, snapshot) => app.remotes.proxy(player, snapshot, performance.now()),
    });
    this.proxies = new ProxyReceiver(() => app.playerId, app.remotes);
  }

  /** Each frame while the own fight runs: its away opponents drawn, and relayed if this client relays. */
  relayProxies(now: number): void {
    const { app } = this;
    const fight = app.fight.fighting ? app.fight.relayFight() : null;
    if (fight) this.relay.update(now, fight);
  }

  /** The own creature as peers see it now. */
  ownSnapshot(): SnapshotFields {
    const { app, marks } = this;
    const { player } = app.session;
    marks.ready = app.mateReady;
    // Peers see the egg from the commitment on, as the owner does (M6 T20).
    marks.egg = app.offspring.child() !== null || app.mateNow === 'awaiting';
    marks.spawnProtected = this.shield.active(app.pondMs());
    marks.fighting = app.fight.fighting;
    return snapshotOf(player, app.session.world.tick, app.session.body.ref, marks);
  }

  /** The frame's snapshot to the peers, signed every 200 ms for the engage candidates. */
  sendSnapshot(now: number, hidden: boolean): void {
    const { app } = this;
    app.sender.update(
      now,
      hidden,
      () => this.ownSnapshot(),
      (bytes) =>
        app.session.player.alive
          ? this.signer.sign(bytes, app.session.player, app.remoteViews)
          : null,
    );
  }

  /** The own creature's state now, signed for the hub's pond (an engage carries it); null outside one. */
  signedNow(): SignedSnap | null {
    const { app } = this;
    const pond = app.livePond();
    if (!pond || pond !== app.pond || !app.identity) return null;
    const bytes = encodeSnapshot({ ...this.ownSnapshot(), seq: app.sender.nextSeq });
    return signSnap(app.identity, pond.id, bytes);
  }

  /** Someone engages this player: the creature's state now, signed, before anything else runs. */
  private answerLock(ask: { lock: string; by: string }, link: OnlineSession): void {
    const { app } = this;
    const pond = app.livePond();
    if (!pond || pond !== app.pond || !app.identity) return;
    const bytes = encodeSnapshot({ ...this.ownSnapshot(), seq: app.sender.nextSeq });
    // The attacker's own snapshots as this page saw them: the authority's movement check (M10 T11).
    const seen = this.signed.recent(ask.by, performance.now());
    link.send(lockState(ask.lock, bytes, app.identity, pond.id, seen));
  }

  private makePond(w: Welcome, hubClock: PondClock): Pond {
    const { app } = this;
    return {
      id: w.world.id,
      seed: w.world.seed,
      size: w.world.size,
      ring: { centre: w.world.centre, hint: w.you.spawnHint },
      lives: 0,
      time: new PondTime(hubClock, w.world.epoch),
      food: new PondFood(app.playerId ?? 'local', (event) =>
        app.keeper.current?.broadcastEvent(event),
      ),
      world: createWorld({ seed: w.world.seed, size: w.world.size }),
    };
  }

  /**
   * The own creature as the links see it (M11 T13): a life in the hub's world, in the water while
   * it lives and the tab shows; null on the title or for a life in a local world.
   */
  creatureNow(): CreatureNow | null {
    const { app } = this;
    const pond = app.livePond();
    if (!pond || pond !== app.pond) return null;
    const { player } = app.session;
    const r = Math.sqrt(Math.max(1, player.biomass));
    return {
      x: player.x,
      y: player.y,
      vx: player.vx,
      vy: player.vy,
      r,
      adultR: Math.max(r, adultRadius(player)),
      inWater: player.alive && !document.hidden,
    };
  }

  /** Connects to the hub under `name`: the keeper's `start`. */
  start(name: string, loaded: Identity): OnlineSession {
    const { app } = this;
    const link = connectOnline({
      url: app.hubUrl as string,
      identity: loaded,
      name,
      creature: () => this.creatureNow(),
      keys: app.authorityKeys,
      handlers: {
        welcome: (w) => {
          const life = app.session.demo ? null : app.session.pond;
          const next = switchPond(app.pond, life, w.world.id, () => this.makePond(w, link.clock));
          if (next.changed) {
            app.pond = next.pond;
            app.social.reset();
            this.signed.clear();
            // A life in the old pond carries on in a local one; the chip says so.
            if (life && !next.life) {
              app.session.pond = null;
              // The old pond's eaten food and carrion are not this life's any more.
              app.session.world.consumed = { ...app.session.world.consumed };
              app.session.world.carrion = [...app.session.world.carrion];
              app.loop.setSpeed(1);
            }
          }
          app.social.worldSize = w.world.size;
          app.mate.attach(link);
          app.duty.welcome();
        },
        life: (msg) => {
          // An engage's refusal is the attack's alone (M7 T11); a bare 'no-creature' may also be
          // the life flow's, so it reaches both.
          if (msg.t === 'refused') {
            if (msg.reason.startsWith('engage:')) {
              app.attack.refused(msg.reason);
              return;
            }
            if (msg.reason === 'no-creature' && app.attack.waiting) app.attack.refused(msg.reason);
          }
          app.flow.receive(msg, app.session.ticks);
          app.mate.receive(msg);
          app.offspring.receive(msg);
          if (msg.t === 'lineage') {
            app.lineagePanel.receive(msg.creatures, msg.pedigree);
            for (const c of msg.creatures) app.generations.set(c.creature, c.generation);
            app.generationsSeen++;
          }
          // The return choice names the ancestor's generation, which only the lineage knows.
          const ancestor = msg.t === 'life' || msg.t === 'died' ? msg.fallback?.ancestor : null;
          if (ancestor && !app.generations.has(ancestor.creature)) {
            link.send({ t: 'lineage' });
          }
          if (msg.t === 'born') app.hud.toast('Your offspring is ready');
          if (msg.t === 'life') {
            app.renewal.receive(msg.renewed === true);
            app.resume.life(msg.fight);
            app.fight.named(msg.fight);
            this.tellAway(msg);
          }
          if (msg.t === 'history') {
            app.history.show(msg.lives, Date.now());
            app.awayReport.history(msg.lives);
          }
          // Past lives are asked for once the hub has said who the player is, and after each death.
          if (msg.t === 'life' || msg.t === 'died') link.send({ t: 'history' });
        },
        peerOpen: (id, name) => {
          app.remotes.setMember(id, name);
          // The new peer learns what has been eaten near this creature (M11 T13); the reliable
          // channel keeps the parts in order.
          const at = this.creatureNow();
          if (app.pond && at) {
            for (const part of consumedParts(app.pond.world, at)) link.sendEvent(id, part);
          }
          app.genomeSync.peerOpen(id);
        },
        peerLeft: (id) => app.dropPeer(id),
        state: (id, snapshot, signed) => {
          const now = performance.now();
          app.remotes.receive(id, snapshot, now);
          if (signed) this.signed.receive(id, snapshot, signed, now);
        },
        fight: (msg) => {
          // A duty's frames before its handover, and the handover, reach this page as a witness too.
          if (msg.t === 'enc-frame' || msg.t === 'enc-referee') app.duty.fight(msg);
          if (msg.t === 'lock-ask') this.answerLock(msg, link);
          // On the title, a running fight's messages wait for "Back to the fight" (M8 T10).
          else if (!app.resume.hold(msg)) this.fightMsg(msg);
        },
        proxy: (id, player, snapshot) => {
          this.proxies.receive(id, player, snapshot, performance.now());
        },
        duty: (msg) => app.duty.receive(msg),
        event: (id, event) => {
          // A duty link's witness messages (M10 T7): a fighter's input or a probe to this page, a
          // witness's frame to this page's fight.
          if (event.t === 'finput' || event.t === 'probe') {
            app.duty.peerEvent(id, event);
            return;
          }
          if (event.t === 'wframe') {
            app.fight.witnessFrame(id, event);
            return;
          }
          this.receiveFoodEvent(id, event);
          app.social.receive(id, event);
          app.genomeSync.receive(id, event, performance.now());
        },
      },
    });
    if (app.netCap !== null) link.setCap(app.netCap);
    app.flow.attach(link);
    app.mate.attach(link);
    app.hubLink = link;
    // A panel opened before the link was up asks again once it is.
    if (app.lineagePanel.isOpen) link.send({ t: 'lineage' });
    return link;
  }

  /** A fight message from the hub, as it comes or held until the player resumes the fight. */
  fightMsg(msg: Exclude<FightMsg, { t: 'lock-ask' }>): void {
    const { app } = this;
    const wasFighting = app.fight.fighting;
    if (msg.t === 'carrion') this.dropCarrion(msg);
    else app.fight.receive(msg);
    if (msg.t === 'enc-end') {
      // The away opponents' last frame carries the result's alive flag (M8 T11).
      const fight = wasFighting ? app.fight.relayFight() : null;
      if (fight?.id === msg.enc) {
        this.relay.end(fight, (slot) => {
          const result = msg.fighters[slot];
          return result ? survivedOutcome(result.outcome) : true;
        });
      }
    }
    if (msg.t === 'enc-start') app.attack.started();
    if (msg.t === 'enc-end') {
      fightEnded(msg, {
        playerId: app.identity?.playerId ?? null,
        toast: (text) => app.hud.toast(text),
        loseEgg: () => {
          app.offspring.eaten();
          app.flow.eggEaten();
        },
      });
    }
  }

  /**
   * A fight settled while the player was away (M8 T12): told once, with the creature's species when
   * the page knows it (the creature that lives on, or the one this page played), and an eaten egg's
   * pending child let go.
   */
  private tellAway(msg: Extract<LifeMsg, { t: 'life' }>): void {
    const { app } = this;
    const { report } = msg;
    if (!report) return;
    const genome = msg.life ? parseGenomeText(msg.life.genome) : null;
    const played = !app.session.demo && app.screen !== 'title' ? app.session.body.species : null;
    const species = genome ? speciesName(genome) : played;
    if (!app.awayReport.life(report, species)) return;
    if (report.egg === 'eaten') {
      app.offspring.eaten();
      app.flow.eggEaten();
    }
  }

  /** Connects (or reconnects under a new name) once the identity is loaded. */
  ensure(name: string): void {
    const { app } = this;
    if (!app.hubUrl || !app.identity) return;
    app.keeper.ensure(name);
  }

  /** A peer's claim or consumed set: update the shared food and give back a bite that lost. */
  receiveFoodEvent(from: string, event: PeerEvent): void {
    const { app } = this;
    const { pond } = app;
    if (!pond) return;
    // The stand-in world is never stepped; its tick is the pond clock the claims are judged by.
    pond.world.tick = pond.time.tickAt(performance.now());
    const stolen = pond.food.receive(pond.world, from, event);
    app.field.markDirty();
    // A bite is only given back by a life in this pond, never by a local one.
    const { session } = app;
    if (!stolen || session.demo || session.pond !== pond) return;
    const { player, counts } = session;
    player.energy = Math.max(0, player.energy - stolen.value);
    counts.stolen = (counts.stolen ?? 0) + 1;
    countItem(counts, 'stolen', `${stolen.slot}_k${stolen.k}`);
    app.hud.update(player);
  }

  /** A kill's carrion: the same pieces on every client of the pond, drawn with the food. */
  dropCarrion(msg: Extract<FightMsg, { t: 'carrion' }>): void {
    const { app } = this;
    const { pond } = app;
    if (!pond) return;
    dropCarrion(pond.world, msg);
    app.field.markDirty();
  }

  /** The connection line, the offline chip and the alone hint, each frame. */
  updateNetUi(now: number, joined: Pond | null): void {
    const { app } = this;
    const { keeper, hubUrl } = app;
    // A life in a local pond is alone, whatever the hub says about its own pond.
    const apart = app.screen === 'playing' && !app.session.demo && app.session.pond === null;
    let text = '';
    if (hubUrl) {
      text = apart
        ? statusText('offline', 0)
        : statusText(
            keeper.current?.status ?? 'connecting',
            keeper.current?.count ?? 0,
            keeper.current?.queue ?? null,
          );
    }
    if (text !== this.shownStatus) {
      this.shownStatus = text;
      this.netStatus.textContent = text;
      this.menuNet.textContent = text;
    }
    const status = keeper.current?.status ?? 'connecting';
    app.hud.setOffline(offlineChip(hubUrl !== null, status, apart) ? text : null);
    const online = joined !== null && keeper.current?.status === 'online';
    const lonely = this.alone.update(
      now,
      online,
      online && keeper.current?.alone() === false ? 1 : 0,
    );
    if (this.aloneElement.hidden === lonely) this.aloneElement.hidden = !lonely;
  }
}
