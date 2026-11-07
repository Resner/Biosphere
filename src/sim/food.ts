import { depthAt, zoneOfDepth } from './bathymetry';
import {
  applyRemoteCarrionClaim,
  carrionAlive,
  carrionClaimOf,
  carrionEfficiency,
  consumeCarrion,
  isCarrionId,
} from './carrion';
import { ventNear } from './hazards';
import { clamp, cos, length, lerp3, sin, TAU } from './math';
import { hashU32, type Seed } from './prng';
import { RULES } from './rules';
import { sizeTier } from './size';
import type { CreatureState, FoodItem, FoodKind, StepEvent, Vec2, World } from './types';
import { maxEnergy } from './vitals';

// Independent hash streams per property of a slot's cycle, so adding one never shifts another.
const SALT = { kind: 1, x: 2, y: 3, delay: 4, bobX: 5, bobY: 6 } as const;
const KINDS = Object.keys(RULES.food.kinds) as FoodKind[];
const MAX_ITEM_RADIUS = Math.max(...KINDS.map((kind) => RULES.food.kinds[kind].radius));
/** `t<layer>` for a layer of tier 1 to `layers.max`; layer 0 has no prefix, so its ids are as they were. */
const ID_PATTERN = /^(?:t([1-9]))?c(\d+)_(\d+)_s(\d+)_k(\d+)$/;

const LAYERS = RULES.food.layers;
const LAYER_COUNT = LAYERS.max + 1;
/** Per layer: its cell width in wu, its item width and richness factors (integer powers, built by products). */
const CELL_OF: number[] = [];
const WIDTH_OF: number[] = [];
const RICH_OF: number[] = [];
const SLOTS_OF: number[] = [];
for (let l = 0, cell = RULES.world.cellSize, width = 1, rich = 1; l < LAYER_COUNT; l++) {
  CELL_OF.push(cell);
  WIDTH_OF.push(width);
  RICH_OF.push(rich);
  SLOTS_OF.push(l === 0 ? RULES.food.slotsPerCell : LAYERS.slotsPerCell);
  cell *= LAYERS.cellStep;
  width *= LAYERS.widthStep;
  rich *= LAYERS.richnessStep;
}
const MAX_SLOTS = Math.max(...SLOTS_OF);

const cellsPerSide = (world: World, layer: number): number =>
  Math.floor(world.size / (CELL_OF[layer] as number));

/** Each layer hashes with its own salts, so layers never share a draw; layer 0's are the originals. */
function slotHash(
  world: World,
  layer: number,
  cx: number,
  cy: number,
  slot: number,
  k: number,
  salt: number,
) {
  return hashU32(...world.seed32, cx, cy, slot, k, salt + layer * 8) >>> 0;
}

const unit = (hash: number): number => hash / 4294967296;
const layerPrefix = (layer: number): string => (layer === 0 ? '' : `t${layer}`);
const slotKey = (layer: number, cx: number, cy: number, slot: number): string =>
  `${layerPrefix(layer)}c${cx}_${cy}_s${slot}`;

/** Where cycle k of a slot of `layer` is anchored: inside its cell, kept clear of the world edge. */
export function slotAnchor(
  world: World,
  cx: number,
  cy: number,
  slot: number,
  k: number,
  layer = 0,
): Vec2 {
  const cell = CELL_OF[layer] as number;
  const margin = RULES.food.driftRadius * (WIDTH_OF[layer] as number);
  const place = (cell0: number, salt: number): number => {
    const p = cell0 * cell + unit(slotHash(world, layer, cx, cy, slot, k, salt)) * cell;
    return clamp(p, margin, world.size - margin);
  };
  return { x: place(cx, SALT.x), y: place(cy, SALT.y) };
}

/** Position along one axis of the bobbing drift: a sine with a hash-chosen period and phase. */
function bob(
  world: World,
  layer: number,
  cx: number,
  cy: number,
  slot: number,
  k: number,
  salt: number,
) {
  const f = RULES.food;
  const h = slotHash(world, layer, cx, cy, slot, k, salt);
  const span = f.bobPeriodMaxTicks - f.bobPeriodMinTicks + 1;
  const period = f.bobPeriodMinTicks + (h % span);
  const phase = unit(hashU32(h, salt)) * TAU;
  const amplitude = f.driftRadius * (WIDTH_OF[layer] as number) * f.bobFraction;
  return amplitude * sin(phase + ((world.tick % period) / period) * TAU);
}

