// Polyphony for event sounds (M6 T22): at most 4 voices per cue and 16 in all. A cue past its cap
// steals its own oldest voice; past the total it steals the oldest voice of any cue. Pure
// bookkeeping on the audio clock (seconds), so it runs in Node.

export const POLYPHONY = { perCue: 4, total: 16 } as const;

interface Held {
  id: number;
  key: string;
  end: number;
}

export class VoicePool {
  private readonly voices: Held[] = [];
  private nextId = 1;

  /** Takes a voice for `key` from `now` to `end`; `stolen` lists the voices to cut short. */
  acquire(key: string, now: number, end: number): { id: number; stolen: number[] } {
    this.expire(now);
    const stolen: number[] = [];
    const own = this.voices.filter((v) => v.key === key);
    if (own.length >= POLYPHONY.perCue) stolen.push(this.drop(own[0] as Held));
    else if (this.voices.length >= POLYPHONY.total) stolen.push(this.drop(this.voices[0] as Held));
    const id = this.nextId++;
    this.voices.push({ id, key, end });
    return { id, stolen };
  }

  release(id: number): void {
    const i = this.voices.findIndex((v) => v.id === id);
    if (i >= 0) this.voices.splice(i, 1);
  }

  /** Voices still sounding at `now`, of one cue or all. */
  active(key: string | undefined, now: number): number {
    this.expire(now);
    return key === undefined ? this.voices.length : this.voices.filter((v) => v.key === key).length;
  }

  private drop(v: Held): number {
    this.release(v.id);
    return v.id;
  }

  private expire(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--)
      if ((this.voices[i] as Held).end <= now) this.voices.splice(i, 1);
  }
}
