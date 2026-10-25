// What the social layer looks like: the chat panel and input, the roster (click a name to mute),
// and the bubbles, emotes and pings drawn over the water. Text only, never markup, because every
// string except the glyphs comes from another player.

import type { Member } from '../net/protocol';
import { pick } from './dom';
import { type LabelProjection, placeAt, screenX, screenY } from './labels';
import type { PingCue, Social } from './social';

/** Wave, happy, love, angry, scared, question; indexed by the emote id. */
const EMOTES = [
  { glyph: '≋', name: 'wave' },
  { glyph: '☺', name: 'happy' },
  { glyph: '♥', name: 'love' },
  { glyph: '✖', name: 'angry' },
  { glyph: '!', name: 'scared' },
  { glyph: '?', name: 'question' },
] as const;
/** Look, danger, food, mate; indexed by the ping kind. */
const PINGS = [
  { glyph: '◎', name: 'look' },
  { glyph: '▲', name: 'danger' },
  { glyph: '◆', name: 'food' },
  { glyph: '♥', name: 'mate' },
] as const;

/** Gap between a cell's edge and the cues above it: room for the name label. */
const GAP_PX = 30;
const FADE_MS = 400;

export interface Anchor {
  x: number;
  y: number;
  /** World units. */
  radius: number;
}

interface Cue {
  root: HTMLElement;
  emote: HTMLElement;
  bubble: HTMLElement;
}

interface ShownMember {
  id: string;
  name: string;
  muted: boolean;
}

export class SocialUi {
  private readonly log = pick('[data-testid="chat-log"]');
  private readonly input = pick<HTMLInputElement>('[data-testid="chat-input"]');
  private readonly roster = pick('[data-testid="roster"]');
  private readonly cues = pick('[data-testid="social-cues"]');
  private readonly byId = new Map<string, Cue>();
  private readonly pingEls = new Map<PingCue, HTMLElement>();
  private readonly live = new Set<string>();
  private seenChats = -1;
  private shown: ShownMember[] = [];

