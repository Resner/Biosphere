// A creature's glass (M6 T13), coloured by the genes (`materialParams`): a silvery shell with a
// fresnel rim, a backlight and a wet specular from a fixed key light; on medium and high it bends
// the water behind it (the chain's backdrop copy, `tBackdrop`), on low it is plain translucency.
// Procedural pores, a cell texture, the vein network of membranes and small flaws fade in with their
// size on screen (`detailFade`), so a small body never turns to noise. A marking (rings, spots,
// stripes), a thin-film shimmer, a glow that may pulse, denser glass plates and a marked mouth, with
// the same hurt and dissolve effects as `cell.frag.glsl`. The fine parts of body plan v2 (M6 T10)
// have their own looks: a clear carapace shell, bright hair-thin setae, veined membrane sheets and
// dark lens eyes. The inner anatomy (M6 T12) carries the pigment: a gut line, fluid chambers,
// oil droplets, a beating heart and eye pigment show through the near-clear body. Rare
// glints are star points over joints and organs, as many and as bright as the rarity tier allows.
// Look pass 2 (M6 T27): bulb tips are small pearls and joints catch small wet points.
// Look pass 3 (M6 T28): thin walls cross the body between segments, eyes are dark jewelled lenses,
// parts are clean glass, and the rarer glints vary.
// M6b T3 (ADR 0034) took out passes 2 and 3's organ glows, scattered light and centre-lit chambers:
// the organs are pass 1's glassy chambers again, in the gene hue with at most one complementary accent.
// M6b T4 caps the fine parts' light (legs, pearls, setae, setules, membranes), so where they overlap
// they no longer fill whole areas that bloom and the grade burnt to white.
// M6c T6 (ADR 0043) brought back pass 1's face and soft fresnel rim, and gave the limbs, membranes
// and setae the same glass, capped at the body rim's peak; the mouth is glass with a small feature.
// M6c T7 (ADR 0043): the organs keep to two related tones (the main colour and a second tone near it,
// which the droplets and half the chambers take), the iris takes the main colour, and the heart or
// the largest chamber, and at most one more organ, glow faintly inside their own outline.
// M6c T8: nothing narrower than 1.5 px on screen is drawn as a line (`fine`): the cell texture's and
// the vein network's walls, the gut and the setules fade out instead, since under a pixel they broke
// into dots (Firefox, coarse derivatives); the cell texture starts at 6 px a cell, and every layer
// runs at high precision (`HIGHP`, materials.ts).
// One program serves every creature; only the uniforms differ.
uniform vec3 uCore;
uniform vec3 uRim;
uniform vec3 uOrgan;
// The organs' second tone, the eyes' iris and how vivid the rare glints' colours are (ADR 0043).
uniform vec3 uSecond;
uniform vec3 uIris;
uniform float uVivid;
// The glowing organs' luminance gain (`organGlow`: at most 0.15, or 0.35 with the luminescence gene).
uniform float uOrganGlow;
uniform float uTime;
uniform float uTranslucency;
uniform float uMembrane;
uniform float uPattern;
uniform float uPatternCount;
uniform float uIrid;
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
varying float vTurn;
// Flat (M6c T6): a triangle that joins two kinds (the body's rings by a plate's edge or at the mouth)
// would otherwise blend their numbers into a third kind between them, drawn as a limb's stroke.
flat varying float vPart;
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
// `uv.x` tags (creature-mesh.ts `addBall`): a pearl tip; a fringe part's tube (M6c T3) is tagged
// from FRINGE_TAG. An organ's uv.y starts at a tag (creature-parts.ts `SECOND_V`, `GLOW_V`): bit 0 of
// floor(uv.y / 2) is the second tone, bit 1 a glowing organ.
const float PEARL_TAG = 2.0;
const float FRINGE_TAG = 4.0;
const float ORGAN_LUMA = 0.36;
// The iris's span (shares of the eye's radius, ADR 0043).
const vec2 IRIS = vec2(0.45, 0.82);
// The iris's light at its inner and outer edge, shares of the tamed main colour.
const float IRIS_INNER = 0.35;
const float IRIS_OUTER = 0.75;
// How far in from an organ's outline (its facing z) its glow starts.
const float GLOW_FROM_Z = 0.75;
// A part's radius on screen (pixels) over which it turns from all rim (a glass rod narrower than the
// body's rim band is all edge) to glass with a rim, like the body (M6c T6; at 2.5-6 a fan of paddles
// drawn all rim read as a white cloud).
const vec2 PART_CLEAR_PX = vec2(0.75, 1.5);
// A fine part (a leg, a pearl, a seta, a membrane, the mouth's feature) draws no brighter than the body
// rim's peak (M6c T6, `rimPeak`): one alone matches the rim, and where many overlap they fill an area
// at that colour, which the grade's shoulder keeps short of white. Setae, setules and fringe stay
// fainter than it (shares of it), so a comb's bristles and their bloom stay separate strokes rather
// than one bright cloud, and fringe reads as faint cilia.
const float SETA_LUMA = 0.6;
const float SETULE_LUMA = 0.3;
// How dense a setule is (0.45 before look pass 6): where combs overlap, their setules filled the
// space between the bristles with a grey haze.
const float SETULE_ALPHA = 0.25;
// How dense a seta is: one alone, often thinner than a pixel, still reads, while a comb of them
// builds toward the cap rather than filling at once.
const float SETA_ALPHA = 0.7;
// Fringe (M6c T3, T6): fine, faint cilia, their light and density.
const float FRINGE_LUMA = 0.55;
const float FRINGE_ALPHA = 0.35;
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
// The glass (pass 1, ADR 0043): the face's core light face-on and added at the axis, and the rim's
// brightness, the fresnel itself (power 2 to 1.4 by membrane), which lights the glass inside the edge.
const vec2 FACE = vec2(0.15, 0.3);
const float RIM = 1.8;
const float BACK = 0.9;
// How far in from the edge the rim keeps its full strength, as z over its screen gradient, which is
// about twice the pixels from a rounded edge (M6b T5 fix; M6c T6: 3, so a body's and a limb's edge
// keep about 1.5 px of full rim, and a rod 3 px across is all rim).
const float RIM_MIN_PX = 3.0;
// A limb's light along its axis (pass 1's legs, lit through). Its density is the body's.
const float LIMB_FILL = 0.3;
// The wet gloss: how tight the highlight is and how bright.
const float GLOSS = 60.0;
const float SHINE = 0.6;
// DETAIL_FROM, DETAIL_TO, the DETAIL_* sizes, FINE_FROM, FINE_TO and the LINE_* widths are defines
// from `surface.ts`.

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

