import { rarityOfTraits } from '../genome/rarity';
import { ownRefusal } from '../sim/mating';
import { RULES, TICK_HZ } from '../sim/rules';
import { sizeTier } from '../sim/size';
import type { App } from './app';
import { setBadge } from './badge';
import type { Body } from './body';
import { listItem, pick } from './dom';
import { growthText, sizeShare } from './growth';
import { countdownText } from './life-text';
import { inspectCard } from './mate-card';
import { readyText } from './mate-text';
import { drawPreview } from './offspring-preview';
import { childLine, fallbackOptions } from './offspring-text';
import type { DrawnRemote } from './remote-bodies';
import { setStars } from './reveal-card';

/** A first-life hint fades out over this much of its end, in milliseconds of play. */
const HINT_FADE_MS = 600;

const setIfChanged = (el: HTMLElement, text: string): void => {
  if (el.textContent !== text) el.textContent = text;
};

/**
 * The play screen's DOM, updated each frame: courting (the hint, the invitation and the inspect
 * card), the offspring card and the choice after a death, the first-life hint, the hatch note and
 * the size line.
 */
export class PlayUi {
  private readonly hintElement = pick('[data-testid="hint"]');
  /** The first-life hint on screen; null when none is. */
  shownHint: string | null = null;
  private readonly hatchNote = pick('[data-testid="hatch-note"]');
  readonly mateHint = pick('[data-testid="mate-hint"]');
  private readonly invitePanel = pick('[data-testid="invite"]');
  private readonly inviteName = pick('[data-testid="invite-name"]');
  private readonly inviteBody = pick('[data-testid="invite-body"]');
  private readonly inviteBand = pick('[data-testid="invite-band"]');
  private readonly inviteLeft = pick('[data-testid="invite-left"]');
  private readonly inviteBadge = pick('[data-testid="invite-badge"]');
  // The inspect card (M5 T12): click another creature to read it before courting.
  private readonly inspectPanel = pick('[data-testid="inspect"]');
  private readonly inspectName = pick('[data-testid="inspect-name"]');
  private readonly inspectBadge = pick('[data-testid="inspect-badge"]');
  private readonly inspectSpecies = pick('[data-testid="inspect-species"]');
  private readonly inspectMeta = pick('[data-testid="inspect-meta"]');
  private readonly inspectTraits = pick('[data-testid="inspect-traits"]');
  private readonly inspectKinship = pick('[data-testid="inspect-kinship"]');
  private readonly inspectVerdict = pick('[data-testid="inspect-verdict"]');
  private readonly inspectHints = pick('[data-testid="inspect-hints"]');
  /** What the card on screen was built from; it is rebuilt only when one of these changes. */
  private inspectFrom: readonly unknown[] = [];
  // The offspring card and the choice after a death (M5 T11); the egg is drawn in the scene (M6 T20).
  readonly cardElement = pick('[data-testid="offspring"]');
  private readonly cardPreview = pick<HTMLCanvasElement>('[data-testid="offspring-preview"]');
  private readonly cardName = pick('[data-testid="offspring-name"]');
  private readonly cardLine = pick('[data-testid="offspring-line"]');
  private readonly cardStars = pick('[data-testid="offspring-stars"]');
  /** The rarity the offspring card shows (its frame and stars, M6b T11). */
  cardTier: Body['rarity'] | null = null;
  private previewOf: string | null = null;
  private offspringKind = 'none';
  private optionsKey: unknown[] = [];
  private shownNote = '';
  private shownLimit = false;

  constructor(private readonly app: App) {
    pick('[data-testid="inspect-close"]').addEventListener('click', () => {
      app.inspected = null;
    });
    pick('[data-testid="offspring-become"]').addEventListener('click', () =>
      app.life.become('child'),
    );
    pick('[data-testid="offspring-later"]').addEventListener('click', () =>
      app.offspring.postpone(),
    );
  }