/** The kind weights at a slot anchor: by the zone there, and richer in crystals near a vent. */
function weightsAt(world: World, anchor: Vec2): Record<FoodKind, number> {
  const zone = zoneOfDepth(depthAt(world.seed32, anchor.x, anchor.y, world.size));
  if (
    (zone === 'deep' || zone === 'abyss') &&
    ventNear(world, anchor.x, anchor.y, RULES.food.ventRange)
  ) {
    return RULES.food.nearVentWeights[zone];
  }
  return RULES.food.zoneWeights[zone];
}

/**
 * The kind of cycle `k` of a slot: a pure function of the seed, remembered because zones cost a
 * field sample. The memo holds chunks of 16 × 16 cells, at most 256, the least recently used
 * dropped first, so a creature crossing a world of a million cells leaves a bounded memory behind;
 * a dropped chunk is recomputed to the same kinds.
 */
interface KindChunk {
  k: Int32Array;
  kind: Uint8Array;
}
interface KindMemo {
  size: number;
  /** Chunk key to chunk, least recently used first (a Map iterates in insertion order). */
  chunks: Map<number, KindChunk>;
  lastKey: number;
  last: KindChunk | null;
}
const CHUNK_CELLS = 16;
const MAX_CHUNKS = 256;
/** One memo per layer, so a layer's chunks never push another's out. */
const kindMemos = new WeakMap<Seed, (KindMemo | undefined)[]>();

/** How many chunks of the kind memo this world's seed holds, over every layer (a test hook). */
export function foodMemoChunks(world: World): number {
  let total = 0;
  for (const memo of kindMemos.get(world.seed32) ?? []) total += memo?.chunks.size ?? 0;
  return total;
}

function chunkOf(world: World, layer: number, cx: number, cy: number): KindChunk {
  let memos = kindMemos.get(world.seed32);
  if (memos === undefined) {
    memos = [];
    kindMemos.set(world.seed32, memos);
  }
  let memo = memos[layer];
  if (memo === undefined || memo.size !== world.size) {
    memo = { size: world.size, chunks: new Map(), lastKey: -1, last: null };
    memos[layer] = memo;
  }
  const key = (cy >> 4) * 65536 + (cx >> 4);
  if (memo.last !== null && memo.lastKey === key) return memo.last;
  let chunk = memo.chunks.get(key);
  if (chunk === undefined) {
    const slots = CHUNK_CELLS * CHUNK_CELLS * (SLOTS_OF[layer] as number);
    chunk = { k: new Int32Array(slots).fill(-1), kind: new Uint8Array(slots) };
    if (memo.chunks.size >= MAX_CHUNKS) {
      memo.chunks.delete(memo.chunks.keys().next().value as number);
    }
  } else {
    memo.chunks.delete(key);
  }
  memo.chunks.set(key, chunk);
  memo.lastKey = key;
  memo.last = chunk;
  return chunk;
}

function kindOf(
  world: World,
  layer: number,
  cx: number,
  cy: number,
  slot: number,
  k: number,
  anchor: Vec2,
) {
  const memo = chunkOf(world, layer, cx, cy);
  const at = ((cy & 15) * CHUNK_CELLS + (cx & 15)) * (SLOTS_OF[layer] as number) + slot;
  if (memo.k[at] === k) return KINDS[memo.kind[at] as number] as FoodKind;
  const weights = weightsAt(world, anchor);
  let total = 0;
  for (const kind of KINDS) total += weights[kind];
  let roll = slotHash(world, layer, cx, cy, slot, k, SALT.kind) % total;
  let index = KINDS.length - 1;
  for (let i = 0; i < KINDS.length; i++) {
    roll -= weights[KINDS[i] as FoodKind];
    if (roll < 0) {
      index = i;
      break;
    }
  }
  memo.k[at] = k;
  memo.kind[at] = index;
  return KINDS[index] as FoodKind;
}