// How much of a line or tube `widthPx` pixels wide is drawn (M6c T8, surface.ts `fineFade`): under a
// pixel it would fall between pixel centres and break into dots, so it fades out instead.
float fine(float widthPx) {
  return smoothstep(FINE_FROM, FINE_TO, widthPx);
}

void main() {
  // No NaN (M6c T8): normals facing apart can interpolate to nothing, and normalising nothing is
  // NaN, which the bloom spreads over a whole body; nor a fresnel of a facing past 1.
  vec3 normal = vNormal * inversesqrt(max(dot(vNormal, vNormal), 1e-8));
  float z = min(abs(normal.z), 1.0);
  float fres = pow(1.0 - z, mix(2.0, 1.4, uMembrane));
  int kind = int(mod(vPart, PART_KINDS) + 0.5);
  // Pearl tips and fringe carry `uv.x` tags; the mouth's feature (M6c T6, creature-mouth.ts) is
  // drawn as a limb's tube and setae's ribbons.
  bool tagged = kind == 1 && vUv.x >= PEARL_TAG;
  bool fringe = kind == 1 && vUv.x >= FRINGE_TAG;
  // The rim is the fresnel (pass 1). On the body, its plates, the mouth's disc (kind 3, glass like the
  // rest of the body since M6c T6, with no dark fill) and the limbs, the edge keeps at least
  // RIM_MIN_PX of it at full strength, so a slim segment (M6b T5's tails and small heads) and a limb
  // keep an edge: z over its screen gradient grows with the pixels to the edge, where z reaches 0.
  float rim = fres;
  bool hull = kind == 0 || kind == 2 || kind == 3;
  if (hull || kind == 1) rim = max(rim, 1.0 - smoothstep(0.0, RIM_MIN_PX, z / max(fwidth(z), 1e-4)));
  // A thin rod (a limb, a mandible) narrower than the rim band is all rim: the same glass as the
  // body's edge, so a limb reads as the body's, not grey (M6c T6).
  // `uv.x` runs once round a part's tube, so its rate across the screen gives the tube's radius in
  // pixels; unlike the normal's, it does not change along the part, where a paddle swells. It wraps
  // from 1 to 0 in one band of the tube, where its rate jumps; `vTurn` is the same turn with its wrap
  // on the far side, so the smaller of the two rates is the tube's (M6c T8). A setule's `uv.x` runs
  // once across it instead, so its width is 1 over its rate.
  float rate = length(vec2(dFdx(vUv.x), dFdy(vUv.x)));
  float turnRate = length(vec2(dFdx(vTurn), dFdy(vTurn)));
  float across = 1.0 / max(6.2832 * min(rate, turnRate), 1e-4);
  // A tube's width on screen, for fading one under 1.5 px (M6c T8): seen from above, `across` reads
  // from half the radius at the tube's edges (where a thin tube's few pixels lie) to all of it on top.
  float tubePx = 4.0 * across;
  float thin = 1.0 - smoothstep(PART_CLEAR_PX.x, PART_CLEAR_PX.y, across);
  if (kind == 1) rim = mix(rim, 1.0, thin);
  vec2 side = normal.xy + 1e-4;
  side *= inversesqrt(max(dot(side, side), 1e-8));
  float back = pow(max(dot(side, normalize(vec2(-0.6, 0.7))), 0.0), 3.0) * rim;
  float spec = pow(max(dot(normal, KEY_HALF), 0.0), GLOSS) * SHINE;
  // Screen pixels per core radius, for the detail's fade.
  float px = 0.7071 / max(length(vec2(length(dFdx(vRest)), length(dFdy(vRest)))), 1e-5);

  // Pass 1's glass (ADR 0043): a dim core face-on lets the water and the organs show, with a soft
  // sheen toward the edge, and the fresnel rim carries the edge. No haze layer over the face.
  vec3 col = uCore * (FACE.x + FACE.y * z) + uRim * ((rim * RIM + back * BACK) * uRimStrength);
  // The rim's peak, which no fine part outshines.
  float rimPeak = dot(uCore * FACE.x + uRim * (RIM * uRimStrength), LUMA);
  // Markings are faint structure in the glass, as in pass 1 (ADR 0043).
  col = mix(col, uRim * 0.8, markings(vUv) * 0.2);

  // Thin-film shimmer: the hue slides with the view angle, a pale sheen on the clear shell.
  if (uIrid > 0.0) {
    vec3 film = 0.5 + 0.5 * cos(6.28318 * (fres * 1.4 + vec3(0.0, 0.33, 0.67)));
    film = mix(vec3(dot(film, vec3(0.3333))), film, 0.5);
    col = mix(col, film * (0.45 + 0.7 * fres), uIrid * (0.2 + 0.4 * fres));
  }

  float alpha = mix(0.5, 0.2, uTranslucency) * (1.0 - rim) + rim;
  bool glass = kind <= 4;
  float pearlHot = 0.0;
  if (hull) {
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
  if (fringe) {
    // Fringe (M6c T3, T6): fine, faint cilia, the body's glass at low density.
    col = uRim * (RIM * uRimStrength);
    alpha = FRINGE_ALPHA;
  } else if (tagged) {
    // A bulb tip (look pass 2): a small solid pearl, bright through, with one hot point toward the
    // light, as on the bead-tipped tentacles of references 02 and 03.
    vec2 n = normal.xy;
    // The hot point is added after the fine parts' cap (M6b T4), so a capped pearl keeps its lustre.
    pearlHot = 1.0 - smoothstep(0.05, 0.35, length(n - vec2(-0.3, 0.35)));
    col = uRim * (0.5 + 0.3 * z);
    alpha = 0.85 + 0.15 * z;
  } else if (kind == 1) {
    // A leg, antenna, bead or mandible (M6c T6): the body's glass, face and fresnel rim alike, lit
    // through along its axis, as pass 1's legs were. A thin one is all rim, so it
    // reads as one stroke as bright as the body's edge; a wide one (a paddle, a broad leg) is glass
    // with a bright edge. Neither has a bright wet point of its own, which read as beads.
    col += uRim * (LIMB_FILL * z * uRimStrength);
  } else if (kind == 2) {
    // A plate: denser, brighter glass with a sheen across its face, so armour reads at default zoom
    // (M6 T21), but not an opaque lid: the organs still show through, and the body stays clear
    // (look pass 2 cut the milky fill to under half, and M6b T3 by half again).
    col = mix(col, uRim * (0.75 + 0.35 * z) + 0.06, 0.1) + vec3(spec * 1.5);
    alpha = mix(alpha, 1.0, 0.2 * uPlating);
  } else if (kind == 4) {
    // The carapace: clear glass over the body, a bright rim, a little denser with plating. Its face
    // is nearly clear (M6b T3), so a fused body is not veiled in a milky shell.
    col = uRim * (0.1 + 1.5 * fres + 0.6 * back) + uCore * 0.15;
    alpha = mix(0.1, 0.3, uPlating) + 0.8 * fres;
  } else if (kind == 5) {
    // A seta: a hair-thin stroke, all rim, as bright as the body's edge.
    col = uCore * FACE.x + uRim * (RIM * uRimStrength);
    alpha = SETA_ALPHA;
  } else if (kind == PART_SETULE) {
    // A setule (look pass 5): a fainter side hair of a plumose bristle, so a comb stays fine hair
    // and stacked combs do not fill into a white cloud.
    col = uRim * (RIM * uRimStrength);
    alpha = SETULE_ALPHA * fine(1.0 / max(rate, 1e-4));
  } else if (kind == 6) {
    // A membrane: a thin sheet, its veins running out from the root and across, a fine network
    // between them, and a bright free edge.
    float ray = 1.0 - smoothstep(0.03, 0.09, abs(fract(vUv.x * MEMBRANE_VEINS + 0.5) - 0.5));
    float arc = 1.0 - smoothstep(0.02, 0.06, abs(fract(vUv.y * 3.0 + 0.5) - 0.5));
    float edge = smoothstep(0.86, 1.0, vUv.y);
    // Each detail costs a neighbourhood search, so it is skipped while its fade is zero.
    float netFade = detailFade(DETAIL_VEIN, px) * fine(LINE_VEIN * DETAIL_VEIN * px);
    float net = netFade > 0.0
      ? (1.0 - smoothstep(0.02, 0.07, cells(vRest / DETAIL_VEIN + 5.3).y)) * netFade
      : 0.0;
    // Look pass 3 thinned the fine network (0.35) and cleared the sheet again (0.12 and 0.65), so a
    // webbed fan reads as a few veins in clear glass rather than crumpled foil.
    float vein = max(ray * smoothstep(0.0, 0.15, vUv.y), max(max(arc * 0.5, net * 0.15), edge));
    // Look pass 2 made the sheet between the veins clearer (0.45 and 0.16), so stacked wings stay
    // veined glass instead of a milky cloud. The body's glass (M6c T6): the face between the veins,
    // and the veins and free edge lit as its rim.
    float edgeLight = max(vein, fres);
    col = uCore * (FACE.x + FACE.y * z) + uRim * (edgeLight * RIM * uRimStrength);
    alpha = 0.07 + 0.55 * vein;
  } else if (kind == 7) {
    // An eye: a dark pupil in a clear lens (look pass 3, reference 05's big dark eyes), with an iris
    // in the main organ colour at full saturation (ADR 0043) from IRIS.x to IRIS.y of its radius, a
    // glassy rim and one bright highlight.
    vec2 n = normal.xy;
    float spot = 1.0 - smoothstep(0.1, 0.26, length(n - vec2(-0.3, 0.35)));
    float r = length(n);
    float lens = smoothstep(0.86, 0.99, r);
    float iris = smoothstep(IRIS.x - 0.05, IRIS.x + 0.02, r) * (1.0 - smoothstep(IRIS.y - 0.02, IRIS.y + 0.04, r));
    // A deep colour, darkening toward the pupil, so the eye stays a dark lens rather than a bright ring.
    vec3 pupil = vec3(0.015, 0.018, 0.025);
    vec3 cup = mix(pupil, tame(uIris) * mix(IRIS_INNER, IRIS_OUTER, smoothstep(IRIS.x, IRIS.y, r)), iris);
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
    // White, or on a vivid body one of the organs' two tones (ADR 0043): no third colour.
    vec3 tint = vec3(1.0, 0.97, 0.92);
    // The hot point stays white; a jewel's colour lives in its rays, at full strength.
    vec3 jewel = pick < 0.5 ? uSecond : uOrgan;
    jewel /= max(max(jewel.r, max(jewel.g, jewel.b)), 1e-3);
    vec3 rayTint = mix(tint, jewel, uVivid * step(0.35, pick));
    col = (tint * hot + rayTint * (star - hot)) * twinkle * uGlint;
    alpha = clamp(star * uGlint, 0.0, 1.0);
  } else if (kind >= PART_GUT) {
    // The organs, seen through the body (pass 1, ADR 0043): each in the main colour or the second
    // tone, lit through from behind.
    vec2 n = normal.xy;
    float spot = 1.0 - smoothstep(0.1, 0.32, length(n - vec2(-0.3, 0.35)));
    float tag = floor(vUv.y * 0.5 + 1e-3);
    vec3 tint = mod(tag, 2.0) > 0.5 ? uSecond : uOrgan;
    if (kind == PART_GUT) {
      // A faint line (look pass 5): on a slim trunk the organs sit along it, and a gut as bright as
      // they are joined them into one streak.
      col = tame(uOrgan) * (0.25 + 0.3 * z);
      alpha = 0.18 + 0.22 * z;
      alpha *= fine(tubePx);
    } else if (kind == PART_CHAMBER) {
      // A fluid chamber, glassy as in pass 1: a clear centre in its colour and a brighter, denser wall.
      col = tint * (0.45 + 0.3 * z + 0.6 * fres) + 0.1 * spot;
      alpha = 0.55 + 0.25 * z + 0.2 * fres;
    } else if (kind == PART_DROPLET) {
      // An oil droplet: lipid in the second tone with one bright point toward the light.
      col = uSecond * (0.6 + 0.35 * z) + 0.3 * spot;
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
    // A faint glow (ADR 0043): the heart, or the largest chamber, and at most one more organ grow
    // brighter toward their centre by at most uOrganGlow, falling to nothing at their outline, so
    // nothing glows outside an organ. It pulses with the pulse allele.
    if (tag >= 1.5 && kind != PART_PIGMENT) {
      float pulse = mix(1.0, 0.6 + 0.4 * sin(uTime * 2.2 + vPart * 1.3), uLumPulse);
      col *= 1.0 + uOrganGlow * pulse * smoothstep(GLOW_FROM_Z, 1.0, z);
    }
  }

  // A limb, a fringe cilium or a pearl narrower than 1.5 px fades rather than breaking into dots that
  // come and go as the body moves on the pixel grid (M6c T8: the owner's flashing antennae).
  if (kind == 1) alpha *= fine(tubePx);

  if (glass) {
    // The glass's surface: faint cell walls, small pits and an uneven thickness, each fading in
    // with its size on screen; then the wet highlight of the key light. Parts are clean glass
    // (look pass 3): on a thin tube the texture read as crumpled foil.
    // Each costs a neighbourhood search (or noise), so it is skipped while its fade is zero.
    float textured = kind == 1 ? 0.0 : 1.0;
    float wallFade = detailFade(DETAIL_CELL, px) * fine(LINE_CELL * DETAIL_CELL * px) * textured;
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
    float lines = causticAt(vWorld, uSunTime) * uCaustic;
    col += CAUSTIC_BODY * lines;
    alpha = min(alpha + 0.5 * lines * (1.0 - alpha), 1.0);
  }

  // A fine part's light is capped at the body rim's peak (M6b T4, M6c T6): its tube's rim, gloss and
  // caustics would otherwise add up, and overlapping parts filled whole areas with white.
  if (kind == 1 || kind == 5 || kind == 6 || kind == PART_SETULE) {
    float cap = rimPeak *
      (kind == 5 ? SETA_LUMA : kind == PART_SETULE ? SETULE_LUMA : fringe ? FRINGE_LUMA : 1.0);
    col *= min(1.0, cap / max(dot(col, LUMA), 1e-4));
    col += vec3(PEARL_HOT) * pearlHot;
  }

  // Dark water (M6 T16): beyond the player's sight in the deep and the abyss the body fades into
  // the fog unless glow lights it, but its rim always stays, so a creature is never invisible.
  col = mix(uRim * (rim * RIM + back * BACK) * uRimStrength, col, uSight);

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