  /** The size line and bar, and a ring each time the creature has grown another tenth. */
  private updateGrowth(matureAtMs: number): void {
    const { app } = this;
    const { player } = app.session;
    const { maxBiomass } = player.phys;
    app.hud.setGrowth(
      growthText({
        biomass: player.biomass,
        maxBiomass,
        activeMs: app.lastClock?.activeMs ?? 0,
        matureAtMs,
        stage: app.lastClock?.stage ?? 'young',
      }),
      sizeShare(player.biomass, maxBiomass),
    );
    const cue = app.growth.update(player.biomass, maxBiomass);
    if (cue) {
      app.fx.growPulse(
        { x: player.x, y: player.y, radius: Math.sqrt(player.biomass) },
        cue === 'tier',
      );
      app.sound.cue(cue === 'tier' ? 'tier' : 'grow');
    }
  }

  updateOffspringUi(): void {
    const { app, cardElement } = this;
    const { offspring, session, hud } = app;
    offspring.tick();
    const playingNow = app.screen === 'playing' && !session.demo && session.death === null;
    const state = offspring.view();
    hud.setEgg(playingNow && session.player.alive && offspring.child() !== null);
    const card = playingNow && state.kind === 'card' && !state.later;
    if (cardElement.hidden === card) cardElement.hidden = !card;
    if (state.kind === 'card' || state.kind === 'egg') {
      setIfChanged(this.cardName, state.child.body.species);
      setIfChanged(this.cardLine, childLine(state.child));
      this.cardTier = state.child.body.rarity;
      setStars(cardElement, this.cardStars, this.cardTier);
      if (this.previewOf !== state.child.body.hash) {
        this.previewOf = state.child.body.hash;
        drawPreview(this.cardPreview, state.child.body);
      }
    }
    if (state.kind === 'failed' && this.offspringKind !== 'failed') hud.toast(state.message);
    this.offspringKind = state.kind;
    // The choice for a dead or not-yet-hatched player, rebuilt only when what it names changes.
    const fallback = app.flow.view().fallback;
    const child = offspring.child();
    const key = [fallback, child, app.generationsSeen];
    if (key.some((v, i) => v !== this.optionsKey[i])) {
      this.optionsKey = key;
      app.screens.setFallback(fallbackOptions(fallback, child, (id) => app.generations.get(id)));
    }
  }

  /** The first-life hint for this moment of play (M6b T9); it fades out over its last moments. */
  updateHint(): void {
    const { app, hintElement } = this;
    const { session, hints } = app;
    const live = app.screen === 'playing' && !session.demo && session.death === null;
    const playMs = (session.ticks * 1000) / TICK_HZ;
    const text = live ? hints.at(playMs) : null;
    if (text !== this.shownHint) {
      this.shownHint = text;
      if (text) hintElement.textContent = text;
      hintElement.hidden = text === null;
    }
    const leaving = text !== null && hints.at(playMs + HINT_FADE_MS) !== text;
    hintElement.toggleAttribute('data-leaving', leaving);
  }