  constructor(
    private readonly social: Social,
    private readonly handlers: { submit(text: string): boolean; typing(on: boolean): void },
  ) {
    this.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.isComposing) return;
      const text = this.input.value;
      this.close();
      // A refused message (rate limit) stays in the input so the player can send it again.
      if (e.key === 'Enter' && text.trim() !== '' && !this.handlers.submit(text)) {
        this.open();
        this.input.value = text;
      }
    });
    this.input.addEventListener('blur', () => {
      if (!this.input.hidden) this.close();
    });
    this.roster.addEventListener('click', (e) => {
      const button = (e.target as Element).closest<HTMLButtonElement>('button[data-id]');
      if (!button?.dataset.id) return;
      social.toggleMute(button.dataset.id);
      // A focused button would turn the dash key (space) into another click.
      button.blur();
      this.shown = [];
    });
  }

  open(): void {
    this.handlers.typing(true);
    this.input.value = '';
    this.input.hidden = false;
    this.input.focus();
  }

  close(): void {
    this.input.hidden = true;
    this.input.value = '';
    this.input.blur();
    this.handlers.typing(false);
  }

  update(
    now: number,
    anchors: ReadonlyMap<string, Anchor>,
    others: readonly Member[],
    p: LabelProjection,
  ): void {
    this.drawLog();
    this.drawRoster(others);
    this.drawCues(now, anchors, p);
    this.drawPings(now, p);
  }

  private drawLog(): void {
    if (this.social.chats === this.seenChats) return;
    this.seenChats = this.social.chats;
    this.log.replaceChildren(
      ...this.social.log().map((line) => {
        const item = document.createElement('li');
        const who = document.createElement('b');
        who.textContent = line.name;
        item.append(who, ` ${line.text}`);
        return item;
      }),
    );
    this.log.scrollTop = this.log.scrollHeight;
  }

  private drawRoster(others: readonly Member[]): void {
    const { muted } = this.social;
    const same =
      others.length === this.shown.length &&
      others.every((o, i) => {
        const was = this.shown[i] as ShownMember;
        return was.id === o.playerId && was.name === o.name && was.muted === muted.has(o.playerId);
      });
    if (same) return;
    this.shown = others.map((o) => ({
      id: o.playerId,
      name: o.name,
      muted: muted.has(o.playerId),
    }));
    this.roster.hidden = others.length === 0;
    this.roster.replaceChildren(
      ...this.shown.map((o) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.id = o.id;
        button.dataset.muted = String(o.muted);
        button.title = o.muted ? 'Click to unmute' : 'Click to mute';
        button.textContent = o.muted ? `${o.name} · muted` : o.name;
        item.append(button);
        return item;
      }),
    );
  }

  private drawCues(now: number, anchors: ReadonlyMap<string, Anchor>, p: LabelProjection): void {
    const bubbles = this.social.bubbles();
    const emotes = this.social.emotes();
    if (bubbles.size === 0 && emotes.size === 0 && this.byId.size === 0) return;
    const { live } = this;
    live.clear();
    for (const id of [...bubbles.keys(), ...emotes.keys()]) {
      const anchor = anchors.get(id);
      if (!anchor || live.has(id)) continue;
      live.add(id);
      const cue = this.cueFor(id);
      const x = screenX(anchor.x, p);
      const y = screenY(anchor.y, p) - anchor.radius * p.pxPerWu - GAP_PX;
      cue.root.style.transform = placeAt(x, y, 'above');
      const bubble = bubbles.get(id);
      cue.bubble.hidden = !bubble;
      if (bubble) {
        cue.bubble.textContent = bubble.text;
        cue.bubble.style.opacity = fade(bubble.until - now);
      }
      const emote = emotes.get(id);
      cue.emote.hidden = !emote;
      if (emote) {
        const { glyph, name } = EMOTES[emote.id] as (typeof EMOTES)[number];
        cue.emote.dataset.emote = String(emote.id);
        cue.emote.textContent = glyph;
        cue.emote.setAttribute('aria-label', name);
        cue.emote.style.opacity = fade(emote.until - now);
      }
    }
    for (const [id, cue] of this.byId) {
      if (live.has(id)) continue;
      cue.root.remove();
      this.byId.delete(id);
    }
  }

  private drawPings(now: number, p: LabelProjection): void {
    const pings = this.social.pings();
    if (pings.length === 0 && this.pingEls.size === 0) return;
    const current = new Set(pings);
    for (const [ping, element] of this.pingEls) {
      if (current.has(ping)) continue;
      element.remove();
      this.pingEls.delete(ping);
    }
    for (const ping of pings) {
      let element = this.pingEls.get(ping);
      if (!element) {
        const { glyph, name } = PINGS[ping.kind] as (typeof PINGS)[number];
        element = document.createElement('div');
        element.className = 'ping';
        element.dataset.kind = String(ping.kind);
        element.setAttribute('aria-label', name);
        element.textContent = glyph;
        this.cues.append(element);
        this.pingEls.set(ping, element);
      }
      element.style.transform = placeAt(screenX(ping.x, p), screenY(ping.y, p), 'centre');
      element.style.opacity = fade(ping.until - now);
    }
  }

  private cueFor(id: string): Cue {
    let cue = this.byId.get(id);
    if (!cue) {
      const root = document.createElement('div');
      root.className = 'cue';
      const emote = document.createElement('span');
      emote.className = 'emote';
      const bubble = document.createElement('span');
      bubble.className = 'bubble';
      root.append(bubble, emote);
      this.cues.append(root);
      cue = { root, emote, bubble };
      this.byId.set(id, cue);
    }
    return cue;
  }
}

/** Full opacity, then a short fade as the cue's last moments run out. */
function fade(remainingMs: number): string {
  return String(Math.round(Math.max(0, Math.min(1, remainingMs / FADE_MS)) * 100) / 100);
}
