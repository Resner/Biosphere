// What the social layer looks like: the chat panel and input, the roster (click a name to mute),
// and the bubbles, emotes and pings drawn over the water. Text only, never markup, because every
// string except the glyphs comes from another player.

import { pick } from './dom';
import type { LabelProjection } from './labels';
import type { Social } from './social';

/** One glyph per emote: wave, happy, love, angry, scared, question. */
export const EMOTE_GLYPHS = ['≋', '☺', '♥', '✖', '!', '?'] as const;
const EMOTE_NAMES = ['wave', 'happy', 'love', 'angry', 'scared', 'question'] as const;
/** One glyph per ping: look, danger, food, mate. */
export const PING_GLYPHS = ['◎', '▲', '◆', '♥'] as const;
const PING_NAMES = ['look', 'danger', 'food', 'mate'] as const;

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

export interface RosterEntry {
  id: string;
  name: string;
}

export class SocialUi {
  private readonly log = pick('[data-testid="chat-log"]');
  private readonly input = pick<HTMLInputElement>('[data-testid="chat-input"]');
  private readonly roster = pick('[data-testid="roster"]');
  private readonly cues = pick('[data-testid="social-cues"]');
  private readonly byId = new Map<string, Cue>();
  private readonly pingEls = new Map<object, HTMLElement>();
  private seenChats = -1;
  private rosterKey = '';

  constructor(
    private readonly social: Social,
    handlers: { submit(text: string): void; typing(on: boolean): void },
  ) {
    this.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.isComposing) return;
      const text = this.input.value;
      this.close();
      handlers.typing(false);
      if (e.key === 'Enter' && text.trim() !== '') handlers.submit(text);
    });
    this.input.addEventListener('blur', () => {
      if (!this.input.hidden) {
        this.close();
        handlers.typing(false);
      }
    });
    this.roster.addEventListener('click', (e) => {
      const button = (e.target as Element).closest<HTMLButtonElement>('button[data-id]');
      if (!button?.dataset.id) return;
      social.toggleMute(button.dataset.id);
      // A focused button would turn the dash key (space) into another click.
      button.blur();
      this.rosterKey = '';
    });
  }

  get typing(): boolean {
    return !this.input.hidden;
  }

  open(): void {
    this.input.value = '';
    this.input.hidden = false;
    this.input.focus();
  }

  close(): void {
    this.input.hidden = true;
    this.input.value = '';
    this.input.blur();
  }

  update(
    now: number,
    anchors: ReadonlyMap<string, Anchor>,
    others: readonly RosterEntry[],
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

  private drawRoster(others: readonly RosterEntry[]): void {
    const muted = this.social.muted;
    const key = others.map((o) => `${o.id}\n${o.name}\n${muted.has(o.id)}`).join('\n\n');
    if (key === this.rosterKey) return;
    this.rosterKey = key;
    this.roster.hidden = others.length === 0;
    this.roster.replaceChildren(
      ...others.map((o) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.id = o.id;
        const isMuted = muted.has(o.id);
        button.dataset.muted = String(isMuted);
        button.title = isMuted ? 'Click to unmute' : 'Click to mute';
        button.textContent = isMuted ? `${o.name} · muted` : o.name;
        item.append(button);
        return item;
      }),
    );
  }

  private drawCues(now: number, anchors: ReadonlyMap<string, Anchor>, p: LabelProjection): void {
    const bubbles = this.social.bubbles();
    const emotes = this.social.emotes();
    const live = new Set<string>();
    for (const id of new Set([...bubbles.keys(), ...emotes.keys()])) {
      const anchor = anchors.get(id);
      if (!anchor) continue;
      live.add(id);
      const cue = this.cueFor(id);
      const x = p.width / 2 + (anchor.x - p.camX) * p.pxPerWu;
      const y = p.height / 2 - (anchor.y - p.camY) * p.pxPerWu - anchor.radius * p.pxPerWu - GAP_PX;
      cue.root.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
      const bubble = bubbles.get(id);
      cue.bubble.hidden = !bubble;
      if (bubble) {
        if (cue.bubble.textContent !== bubble.text) cue.bubble.textContent = bubble.text;
        cue.bubble.style.opacity = fade(bubble.until - now);
      }
      const emote = emotes.get(id);
      cue.emote.hidden = !emote;
      if (emote) {
        cue.emote.dataset.emote = String(emote.id);
        cue.emote.setAttribute('aria-label', EMOTE_NAMES[emote.id] ?? '');
        if (cue.emote.textContent !== EMOTE_GLYPHS[emote.id]) {
          cue.emote.textContent = EMOTE_GLYPHS[emote.id] ?? '';
        }
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
    for (const [ping, element] of this.pingEls) {
      if (pings.includes(ping as (typeof pings)[number])) continue;
      element.remove();
      this.pingEls.delete(ping);
    }
    for (const ping of pings) {
      let element = this.pingEls.get(ping);
      if (!element) {
        element = document.createElement('div');
        element.className = 'ping';
        element.dataset.kind = String(ping.kind);
        element.setAttribute('aria-label', PING_NAMES[ping.kind] ?? '');
        element.textContent = PING_GLYPHS[ping.kind] ?? '';
        this.cues.append(element);
        this.pingEls.set(ping, element);
      }
      const x = p.width / 2 + (ping.x - p.camX) * p.pxPerWu;
      const y = p.height / 2 - (ping.y - p.camY) * p.pxPerWu;
      element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`;
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