  /** The inspect card beside a clicked creature: closed when it leaves, dies or the game stops. */
  private updateInspectUi(playingNow: boolean, invited: boolean): void {
    const { app, inspectPanel, inspectVerdict } = this;
    const { mate } = app;
    if (!playingNow || invited) app.inspected = null;
    const remote = app.inspected ? app.remoteViews.find((r) => r.id === app.inspected) : undefined;
    if (app.inspected && !remote) app.inspected = null;
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
      app.session.body.text,
      info,
      sizeTier(remote.radius * remote.radius),
    ];
    if (from.some((v, i) => v !== this.inspectFrom[i])) {
      this.inspectFrom = from;
      const card = inspectCard({
        name: remote.name,
        radius: remote.radius,
        species: remote.species,
        body: remote.body,
        genomeText: remote.genomeText,
        ownGenomeText: app.session.body.text,
        info,
      });
      setIfChanged(this.inspectName, card.name);
      setBadge(this.inspectBadge, card.rarity);
      setIfChanged(this.inspectSpecies, card.species);
      setIfChanged(this.inspectMeta, card.meta);
      this.inspectTraits.replaceChildren(...card.traits.map(listItem));
      setIfChanged(this.inspectKinship, card.kinship);
      setIfChanged(inspectVerdict, card.verdict);
      inspectVerdict.dataset.can = String(card.canMate);
      this.inspectHints.replaceChildren(...(card.hints?.lines ?? []).map(listItem));
    }
    // Beside the creature, never over it: on the side of the screen it is not on.
    const side = remote.x < app.camera.x ? 'right' : 'left';
    if (inspectPanel.dataset.side !== side) inspectPanel.dataset.side = side;
    if (inspectPanel.hidden) inspectPanel.hidden = false;
  }

  /** Courting on screen: the key beside a creature in reach, the invitation, and the cooldown. */
  updateMateUi(): void {
    const { app, mateHint, invitePanel } = this;
    const { mate, remoteViews, hud } = app;
    const playingNow = app.screen === 'playing' && !app.session.demo;
    mate.tick();
    const { player } = app.session;
    app.nearby = null;
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
      if (near) app.nearby = { id: near.id, name: near.name, biomass: near.radius * near.radius };
    }
    const { nearby } = app;
    if (nearby) mate.check(nearby.id);
    const view = mate.view();
    // Courting starts with a chime, sent or received (one per courtship, not per state change).
    const courtingNow = (state: string) => state === 'courting' || state === 'invited';
    if (courtingNow(view.state) && !courtingNow(app.mateNow)) app.sound.cue('court');
    app.mateNow = view.state;
    const hint = nearby ? mate.hint(nearby) : null;
    const text = view.invite ? '' : (hint?.text ?? view.note);
    if (mateHint.textContent !== text) mateHint.textContent = text;
    const hideHint = !playingNow || text === '';
    if (mateHint.hidden !== hideHint) mateHint.hidden = hideHint;
    const court = String(hint?.court === true);
    if (mateHint.dataset.court !== court) mateHint.dataset.court = court;
    this.updateInspectUi(playingNow, view.invite !== null);
    const { invite } = view;
    const hideInvite = !playingNow || !invite;
    if (invitePanel.hidden !== hideInvite) invitePanel.hidden = hideInvite;
    if (invite) {
      const remote = remoteViews.find((r) => r.id === invite.from);
      setBadge(this.inviteBadge, remote?.body ? rarityOfTraits(remote.body.traits).tier : '');
      const body = [
        remote?.species ?? 'A new creature',
        remote ? `size ${sizeTier(remote.radius * remote.radius)}` : '',
        `generation ${invite.generation}`,
      ].filter(Boolean);
      setIfChanged(this.inviteName, `${invite.name} wants to mate`);
      setIfChanged(this.inviteBody, body.join(' · '));
      setIfChanged(this.inviteBand, invite.band);
      setIfChanged(this.inviteLeft, `${Math.ceil(view.inviteLeftMs / 1000)} s`);
    }
    const life = app.flow.view();
    const active = app.lastClock?.activeMs ?? life.activeMs;
    const ready =
      playingNow && app.lastClock !== null && life.matureAtMs > 0 && active >= life.matureAtMs;
    app.readyShown = ready ? readyText(life.cooldownUntilMs - active) : '';
    const own = ready ? app.ownMateView() : null;
    app.mateReady = own !== null && ownRefusal(own) === null;
    hud.setReady(app.readyShown);
    hud.setMateReady(app.mateReady);
    if (playingNow && player.alive) this.updateGrowth(life.matureAtMs);
  }

  updateHatchNote(): void {
    const { app, hatchNote } = this;
    const status = app.flow.state;
    const waiting = app.life.hatching && (status === 'awaiting' || status === 'verifying');
    const left = app.limitLeft();
    if (app.limitUntil > 0 && left <= 0) app.limitUntil = 0;
    if (left > 0 !== this.shownLimit) {
      this.shownLimit = left > 0;
      app.screens.setLimited(this.shownLimit);
    }
    let text = app.hatchError;
    if (left > 0) text = countdownText(left);
    if (waiting) text = status === 'awaiting' ? 'Awaiting beacon…' : 'Checking your creature…';
    if (text !== this.shownNote) {
      this.shownNote = text;
      hatchNote.textContent = text;
      hatchNote.hidden = text === '';
    }
    if (hatchNote.hasAttribute('data-waiting') !== waiting) {
      hatchNote.toggleAttribute('data-waiting', waiting);
    }
  }
}