function itemFor(
  world: World,
  layer: number,
  cx: number,
  cy: number,
  slot: number,
  eaten: { k: number; until: number } | undefined,
): FoodItem {
  const k = eaten?.k ?? 0;
  const anchor = slotAnchor(world, cx, cy, slot, k, layer);
  const kind = kindOf(world, layer, cx, cy, slot, k, anchor);
  const spec = RULES.food.kinds[kind];
  return {
    id: `${slotKey(layer, cx, cy, slot)}_k${k}`,
    kind,
    x: anchor.x + bob(world, layer, cx, cy, slot, k, SALT.bobX),
    y: anchor.y + bob(world, layer, cx, cy, slot, k, SALT.bobY),
    value: spec.value * (RICH_OF[layer] as number),
    radius: spec.radius * (WIDTH_OF[layer] as number),
    respawnTick: eaten?.until ?? 0,
  };
}

/**
 * The food of `layer` (0 unless given) alive in one grid cell at `world.tick`, in slot order. A slot shows cycle 0 until it is
 * eaten; then it is empty until its respawn tick and shows the next cycle. `respawnTick` is the
 * tick the item appeared.
 */
export function foodInCell(world: World, cx: number, cy: number, layer = 0): FoodItem[] {
  const n = cellsPerSide(world, layer);
  if (cx < 0 || cy < 0 || cx >= n || cy >= n) return [];
  const items: FoodItem[] = [];
  const slots = SLOTS_OF[layer] as number;
  for (let slot = 0; slot < slots; slot++) {
    const eaten = world.consumed[slotKey(layer, cx, cy, slot)];
    if (eaten === undefined || world.tick >= eaten.until) {
      items.push(itemFor(world, layer, cx, cy, slot, eaten));
    }
  }
  return items;
}

/** How many times as wide as layer 0's an item of `layer` is (1 for layer 0). */
export const foodLayerWidth = (layer: number): number => WIDTH_OF[layer] as number;

/** The layers a creature of size tier `tier` eats: t - 1 and t (layer 0 alone for tier 0). */
export const eatenLayers = (tier: number): [number, number] => {
  const top = Math.min(tier, LAYERS.max);
  return [Math.max(0, top - 1), top];
};

/** Food of `layer` within `radius` of a point, ordered by cell then slot (a stable order). */
export function foodNear(
  world: World,
  x: number,
  y: number,
  radius: number,
  layer = 0,
): FoodItem[] {
  const cell = CELL_OF[layer] as number;
  const reach = radius + RULES.food.driftRadius * (WIDTH_OF[layer] as number);
  const n = cellsPerSide(world, layer);
  const x0 = Math.max(0, Math.floor((x - reach) / cell));
  const x1 = Math.min(n - 1, Math.floor((x + reach) / cell));
  const y0 = Math.max(0, Math.floor((y - reach) / cell));
  const y1 = Math.min(n - 1, Math.floor((y + reach) / cell));
  const found: FoodItem[] = [];
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      for (const item of foodInCell(world, cx, cy, layer)) {
        const dx = item.x - x;
        const dy = item.y - y;
        if (dx * dx + dy * dy <= radius * radius) found.push(item);
      }
    }
  }
  return found;
}

/** The food a creature of size tier `tier` can eat within `radius` of a point: layer t - 1, then layer t. */
export function foodForTier(
  world: World,
  x: number,
  y: number,
  radius: number,
  tier: number,
): FoodItem[] {
  const [low, high] = eatenLayers(tier);
  const items = foodNear(world, x, y, radius, low);
  return high === low ? items : items.concat(foodNear(world, x, y, radius, high));
}

/** Splits an item id (`c3_5_s2_k0`, a layer item's `t1c3_5_s2_k0` or a carrion piece's `x1a2b3c4d_3`) into its claim slot and cycle, or null if it is not one. */
export function parseFoodId(id: string): { slot: string; k: number } | null {
  const carrion = carrionClaimOf(id);
  if (carrion) return carrion;
  const m = ID_PATTERN.exec(id);
  const layer = Number(m?.[1] ?? 0);
  if (!m || layer > LAYERS.max) return null;
  return { slot: slotKey(layer, Number(m[2]), Number(m[3]), Number(m[4])), k: Number(m[5]) };
}

const SLOT_PATTERN = /^(?:t([1-9]))?c(\d+)_(\d+)_s(\d+)$/;

/** Whether `slot` (`c3_5_s2`, or a layer's `t1c3_5_s2`) names a food slot of this world. */
export function isFoodSlot(world: World, slot: string): boolean {
  return parseSlot(world, slot) !== null;
}

