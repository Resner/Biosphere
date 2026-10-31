// A creature's glass (M6 T13), coloured by the genes (`materialParams`): a silvery shell with a
// fresnel rim, a backlight and a wet specular from a fixed key light; on medium and high it bends
// the water behind it (the chain's backdrop copy, `tBackdrop`), on low it is plain translucency.
// Procedural pores, a cell texture, the vein network of membranes and small flaws fade in with their
// size on screen (`detailFade`), so a small body never turns to noise. A marking (rings, spots,
// stripes), a thin-film shimmer, a glow that may pulse, denser glass plates and a marked mouth, with
// the same hurt and dissolve effects as `cell.frag.glsl`. The fine parts of body plan v2 (M6 T10)
// have their own looks: a clear carapace shell, bright hair-thin setae, veined membrane sheets and
// dark lens eyes. The inner anatomy (M6 T12) carries the pigment: a gut line, fluid chambers,
// amber-leaning oil droplets, a beating heart and eye pigment show through the near-clear body. Rare
// glints are star points over joints and organs, as many and as bright as the rarity tier allows.
// Look pass 2 (M6 T27): bulb tips are small pearls and joints catch small wet points.
// Look pass 3 (M6 T28): thin walls cross the body between segments, eyes are dark jewelled lenses,
// parts are clean glass, and the rarer glints vary.
// M6b T3 (ADR 0034) took out passes 2 and 3's organ glows, scattered light and centre-lit chambers:
// the organs are pass 1's glassy chambers again, in the gene hue with at most one complementary accent.
// M6b T4 caps the fine parts' light (legs, pearls, setae, setules, membranes), so where they overlap
// they no longer fill whole areas that bloom and the grade burnt to white.
// One program serves every creature; only the uniforms differ.
uniform vec3 uCore;
uniform vec3 uRim;
uniform vec3 uOrgan;
// The complementary accent of an accent organ, and how vivid the rare glints' colours are (M6b T3).
uniform vec3 uAccent;
uniform float uVivid;
uniform vec3 uOil;
uniform vec3 uLumColor;
uniform float uTime;
uniform float uTranslucency;
uniform float uMembrane;
uniform float uPattern;
uniform float uPatternCount;
uniform float uIrid;
uniform float uLum;
uniform float uLumPulse;
uniform float uPlating;
uniform float uRimStrength;
uniform float uGlint;
uniform float uHurt;
uniform float uDissolve;
uniform float uAlpha;
// How clearly the player sees this body in dark water (M6 T16, `sightAt`): 1 is clear.
uniform float uSight;
// The sunlight's caustics at this body (M6 T17, `sunlight`): 0 in the deep and the abyss.
uniform float uCaustic;
// The water behind the creatures and how far (core radii at a grazing angle) the glass bends it;
// 0 with no backdrop copy (low).
uniform sampler2D tBackdrop;
uniform float uRefract;
varying vec3 vNormal;
varying vec2 vUv;
varying float vPart;
varying vec2 vRest;
varying vec2 vScreen;
varying vec2 vUnit;
varying vec2 vWorld;
varying float vWall;

