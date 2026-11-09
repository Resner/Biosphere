// What the help panel says (M14 T8), in its order: plain words, short lines, and no number that
// `docs/DESIGN.md` doesn't hold (a unit test checks). Controls draws `CONTROLS` instead of lines.

export type HelpSectionId =
  | 'play'
  | 'survive'
  | 'grow'
  | 'fight'
  | 'lineage'
  | 'controls'
  | 'privacy';

export interface HelpSection {
  id: HelpSectionId;
  title: string;
  lines: readonly string[];
  /** A link after the lines. */
  link?: { text: string; href: string };
}

export const VERIFY_HREF = 'https://github.com/Resner/Biosphere/blob/main/docs/VERIFY.md';

export const HELP_SECTIONS: readonly HelpSection[] = [
  {
    id: 'play',
    title: 'How to play',
    lines: [
      'Swim into the glowing specks to eat, and keep clear of what hurts you.',
      'Eat to grow. Once grown up, your creature can mate.',
      'Find another player and court them: you each get a child.',
      'Become your child when you are ready, and your lineage carries on.',
    ],
  },
  {
    id: 'survive',
    title: 'Survive',
    lines: [
      'Specks are everywhere. Bigger globules float in the shallows and the twilight.',
      'Crystals lie in the deep and the abyss, richest near the vents.',
      'Each mouth eats some foods better than others, and leaves what it can’t eat.',
      'Swimming and dashing burn energy. At zero you starve and lose health.',
      'Toxic clouds drift up from vents in the deep: they hurt fast, so steer clear.',
      'Sunlight burns in the shallows and pressure crushes in the abyss, unless your body is built for it.',
      'The four bars, bottom left: health, energy, size toward adult and life left.',
      'Health never comes back by itself; growing raises it.',
    ],
  },
  {
    id: 'grow',
    title: 'Grow and mate',
    lines: [
      'You grow while your energy is high. The size bar’s tick is the size to mate.',
      'You are mature after some minutes of play at 60% of adult size; the menu says when.',
      'Near another mature player of a similar size, press E to court. They have 15 s to accept with E.',
      'You both need half your energy or more. Mating costs each of you 30% of energy and 15% of biomass.',
      'After a mating you wait 9 min of play; the same pair waits longer each time.',
      'Your child is an egg that follows you. Press H to become it; your creature waits as a checkpoint.',
      'When you die you come back as your egg, or as your nearest living ancestor.',
      'If nothing survives, hatch a new cell; your lineage stays in History.',
      'You have 3 hatches, and one comes back every 5 min.',
    ],
  },
  {
    id: 'fight',
    title: 'Fight',
    lines: [
      'You can fight creatures within one size tier of yours. Amber rings mark bigger ones.',
      'F attacks the creature the F mark is on. A creature just hatched is protected for 15 s.',
      'Your body strikes by itself when the target is in reach: you steer, pick a stance and brace.',
      '1 aggressive hits harder, 2 balanced, 3 evasive is faster but hits softer.',
      'Shift or the right button braces: a strike that lands then is mostly blocked.',
      'With three fighters or more, or an egg in the fight, Tab or a click picks your target.',
      'Swim out of every foe’s reach and stay out for 3 s to escape.',
      'A kill gives you 40% of the victim’s biomass, and its body drifts as food for anyone.',
      'An egg you carry comes into the fight with you, and a foe can eat it.',
      'A fight lasts 90 s at most. If you leave, your creature fights on by itself.',
    ],
  },
  {
    id: 'lineage',
    title: 'Your lineage',
    lines: [
      'Lineage, in the menu and on the title, shows your creatures and their family.',
      'Every creature has a card to share. It checks the creature’s story in your browser.',
      'Verified means every birth and fight was checked against signed records and a public beacon.',
    ],
    link: { text: 'What this proves', href: VERIFY_HREF },
  },
  { id: 'controls', title: 'Controls', lines: [] },
  {
    id: 'privacy',
    title: 'Privacy',
    lines: [
      'This browser keeps your identity key, your name, your settings, the hints seen and who you muted.',
      'Your recovery code moves your identity to another browser. Keep it private.',
      'The game’s server keeps your public key and your creatures’ signed records, and your name while you play.',
      'Records are public: a creature’s card shows its story, with no player’s name.',
      'A fight’s log is kept for 14 days. There are no accounts and no email.',
      'Players you link with can see your network address, as in any peer-to-peer game.',
      'Chat goes straight to the players near you and is not stored.',
    ],
  },
];

/** The numbers a text names (whole, decimal or a percentage), in order. */
export function helpNumbers(text: string): string[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)*%?/g)].map((m) => m[0]);
}