/** A slot's layer, cell and slot number, or null for a name that is not one in this world's grid. */
function parseSlot(world: World, slot: string): [number, number, number, number] | null {
  const m = SLOT_PATTERN.exec(slot);
  if (!m) return null;
  const layer = Number(m[1] ?? 0);
  const [cx, cy, s] = [Number(m[2]), Number(m[3]), Number(m[4])] as const;
  if (layer > LAYERS.max) return null;
  const n = cellsPerSide(world, layer);
  const valid =
    slotKey(layer, cx, cy, s) === slot && cx < n && cy < n && s < (SLOTS_OF[layer] as number);
  return valid ? [layer, cx, cy, s] : null;
}

/** Ticks a slot stays empty after cycle `k` is eaten (20-60 s, chosen by hash). */
function respawnDelay(
  world: World,
  layer: number,
  cx: number,
  cy: number,
  slot: number,
  k: number,
): number {
  const f = RULES.food;
  const span = f.respawnMaxTicks - f.respawnMinTicks + 1;
  return f.respawnMinTicks + (slotHash(world, layer, cx, cy, slot, k, SALT.delay) % span);
}

/** Marks a live item as eaten; its slot is empty until a hash-chosen 20-60 s have passed. */
export function consumeFood(world: World, id: string): void {
  const m = ID_PATTERN.exec(id);
  if (!m) throw new Error(`bad food id ${id}`);
  const claim = parseFoodId(id);
  const parsed = claim ? parseSlot(world, claim.slot) : null;
  if (!claim || !parsed || `${claim.slot}_k${claim.k}` !== id) {
    throw new Error(`food ${id} is not alive`);
  }
  const [layer, cx, cy, slot] = parsed;
  const eaten = world.consumed[claim.slot];
  const alive = claim.k === (eaten?.k ?? 0) && world.tick >= (eaten?.until ?? 0);
  if (!alive) throw new Error(`food ${id} is not alive`);
  const delay = respawnDelay(world, layer, cx, cy, slot, claim.k);
  world.consumed[claim.slot] = { k: claim.k + 1, until: world.tick + delay };
}

/**
 * Whether cycle `k` of a slot can have been eaten at `tick` on this world's clock: `tick` lies
 * within `claimTickWindow` of the local tick, and a slot needs at least `respawnMinTicks` per
 * cycle, so cycle `k` is never eaten before tick `k × respawnMinTicks` (less the same window).
 */
export function claimPlausible(world: World, k: number, tick: number): boolean {
  const slack = RULES.food.claimTickWindow;
  return (
    Number.isInteger(k) &&
    Number.isInteger(tick) &&
    k >= 0 &&
    Math.abs(tick - world.tick) <= slack &&
    k * RULES.food.respawnMinTicks <= tick + slack
  );
}

/** Whether a `consumed` entry (next cycle `k`, respawn at `until`) fits this world's clock. */
export function consumedPlausible(world: World, k: number, until: number): boolean {
  const slack = RULES.food.claimTickWindow;
  return (
    Number.isInteger(k) &&
    Number.isInteger(until) &&
    k >= 0 &&
    until >= 0 &&
    until <= world.tick + slack + RULES.food.respawnMaxTicks &&
    (k - 1) * RULES.food.respawnMinTicks <= world.tick + slack
  );
}

/**
 * Applies another player's claim: cycle `k` of `slot` was eaten at `tick`. The slot moves to
 * cycle `k + 1` and respawns exactly when it would have for that eater (ADR 0016), whatever this
 * world's own tick is. Returns false, changing nothing, for a slot outside the grid, a claim outside
 * the window of `claimPlausible`, or a cycle the slot is already past.
 */
export function applyRemoteClaim(
  world: World,
  claim: { slot: string; k: number; tick: number },
): boolean {
  if (!claimPlausible(world, claim.k, claim.tick)) return false;
  if (isCarrionId(claim.slot)) return applyRemoteCarrionClaim(world, claim);
  const parsed = parseSlot(world, claim.slot);
  if (!parsed) return false;
  const [layer, cx, cy, slot] = parsed;
  // Cycle k - 1 of the slot is the one eaten now; a re-claim of it replaces who ate it.
  if (claim.k + 1 < (world.consumed[claim.slot]?.k ?? 0)) return false;
  const delay = respawnDelay(world, layer, cx, cy, slot, claim.k);
  world.consumed[claim.slot] = { k: claim.k + 1, until: claim.tick + delay };
  return true;
}