// `aPart` is the appendage number times this, plus the part kind (creature-mesh.ts).
const float PART_KINDS = 16.0;
// The organs' part kinds and the glints' (creature-mesh.ts).
const int PART_GUT = 9;
const int PART_CHAMBER = 10;
const int PART_DROPLET = 11;
const int PART_HEART = 12;
const int PART_PIGMENT = 13;
const int PART_GLINT = 14;
const int PART_SETULE = 15;
// `uv.x` tags (creature-mesh.ts `addBall`): a pearl tip; an accent organ's uv.y starts at ACCENT_V.
const float PEARL_TAG = 2.0;
const float ACCENT_V = 2.0;
const float ORGAN_LUMA = 0.36;
// The wet points on a part's joints: how tight and how bright.
const float JOINT_GLOSS = 14.0;
// At most half the rim colour's luminance (M6b T3), which the drawn rim always reaches.
const float JOINT_SHINE = 0.5;
// A part's half-width on screen (pixels) over which it turns from a bright stroke to clear glass.
const vec2 PART_CLEAR_PX = vec2(2.5, 6.0);
// The brightest a fine part (a leg, a pearl, a membrane) draws, as luminance (M6b T4): where many
// overlap they fill an area at this colour, which with its bloom must stay well short of white,
// while one alone still reads against the water. A seta, often thinner than a pixel, needs more to
// show at all; its setules stay fainter than it, as before the cap, so a comb reads as strokes.
const float PART_LUMA = 0.5;
const float SETA_LUMA = 0.75;
const float SETULE_LUMA = 0.3;
// A pearl tip's hot point toward the light, added over the cap.
const float PEARL_HOT = 0.5;
// Veins across a membrane sheet.
const float MEMBRANE_VEINS = 6.0;
// The thin walls across the body between segments (look pass 3): how bright, their width in pixels,
// and the segment lengths on screen (pixels) over which they fade in, so a small body stays clean.
// At most 0.35 of the rim colour's luminance (M6b T3): faint structure, not bright bands.
const float WALL = 0.35;
const float WALL_PX = 1.6;
const vec2 WALL_FADE = vec2(3.0, 7.0);
// Relative luminance weights.
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
// The key light, low and to the upper left, as its half vector toward the camera: the wet highlight
// lands on the upper-left shoulder of each body, outside the organs, which would hide it.
const vec3 KEY_HALF = vec3(-0.42, 0.46, 0.782);
// The caustic lines' colour over a body: brighter than on the water, as the glass is seen through.
const vec3 CAUSTIC_BODY = vec3(0.45, 0.8, 0.72);
// The shell's rim (M6b T3): its power (plain, membranous) and its brightness at the edge. Pass 1's
// rim was the fresnel itself (power 2, 1.8 bright), which lit the glass well inside the edge.
const vec2 RIM_POWER = vec2(5.0, 3.8);
const float RIM = 5.0;
// The least of the body's rim drawn at full strength, in pixels from its edge (M6b T5 fix).
const float RIM_MIN_PX = 1.0;
// The wet gloss: how tight the highlight is and how bright.
const float GLOSS = 60.0;
const float SHINE = 0.6;
// DETAIL_FROM, DETAIL_TO and the DETAIL_* sizes are defines from `surface.ts`.

// Marking weight 0..1 over the body's own coordinates: u runs around the body (it closes at 1,
// so the repeat count is a whole number) and v runs along it.
float stripeMask(float x, float width) {
  return 1.0 - smoothstep(width, width + 0.12, abs(fract(x) - 0.5) * 2.0);
}

float spotMask(vec2 uv, float count) {
  vec2 g = vec2(uv.x * count, uv.y * count * 0.7);
  vec2 id = floor(g);
  id.x = mod(id.x, count);
  vec2 jitter = vec2(hash21(id), hash21(id + 7.3)) - 0.5;
  float d = length(fract(g) - 0.5 - jitter * 0.3);
  return 1.0 - smoothstep(0.2, 0.3, d);
}

float markings(vec2 uv) {
  if (uPattern < 0.5) return 0.0;
  if (uPattern < 1.5) return stripeMask(uv.y * uPatternCount, 0.35);
  if (uPattern < 2.5) return spotMask(uv, uPatternCount);
  if (uPattern < 3.5) return stripeMask(uv.x * uPatternCount, 0.45);
  if (uPattern < 4.5) return max(spotMask(uv, uPatternCount), stripeMask(uv.x * uPatternCount, 0.45));
  return stripeMask(uv.y * uPatternCount * 0.5, 0.55);
}

// An organ colour dimmed toward ORGAN_LUMA luminance at its hue: yellow and green read far brighter
// than violet at one value, and a bright mass inside would outshine the rim (look pass 2). Only
// partly, so a green stays green rather than turning olive.
vec3 tame(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return c * pow(min(1.0, ORGAN_LUMA / max(l, 1e-3)), 0.85);
}

// Cells of jittered points: the distance to the nearest point, and how far the next one is beyond
// it (0 on a wall between two cells).
vec2 cells(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = vec2(hash21(i + g), hash21(i + g + 19.7));
      float d = length(g + o - f);
      if (d < d1) {
        d2 = d1;
        d1 = d;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }
  return vec2(d1, d2 - d1);
}

// How much of a detail `size` core radii across is drawn, at `px` pixels a core radius (surface.ts).
float detailFade(float size, float px) {
  return smoothstep(DETAIL_FROM, DETAIL_TO, size * px);
}

