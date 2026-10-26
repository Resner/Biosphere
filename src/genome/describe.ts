// Plain-words description of a creature (M3 T9) for the Lab inspector and the HUD. This and
// `names.ts` are the only places where user-facing genetics wording lives: it says what a body
// does and looks like, never how it is encoded.

import type { Appendage } from './develop';
import { type Rarity, rarityOfTraits } from './rarity';
import type { Creature } from './stats';

const article = (word: string): string => (/^[aeiou]/.test(word) ? 'An' : 'A');
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function sizeWord(maxBiomass: number): string {
  if (maxBiomass < 500) return 'tiny';
  if (maxBiomass < 1024) return 'small';
  if (maxBiomass < 16_384) return 'medium';
  if (maxBiomass < 262_144) return 'large';
  return 'giant';
}

const TIPS = ['blunt tip', 'pointed spike', 'hook', 'paddle', 'whip'] as const;

function appendageWords(appendages: readonly Appendage[]): string {
  const counts = new Map<string, number>();
  for (const a of appendages) {
    const kind = TIPS[Math.round(a.tip * 4)] ?? 'blunt tip';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const parts = [...counts].map(([kind, n]) => plural(n, kind));
  return parts.length > 1
    ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
    : (parts[0] ?? '');
}

function hueWord(hue: number, saturation: number, value: number): string {
  const wheel: readonly (readonly [number, string])[] = [
    [0.04, 'red'],
    [0.1, 'orange'],
    [0.18, 'yellow'],
    [0.42, 'green'],
    [0.52, 'teal'],
    [0.7, 'blue'],
    [0.83, 'purple'],
    [0.96, 'pink'],
  ];
  const name = wheel.find(([upTo]) => hue < upTo)?.[1] ?? 'red';
  const shade = value < 0.55 ? 'dark ' : value > 0.85 && saturation < 0.6 ? 'light ' : '';
  return `${shade}${name}`;
}

const FEATURE_WORDS: Readonly<Record<string, string>> = {
  iridescent: 'an iridescent sheen',
  albino: 'albino colouring',
  stripes: 'its stripes',
  spots: 'its spots',
  rings: 'its rings',
  luminescent: 'its glow',
  segments: 'its extra body segments',
  modules: 'its extra limbs',
  novel: 'an unusual trait',
  size: 'its great size',
};

function rarityLine(r: Rarity): string {
  if (r.features.length === 0) return `Rarity: ${r.tier}, with nothing that stands out.`;
  const words = r.features.map((f) => FEATURE_WORDS[f] ?? f);
  const list =
    words.length === 1
      ? (words[0] as string)
      : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return `Rarity: ${r.tier}, thanks to ${list}.`;
}

/** Six sentences: body, movement, feeding, defence, looks and rarity. */
export function describeCreature(c: Creature): string[] {
  const { traits, plan, stats } = c;
  const segments = plan.segments.length;
  const shape = traits.body.aspect < 1.1 ? 'round' : traits.body.aspect < 1.7 ? 'oval' : 'long';
  const limbs = plan.appendages.length;
  const body =
    `${article(shape)} ${shape}${segments === 1 ? ', single-celled body' : ` body of ${segments} linked segments`}` +
    ` that grows to a ${sizeWord(stats.maxBiomass)} size` +
    (limbs > 0 ? `, with ${appendageWords(plan.appendages)}.` : ', with no limbs.');

  const pace = stats.thrust / stats.drag;
  const speed = pace >= 1.3 ? 'quickly' : pace <= 0.75 ? 'slowly' : 'at a steady pace';
  const turn =
    stats.turn >= 1.3 ? 'turns sharply' : stats.turn <= 0.75 ? 'turns slowly' : 'turns easily';
  const movement = `It swims ${speed} and ${turn}.`;

  const m = traits.mouth;
  const diet =
    m.type < 0.33
      ? 'It filters drifting detritus out of the water'
      : m.type > 0.67
        ? 'It bites crystals with its jaws'
        : 'It eats a little of everything';
  const digest =
    m.digestion >= 1.1
      ? ' and digests it well'
      : m.digestion <= 0.8
        ? ' but wastes some of it'
        : '';
  const feeding = `${diet}${digest}.`;

  const armour = stats.combat.armour;
  const guard =
    armour > 0.5
      ? 'Heavy plates cover its body'
      : armour > 0.15
        ? 'Thin plates cover part of its body'
        : stats.integrity < 0.3
          ? 'Its skin is weak and tears easily'
          : 'Its soft skin offers little protection';
  const spiky = stats.combat.spines > 0.3 ? ', and spines bristle outwards' : '';
  const defence = `${guard}${spiky}.`;

  const colour = hueWord(traits.colour.hue, traits.colour.saturation, traits.colour.value);
  const pattern = traits.colour.pattern.filter((p) => p !== 'none');
  const looks: string[] = [
    traits.colour.albino === 'normal' ? `${colour} colouring` : 'pale, colourless skin',
  ];
  if (pattern.length > 0) looks.push(`${pattern.join(' and ')} markings`);
  if (traits.skin.iridescence !== 'plain') looks.push('a rainbow sheen');
  if (traits.colour.luminescence !== 'off') looks.push('a faint glow');
  if (traits.skin.translucency > 0.7) looks.push('see-through skin');
  const lookLine = `It has ${looks.join(', ')}.`;

  return [body, movement, feeding, defence, lookLine, rarityLine(rarityOfTraits(traits))];
}
