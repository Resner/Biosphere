import type { Identity } from '../ledger/identity';
import { consumedParts } from '../net/claims';
import type { PondClock } from '../net/clock';
import type { Welcome } from '../net/hub-client';
import type { PeerEvent } from '../net/protocol';
import { createWorld } from '../sim/world';
import { AloneHint } from './alone-hint';
import type { App } from './app';
import { countItem, type Pond } from './app-session';
import { pick } from './dom';
import { connectOnline, type OnlineSession } from './online';
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

  constructor(private readonly app: App) {}

  private makePond(w: Welcome, hubClock: PondClock): Pond {
    const { app } = this;
    return {
      id: w.pond.id,
      seed: w.pond.seed,
      size: w.pond.size,
      ring: { centre: w.pond.centre, hint: w.you.spawnHint },
      lives: 0,
      time: new PondTime(hubClock, w.pond.epoch),
      food: new PondFood(app.playerId ?? 'local', (event) =>
        app.keeper.current?.broadcastEvent(event),
      ),
      world: createWorld({ seed: w.pond.seed, size: w.pond.size }),
    };
  }

  /** Connects to the hub under `name`: the keeper's `start`. */
  start(name: string, loaded: Identity): OnlineSession {
    const { app } = this;
    const link = connectOnline({
      url: app.hubUrl as string,
      identity: loaded,
      name,
      handlers: {
        welcome: (w) => {
          const life = app.session.demo ? null : app.session.pond;
          const next = switchPond(app.pond, life, w.pond.id, () => this.makePond(w, link.clock));
          if (next.changed) {
            app.pond = next.pond;
            app.social.reset();
            // A life in the old pond carries on in a local one; the chip says so.
            if (life && !next.life) {
              app.session.pond = null;
              // The old pond's eaten food is not this life's any more.
              app.session.world.consumed = { ...app.session.world.consumed };
              app.loop.setSpeed(1);
            }
          }
          app.social.worldSize = w.pond.size;
          app.mate.attach(link);
        },
        life(msg) {
          app.flow.receive(msg);
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
          if (msg.t === 'life') app.renewal.receive(msg.renewed === true);
          if (msg.t === 'history') app.history.show(msg.lives, Date.now());
          // Past lives are asked for once the hub has said who the player is, and after each death.
          if (msg.t === 'life' || msg.t === 'died') link.send({ t: 'history' });
        },
        member(op, member) {
          if (op === 'join') {
            app.remotes.setMember(member.playerId, member.name);
          } else {
            app.dropPeer(member.playerId);
          }
        },
        peerOpen(id) {
          // The new peer learns what has been eaten; the reliable channel keeps the parts in order.
          if (app.pond) for (const part of consumedParts(app.pond.world)) link.sendEvent(id, part);
          app.genomeSync.peerOpen(id);
        },
        state(id, snapshot) {
          app.remotes.receive(id, snapshot, performance.now());
        },
        event: (id, event) => {
          this.receiveFoodEvent(id, event);
          app.social.receive(id, event);
          app.genomeSync.receive(id, event, performance.now());
        },
      },
    });
    app.flow.attach(link);
    app.mate.attach(link);
    app.hubLink = link;
    // A panel opened before the link was up asks again once it is.
    if (app.lineagePanel.isOpen) link.send({ t: 'lineage' });
    return link;
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

  /** The connection line, the offline chip and the alone hint, each frame. */
  updateNetUi(now: number, joined: Pond | null): void {
    const { app } = this;
    const { keeper, hubUrl } = app;
    // A life in a local pond is alone, whatever the hub says about its own pond.
    const apart = app.screen === 'playing' && !app.session.demo && app.session.pond === null;
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
    if (text !== this.shownStatus) {
      this.shownStatus = text;
      this.netStatus.textContent = text;
      this.menuNet.textContent = text;
    }
    const status = keeper.current?.status ?? 'connecting';
    app.hud.setOffline(offlineChip(hubUrl !== null, status, apart) ? text : null);
    const lonely = this.alone.update(
      now,
      joined !== null && keeper.current?.status === 'online',
      (keeper.current?.count ?? 1) - 1,
    );
    if (this.aloneElement.hidden === lonely) this.aloneElement.hidden = !lonely;
  }
}
