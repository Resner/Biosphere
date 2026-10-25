// Fast non-cryptographic 64-bit hash for state hashes and goldens (ADR 0005). Records that need
// security use SHA-256 elsewhere (ADR 0009).

const view = new DataView(new ArrayBuffer(8));

function fmix(h0: number): number {
  let h = h0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const hex8 = (n: number): string => n.toString(16).padStart(8, '0');

export class Hasher {
  private a = 0x811c9dc5;
  private b = 0x9747b28c;

  private byte(v: number): void {
    this.a = Math.imul(this.a ^ v, 0x01000193);
    this.b = Math.imul(this.b + v + 1, 0x85ebca6b) ^ (this.a >>> 15);
  }

  u32(n: number): this {
    this.byte(0x01);
    for (let shift = 0; shift < 32; shift += 8) this.byte((n >>> shift) & 0xff);
    return this;
  }

  i32(n: number): this {
    this.byte(0x02);
    for (let shift = 0; shift < 32; shift += 8) this.byte((n >> shift) & 0xff);
    return this;
  }

  f64(n: number): this {
    if (!Number.isFinite(n)) throw new RangeError(`cannot hash a non-finite number: ${n}`);
    view.setFloat64(0, n === 0 ? 0 : n); // -0 hashes like 0
    this.byte(0x03);
    for (let i = 0; i < 8; i++) this.byte(view.getUint8(i));
    return this;
  }

  str(s: string): this {
    const bytes = new TextEncoder().encode(s);
    this.byte(0x04);
    return this.raw(bytes);
  }

  bytes(b: Uint8Array): this {
    this.byte(0x05);
    return this.raw(b);
  }

  private raw(b: Uint8Array): this {
    const n = b.length;
    for (let shift = 0; shift < 32; shift += 8) this.byte((n >>> shift) & 0xff);
    for (const v of b) this.byte(v);
    return this;
  }

  /** 16 hex characters from two 32-bit lanes. */
  digest(): string {
    const x = fmix(this.a ^ Math.imul(this.b, 0x27d4eb2f));
    const y = fmix(this.b ^ Math.imul(x, 0x165667b1) ^ this.a);
    return hex8(x) + hex8(y);
  }
}

export function hash64(bytes: Uint8Array): string {
  return new Hasher().bytes(bytes).digest();
}