void main() {
  vec3 normal = normalize(vNormal);
  float z = abs(normal.z);
  float fres = pow(1.0 - z, mix(2.0, 1.4, uMembrane));
  // The shell's rim (M6b T3): far steeper than the fresnel, so it is a crisp bright line round clear
  // glass rather than a glow reaching into the face; the backlight rides it.
  float rim = pow(1.0 - z, mix(RIM_POWER.x, RIM_POWER.y, uMembrane));
  int kind = int(mod(vPart, PART_KINDS) + 0.5);
  // On a slim segment (M6b T5's tails and small heads) that steep rim falls under a pixel and fades
  // into the water, so the body's edge keeps at least RIM_MIN_PX of it: z over its screen gradient
  // is about how many pixels the edge, where z reaches 0, lies away.
  if (kind == 0 || kind == 2) {
    rim = max(rim, 1.0 - smoothstep(0.0, RIM_MIN_PX, z / max(fwidth(z), 1e-4)));
  }
  float back = pow(max(dot(normalize(normal.xy + 1e-4), normalize(vec2(-0.6, 0.7))), 0.0), 3.0) * rim;
  float spec = pow(max(dot(normal, KEY_HALF), 0.0), GLOSS) * SHINE;
  // Screen pixels per core radius, for the detail's fade.
  float px = 0.7071 / max(length(vec2(length(dFdx(vRest)), length(dFdy(vRest)))), 1e-5);

  // The shell is clear face-on (M6 T12, M6b T3): a faint core lets the water and the organs show,
  // and the rim carries the edge.
  vec3 col = uCore * (0.05 + 0.13 * z) + uRim * ((rim * RIM + back * 0.9) * uRimStrength);
  // Markings are faint structure in the glass (0.2 in pass 1; fainter since M6b T3, so the shell stays clear).
  col = mix(col, uRim * 0.8, markings(vUv) * 0.1);

  // Thin-film shimmer: the hue slides with the view angle, a pale sheen on the clear shell.
  if (uIrid > 0.0) {
    vec3 film = 0.5 + 0.5 * cos(6.28318 * (fres * 1.4 + vec3(0.0, 0.33, 0.67)));
    film = mix(vec3(dot(film, vec3(0.3333))), film, 0.5);
    col = mix(col, film * (0.45 + 0.7 * fres), uIrid * (0.2 + 0.4 * fres));
  }

  // Glow in its own hue, pulsing along the body when the pulse allele is expressed. It comes from
  // inside: the organs are the photophores (below), so the shell stays clear.
  float pulse = mix(1.0, 0.5 + 0.5 * sin(uTime * 2.2 + vUv.y * 6.0 + vPart * 1.3), uLumPulse);
  vec3 glow = uLumColor * uLum * pulse;

  float alpha = mix(0.5, 0.2, uTranslucency) * (1.0 - rim) + rim;
  bool glass = kind <= 4;
  float pearlHot = 0.0;
  if (kind == 0 || kind == 2) {
    // A thin wall where two segments meet: a ring round the body, seen from above as a line across
    // it.
    float near = abs(vWall - floor(vWall + 0.5));
    float step_ = max(fwidth(vWall), 1e-5);
    float width = step_ * WALL_PX;
    // Below 0.75 lies only the front span (from 0.5), never a wall: both halves of the first wall draw.
    float wall = (1.0 - smoothstep(width * 0.5, width * 1.5, near)) * step(0.75, vWall) *
      smoothstep(WALL_FADE.x, WALL_FADE.y, 1.0 / step_);
    col += uRim * wall * WALL;
    alpha = max(alpha, wall * 0.5);
  }
  if (kind == 1 && vUv.x >= PEARL_TAG) {
    // A bulb tip (look pass 2): a small solid pearl, bright through, with one hot point toward the
    // light, as on the bead-tipped tentacles of references 02 and 03.
    vec2 n = normal.xy;
    // The hot point is added after the fine parts' cap (M6b T4), so a capped pearl keeps its lustre.
    pearlHot = 1.0 - smoothstep(0.05, 0.35, length(n - vec2(-0.3, 0.35)));
    col = uRim * (0.5 + 0.3 * z);
    alpha = 0.85 + 0.15 * z;
  } else if (kind == 1) {
    // A leg, antenna or bead: thin glass lit through, so its whole width reads bright against the
    // water, not only its edges (a hollow ring reads as a bubble). Its swellings catch the key light
    // in small wet points along the joints (look pass 2).
    // A wide part (a paddle or a broad leg several pixels across) is clear glass like the body, its
    // edges bright and its face open (look pass 5): lit through, stacked paddles read as a white cloud.
    float across = 1.0 / max(length(fwidth(normal.xy)), 1e-3);
    float thin = 1.0 - smoothstep(PART_CLEAR_PX.x, PART_CLEAR_PX.y, across);
    float gloss = pow(max(dot(normal, KEY_HALF), 0.0), JOINT_GLOSS);
    col += uRim * 0.3 * z * thin + vec3(gloss * JOINT_SHINE * dot(uRim, LUMA));
    alpha = mix(alpha, max(alpha, 0.5 + 0.3 * fres), thin);
  } else if (kind == 2) {
    // A plate: denser, brighter glass with a sheen across its face, so armour reads at default zoom
    // (M6 T21), but not an opaque lid: the organs still show through, and the body stays clear
    // (look pass 2 cut the milky fill to under half, and M6b T3 by half again).
    col = mix(col, uRim * (0.75 + 0.35 * z) + 0.06, 0.1) + vec3(spec * 1.5);
    alpha = mix(alpha, 1.0, 0.2 * uPlating);
  } else if (kind == 3) {
    // The mouth: a dark opening ringed by a bright lip, so it reads at default zoom as a mouth, not
    // as a pale cap on the front of the body (look pass 1, M6 T21). The lip stays near white: colour
    // lives inside (T12), and a tinted rim would compete with the organs.
    float lip = smoothstep(0.06, 0.4, fres);
    col = mix(vec3(0.03, 0.02, 0.025), vec3(1.0, 0.95, 0.9) * 1.3, lip);
    alpha = mix(0.8, 1.0, lip);
  } else if (kind == 4) {
    // The carapace: clear glass over the body, a bright rim, a little denser with plating. Its face
    // is nearly clear (M6b T3), so a fused body is not veiled in a milky shell.
    col = uRim * (0.1 + 1.5 * fres + 0.6 * back) + uCore * 0.15;
    alpha = mix(0.1, 0.3, uPlating) + 0.8 * fres;
  } else if (kind == 5) {
    // A seta: a hair-thin bright stroke.
    col = uRim * 1.3 + 0.06;
    alpha = 0.9;
  } else if (kind == PART_SETULE) {
    // A setule (look pass 5): a fainter side hair of a plumose bristle, so a comb stays fine hair
    // and stacked combs do not fill into a white cloud.
    col = uRim * 0.8 + 0.04;
    alpha = 0.45;
  } else if (kind == 6) {
    // A membrane: a thin sheet, its veins running out from the root and across, a fine network
    // between them, and a bright free edge.
    float ray = 1.0 - smoothstep(0.03, 0.09, abs(fract(vUv.x * MEMBRANE_VEINS + 0.5) - 0.5));
    float arc = 1.0 - smoothstep(0.02, 0.06, abs(fract(vUv.y * 3.0 + 0.5) - 0.5));
    float edge = smoothstep(0.86, 1.0, vUv.y);
    // Each detail costs a neighbourhood search, so it is skipped while its fade is zero.
    float netFade = detailFade(DETAIL_VEIN, px);
    float net = netFade > 0.0
      ? (1.0 - smoothstep(0.02, 0.07, cells(vRest / DETAIL_VEIN + 5.3).y)) * netFade
      : 0.0;
    // Look pass 3 thinned the fine network (0.35) and cleared the sheet again (0.12 and 0.65), so a
    // webbed fan reads as a few veins in clear glass rather than crumpled foil.
    float vein = max(ray * smoothstep(0.0, 0.15, vUv.y), max(max(arc * 0.5, net * 0.15), edge));
    // Look pass 2 made the sheet between the veins clearer (0.45 and 0.16), so stacked wings stay
    // veined glass instead of a milky cloud.
    col = uRim * (0.4 + 1.1 * vein) + uCore * 0.2;
    alpha = 0.07 + 0.55 * vein;
  } else if (kind == 7) {
    // An eye: a dark pigment cup in a clear lens (look pass 3, reference 05's big dark eyes): a
    // faint ring of the organ hue round the pupil (fainter since M6b T3, so the colour stays in
    // the organs), a glassy rim and one bright highlight.
    vec2 n = normal.xy;
    float spot = 1.0 - smoothstep(0.1, 0.26, length(n - vec2(-0.3, 0.35)));
    float r = length(n);
    float lens = smoothstep(0.86, 0.99, r);
    float iris = smoothstep(0.45, 0.62, r) * (1.0 - smoothstep(0.66, 0.82, r));
    vec3 cup = vec3(0.015, 0.018, 0.025) + tame(uOrgan) * 0.15 * iris;
    col = mix(cup, uRim * 0.45, lens) + vec3(0.95) * spot;
    alpha = mix(0.97, 0.8, lens);
  } else if (kind == PART_GLINT) {
    // A glint: a white-hot point with four thin rays and four fainter ones, twinkling slowly.
    float id = floor(vUv.y * 0.5);
    // Each star its own size within the quad and, on vivid (rare) bodies, its own colour: some take
    // an organ hue, as 04's and 05's jewels vary (look pass 3); a common body's stay white.
    float pick = hash21(vec2(id, 3.7));
    vec2 q = (vec2(vUv.x, vUv.y - 2.0 * id) * 2.0 - 1.0) / mix(0.75, 1.0, hash21(vec2(id, 11.1)));
    float r = length(q);
    vec2 d = abs(vec2(q.x + q.y, q.x - q.y)) * 0.7071;
    float rays = exp(-abs(q.x) * 12.0) * pow(max(1.0 - abs(q.y), 0.0), 2.0) +
      exp(-abs(q.y) * 12.0) * pow(max(1.0 - abs(q.x), 0.0), 2.0);
    float diagonal = exp(-d.x * 16.0) * pow(max(1.0 - d.y * 1.6, 0.0), 2.0) +
      exp(-d.y * 16.0) * pow(max(1.0 - d.x * 1.6, 0.0), 2.0);
    float hot = exp(-r * r * 40.0) * 2.4;
    float star = hot + 0.45 * rays + 0.15 * diagonal;
    float twinkle = 0.85 + 0.15 * sin(uTime * 2.7 + id * 2.39);
    // Iridescent bodies throw a faint colour into the rays.
    vec3 tint = mix(vec3(1.0, 0.97, 0.92), uRim, 0.25 * uIrid);
    // The hot point stays white; a jewel's colour lives in its rays, at full strength.
    vec3 jewel = pick < 0.5 ? uAccent : uOrgan;
    jewel /= max(max(jewel.r, max(jewel.g, jewel.b)), 1e-3);
    vec3 rayTint = mix(tint, jewel, 0.75 * uVivid * step(0.35, pick));
    col = (tint * hot + rayTint * (star - hot)) * twinkle * uGlint;
    alpha = clamp(star * uGlint, 0.0, 1.0);
  } else if (kind >= PART_GUT) {
    // The organs, seen through the body (pass 1, M6b T3): each in the gene hue, or the
    // complementary accent on an accent organ, lit through from behind.
    vec2 n = normal.xy;
    float spot = 1.0 - smoothstep(0.1, 0.32, length(n - vec2(-0.3, 0.35)));
    vec3 tint = vUv.y >= ACCENT_V ? uAccent : uOrgan;
    if (kind == PART_GUT) {
      // A faint line (look pass 5): on a slim trunk the organs sit along it, and a gut as bright as
      // they are joined them into one streak.
      col = tame(uOrgan) * (0.25 + 0.3 * z);
      alpha = 0.18 + 0.22 * z;
    } else if (kind == PART_CHAMBER) {
      // A fluid chamber, glassy as in pass 1: a clear centre in its colour and a brighter, denser wall.
      col = tint * (0.45 + 0.3 * z + 0.6 * fres) + 0.1 * spot;
      alpha = 0.55 + 0.25 * z + 0.2 * fres;
    } else if (kind == PART_DROPLET) {
      // An oil droplet: amber-leaning lipid with one bright point toward the light.
      col = uOil * (0.6 + 0.35 * z) + 0.3 * spot;
      alpha = 0.7 + 0.25 * z;
    } else if (kind == PART_HEART) {
      float beat = 0.85 + 0.15 * sin(uTime * 5.0);
      col = tint * (0.6 + 0.4 * z) * beat;
      alpha = 0.6 + 0.3 * z;
    } else {
      // Eye pigment: a dark cup, tinted by the gene.
      col = uOrgan * 0.12 + vec3(0.03, 0.01, 0.015);
      alpha = 0.85 * (0.4 + 0.6 * z);
    }
    // Luminous organs are the photophores.
    if (kind != PART_PIGMENT) col += glow * (0.15 + 0.4 * z);
  }

  if (glass) {
    // The glass's surface: faint cell walls, small pits and an uneven thickness, each fading in
    // with its size on screen; then the wet highlight of the key light. Parts are clean glass
    // (look pass 3): on a thin tube the texture read as crumpled foil.
    // Each costs a neighbourhood search (or noise), so it is skipped while its fade is zero.
    float textured = kind == 1 ? 0.0 : 1.0;
    float wallFade = detailFade(DETAIL_CELL, px) * textured;
    float poreFade = detailFade(DETAIL_PORE, px) * textured;
    float flawFade = detailFade(DETAIL_FLAW, px) * textured;
    float wall = wallFade > 0.0
      ? (1.0 - smoothstep(0.03, 0.1, cells(vRest / DETAIL_CELL).y)) * wallFade
      : 0.0;
    float pore = poreFade > 0.0
      ? (1.0 - smoothstep(0.1, 0.2, cells(vRest / DETAIL_PORE + 31.7).x)) * poreFade
      : 0.0;
    float flaw = flawFade > 0.0 ? (fbm(vRest / DETAIL_FLAW + 3.1) - 0.5) * flawFade : 0.0;
    // The rim stays clean: the detail fades toward the grazing edge, where it would crowd.
    float face = 1.0 - fres;
    col += uRim * (wall * 0.16 * face);
    col *= (1.0 - 0.45 * pore * face) * (1.0 + 0.4 * flaw * face);
    alpha = clamp(alpha * (1.0 + 0.4 * flaw) + wall * 0.08, 0.0, 1.0);
    col += vec3(spec);
    alpha = max(alpha, min(spec * 1.5, 1.0));
    // Refraction: the water behind is drawn bent by the normal. The blend lays this colour over
    // the water straight behind, so the glass adds the difference the bend makes, scaled to show
    // through its transparency.
    if (uRefract > 0.0) {
      vec2 bend = normal.xy * vUnit * uRefract;
      vec3 straight = texture2D(tBackdrop, vScreen).rgb;
      vec3 bent = texture2D(tBackdrop, vScreen - bend).rgb;
      col = max(col + (bent - straight) * min((1.0 - alpha) / max(alpha, 0.3), 1.0), 0.0);
    }
  }

  // Caustics (M6 T17, caustics.glsl): the water's light lines, projected straight down, play over
  // the body in the same places, so they run on across it. They light the glass a little denser.
  if (uCaustic > 0.0 && kind != PART_GLINT) {
    float lines = causticAt(vWorld, uTime) * uCaustic;
    col += CAUSTIC_BODY * lines;
    alpha = min(alpha + 0.5 * lines * (1.0 - alpha), 1.0);
  }

  // A fine part's light is capped (M6b T4): its tube's rim, gloss and caustics would otherwise add
  // up, and overlapping parts filled whole areas with white.
  if (kind == 1 || kind == 5 || kind == 6 || kind == PART_SETULE) {
    float cap = kind == 5 ? SETA_LUMA : kind == PART_SETULE ? SETULE_LUMA : PART_LUMA;
    col *= min(1.0, cap / max(dot(col, LUMA), 1e-4));
    col += vec3(PEARL_HOT) * pearlHot;
  }

  // Dark water (M6 T16): beyond the player's sight in the deep and the abyss the body fades into
  // the fog unless glow lights it, but its rim always stays, so a creature is never invisible.
  col = mix(uRim * (rim * RIM + back * 0.9) * uRimStrength, col, uSight);

  vec3 hurtCol = vec3(1.0, 0.18, 0.12);
  if (uHurt > 0.0) col = mix(col, col * 0.5 + hurtCol * (0.35 + 0.8 * fres), uHurt * 0.7);

  // Death: the body breaks up along a noisy front and fades, with a bright edge on the front.
  if (uDissolve > 0.0) {
    float front = fbm(vUv * 7.0 + vPart) * 0.75 + 0.125;
    float gone = smoothstep(front - 0.06, front + 0.06, uDissolve * 1.15);
    float edge = 1.0 - smoothstep(0.0, 0.08, abs(front - uDissolve * 1.15));
    alpha *= (1.0 - gone) * (1.0 - 0.35 * uDissolve);
    col += vec3(0.9, 0.7, 0.5) * edge * 0.6;
  }
  gl_FragColor = vec4(col, alpha * uAlpha);
}
