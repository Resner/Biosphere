# Art references

Reference images for the art direction in `docs/BRIEF.md`: macro photography of microscopic life. They are references only. They never ship in `dist/`, and the game's assets stay procedural or original.

## reference-01.jpg

The owner's reference: a copepod-like creature lit from behind in dark water. Take these qualities from it:

- **Water**: deep teal-grey to near-black, never flat. Soft, out-of-focus clouds of lighter haze give depth.
- **Backlight and rim light**: a strong light behind the subject makes its edges glow white-hot and leaves its body in a darker, readable silhouette. This is the main tool for silhouettes readable at a glance.
- **Translucent bodies with internal sparkle**: the body reads as glassy and segmented, with tiny bright specular glints inside it (organelles, lipid droplets). A dark core plus glints is more convincing than a uniform tint.
- **Fine detail at the edges**: long, thin antennae with evenly spaced setae (bristles), and fan-like bristles near the head. Thin appendages should stay crisp and bright against the dark water.
- **Shallow depth of field**: only one plane is sharp. Particles in front of and behind it become soft discs (bokeh), some with chromatic fringes (the rainbow edge on the bubble at the lower right).
- **Marine snow**: a sparse field of tiny specks at several depths, drifting slowly.
- **Accent colours**: small saturated accents against the cool background. Chlorophyll-green spheres and chains, and an amber, star-shaped diatom-like shell. In Biosphere these become nonliving food and decorative particles, never organisms with behaviour.

## reference-02.jpg to reference-05.jpg

The owner's bar for the creature look overhaul (#90, M6). Each sheet shows 20 micro-organisms seen from above on dark water. The written brief is in #90; judge the game's creatures against both, critically.

- **Silhouettes**: oval copepods with long sweeping antennae; crab-like bodies with clawed, jointed legs; spherical larvae ringed with setae or bulb-tipped spines; S-curved worms; tadpole and fish larvae with big dark eyes and feathery tails; jellyfish bells with bead-tipped tentacles; manta- and butterfly-winged plankton with veined membranes; spiral nautilus-like coils; flower-like petal bodies; segmented shrimp and amphipods with fan tails. No two neighbours share a silhouette.
- **Anatomy**: a clear outer shell over visible inner organs: a gut line, clusters of round fluid chambers and oil droplets, eyes, segment boundaries. The inner parts carry the colour; the shell stays glassy.
- **Fine detail**: hair-thin antennae and setae with evenly spaced beads and joints, feathery fans, veined wing membranes. They stay crisp and bright against the dark water.
- **Light**: luminous white rims, tiny specular points along edges and joints, soft glow from inside.
- **Colour and rarity**: 02 and 03 match the written palette best: crystal-clear and silvery bodies with amber, violet, cyan, emerald and pink only inside. 04 and 05 are far more saturated and glittering. Take that intensity as the ceiling for the rarest creatures, not the norm: the brief says sparkles must feel exceptionally rare, so common creatures look like 02 and 03, and glow and glints rise with rarity.
- **Not to copy**: the names, size labels and icons under each creature are presentation only, though the plain card (name, size in µm) is a good model for the inspect card.

## gallery/

The look passes of M6 (ADR 0024): `gallery/pass-0` to `pass-5` hold each pass's specimen sheet (`.png`) and its gap table against references 02–05 (`.md`). `npm run gallery` redraws the sheet; the open gaps are tracked in #177.

## icons-sheet.png

The ping and emote icons (M6 T25, `src/game/icons.ts`) at 20 and 40 px, as `m6-icons.spec.ts` saves them: look, danger, food, mate, wave, happy, love, angry, scared, question. Original line art, drawn for Biosphere; no third-party icon set.

## How it maps to the game

- The camera looks down on the gameplay plane, not from the side as in the photo; the lighting ideas carry over unchanged: backlight, rim, glints, bokeh.
- Deeper zones get darker, and bioluminescence becomes the dominant light source there (the brief: "bioluminescence deeper down").
- Gameplay-relevant parts (mouths, spikes, plates) must stay recognisable at the default zoom, so detail never fights the silhouette.