/** How much of a food kind's value a mouth of `type` (0 filter to 1 jaw) takes in, 0 to 1. */
export function efficiency(kind: FoodKind, type: number): number {
  const { filter, middle, jaw } = RULES.feeding.efficiency[kind];
  return lerp3(filter, middle, jaw, type);
}

/** The mouth being tested, reused by every `applyFeeding` call so a tick allocates nothing (calls never nest). */
const mouthAt = { x: 0, y: 0, radius: 0, cx: 0, cy: 0, hx: 0, hy: 0, cosArc: 0 };

/** Whether an item of `itemRadius` at (x, y) overlaps `mouthAt`'s disc and lies inside its arc. */
function reaches(x: number, y: number, itemRadius: number): boolean {
  const m = mouthAt;
  const reach = m.radius + itemRadius;
  const dx = x - m.x;
  const dy = y - m.y;
  if (dx * dx + dy * dy >= reach * reach) return false;
  const ax = x - m.cx;
  const ay = y - m.cy;
  const away = length(ax, ay);
  return away === 0 || ax * m.hx + ay * m.hy >= away * m.cosArc;
}

/**
 * Eats every item the creature's mouth reaches, unless its energy is already at the cap: then the
 * item stays for someone hungrier. The mouth disc sits `offset` radii ahead of the centre; an item
 * is reached when it overlaps the disc and lies within `arc` of the heading, seen from the centre.
 * An item the mouth cannot digest (efficiency 0) is never eaten. The yield is
 * `value × efficiency × digestion`. A creature of tier t eats layers t - 1 and t (layer 0 only,
 * for tier 0), the lower layer first, each in cell and slot order (ADR 0061).
 */
export function applyFeeding(world: World, creature: CreatureState): StepEvent[] {
  if (!creature.alive) return [];
  const energyCap = maxEnergy(creature.biomass);
  if (creature.energy >= energyCap) return [];
  const radius = Math.sqrt(creature.biomass);
  const { mouth } = creature.phys;
  const hx = cos(creature.heading);
  const hy = sin(creature.heading);
  const mx = creature.x + hx * mouth.offset * radius;
  const my = creature.y + hy * mouth.offset * radius;
  const mouthRadius = mouth.radius * radius;
  const cosArc = cos(mouth.arc);
  const m = mouthAt;
  m.x = mx;
  m.y = my;
  m.radius = mouthRadius;
  m.cx = creature.x;
  m.cy = creature.y;
  m.hx = hx;
  m.hy = hy;
  m.cosArc = cosArc;
  const events: StepEvent[] = [];
  const [lowLayer, highLayer] = eatenLayers(sizeTier(creature.biomass));
  for (let layer = lowLayer; layer <= highLayer; layer++) {
    const reach = mouthRadius + MAX_ITEM_RADIUS * (WIDTH_OF[layer] as number);
    for (const item of foodNear(world, mx, my, reach, layer)) {
      if (!reaches(item.x, item.y, item.radius)) continue;
      const yielded = item.value * efficiency(item.kind, mouth.type) * mouth.digestion;
      if (yielded <= 0) continue;
      if (creature.energy >= energyCap) break;
      consumeFood(world, item.id);
      creature.energy = Math.min(creature.energy + yielded, energyCap);
      events.push({ type: 'eat', creature: creature.id, food: item.id, value: yielded });
    }
  }
  // Carrion is eaten like food, in id order after it, at its own efficiency.
  for (const piece of world.carrion) {
    if (!reaches(piece.x, piece.y, piece.radius) || !carrionAlive(world, piece)) continue;
    const yielded = piece.value * carrionEfficiency(mouth.type) * mouth.digestion;
    if (yielded <= 0) continue;
    if (creature.energy >= energyCap) break;
    consumeCarrion(world, piece.id);
    creature.energy = Math.min(creature.energy + yielded, energyCap);
    events.push({ type: 'eat', creature: creature.id, food: piece.id, value: yielded });
  }
  return events;
}
