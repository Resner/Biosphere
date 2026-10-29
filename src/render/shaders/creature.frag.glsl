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
// Look pass 2 (M6 T27): organs sit in soft glows that merge into masses, take two hues (wider and
// more vivid with rarity), bulb tips are small pearls and joints catch small wet points.
// One program serves every creature; only the uniforms differ.
uniform vec3 uCore;
uniform vec3 uRim;
uniform vec3 uOrgan;
// The second organ hue and how vivid the inside is, both rising with rarity (look pass 2).
uniform vec3 uOrgan2;
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

// `aPart` is the appendage number times this, plus the part kind (creature-mesh.ts).
const float PART_KINDS = 16.0;
// The organs' part kinds and the glints' (creature-mesh.ts).
const int PART_GUT = 9;
const int PART_CHAMBER = 10;
const int PART_DROPLET = 11;
const int PART_HEART = 12;
const int PART_PIGMENT = 13;
const int PART_GLINT = 14;
// `uv.x` tags (creature-mesh.ts `addBall`): a pearl tip, and each organ's number times ORGAN_TAG.
const float PEARL_TAG = 2.0;
const float ORGAN_TAG = 2.0;
// An organ glow's uv.y at its centre (its rim is one more), and its opacity there.
const float HALO_V = 2.0;
const float HALO_ALPHA = 0.4;
const float ORGAN_LUMA = 0.36;
// The wet points on a part's joints: how tight and how bright.
const float JOINT_GLOSS = 14.0;
const float JOINT_SHINE = 0.7;
// Veins across a membrane sheet.
const float MEMBRANE_VEINS = 6.0;
// The key light, low and to the upper left, as its half vector toward the camera: the wet highlight
// lands on the upper-left shoulder of each body, outside the organs, which would hide it.
const vec3 KEY_HALF = vec3(-0.42, 0.46, 0.782);
// The caustic lines' colour over a body: brighter than on the water, as the glass is seen through.
const vec3 CAUSTIC_BODY = vec3(0.45, 0.8, 0.72);
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
  float back = pow(max(dot(normalize(normal.xy + 1e-4), normalize(vec2(-0.6, 0.7))), 0.0), 3.0) * fres;
  float spec = pow(max(dot(normal, KEY_HALF), 0.0), GLOSS) * SHINE;
  int kind = int(mod(vPart, PART_KINDS) + 0.5);
  // Screen pixels per core radius, for the detail's fade.
  float px = 0.7071 / max(length(vec2(length(dFdx(vRest)), length(dFdy(vRest)))), 1e-5);

  // The shell is nearly clear face-on (M6 T12): a dim core lets the organs show, the rim carries the edge.
  vec3 col = uCore * (0.15 + 0.3 * z) + uRim * ((fres * 1.8 + back * 0.9) * uRimStrength);
  col = mix(col, uRim * 0.8, markings(vUv) * 0.2);

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

  float alpha = mix(0.5, 0.2, uTranslucency) * (1.0 - fres) + fres;
  bool glass = kind <= 4;
  if (kind == 1 && vUv.x >= PEARL_TAG) {
    // A bulb tip (look pass 2): a small solid pearl, bright through, with one hot point toward the
    // light, as on the bead-tipped tentacles of references 02 and 03.
    vec2 n = normal.xy;
    float hot = 1.0 - smoothstep(0.05, 0.35, length(n - vec2(-0.3, 0.35)));
    col = uRim * (0.5 + 0.3 * z) + vec3(0.5) * hot;
    alpha = 0.85 + 0.15 * z;
  } else if (kind == 1) {
    // A leg, antenna or bead: thin glass lit through, so its whole width reads bright against the
    // water, not only its edges (a hollow ring reads as a bubble). Its swellings catch the key light
    // in small wet points along the joints (look pass 2).
    col += uRim * 0.3 * z + vec3(pow(max(dot(normal, KEY_HALF), 0.0), JOINT_GLOSS) * JOINT_SHINE);
    alpha = max(alpha, 0.5 + 0.3 * fres);
  } else if (kind == 2) {
    // A plate: denser, brighter glass with a sheen across its face, so armour reads at default zoom
    // (M6 T21), but not an opaque lid: the organs still show through, and the body stays clear
    // (look pass 2 cut the milky fill to under half).
    col = mix(col, uRim * (0.75 + 0.35 * z) + 0.06, 0.18) + vec3(spec * 1.5);
    alpha = mix(alpha, 1.0, 0.3 * uPlating);
  } else if (kind == 3) {
    // The mouth: a dark opening ringed by a bright lip, so it reads at default zoom as a mouth, not
    // as a pale cap on the front of the body (look pass 1, M6 T21). The lip stays near white: colour
    // lives inside (T12), and a tinted rim would compete with the organs.
    float lip = smoothstep(0.06, 0.4, fres);
    col = mix(vec3(0.03, 0.02, 0.025), vec3(1.0, 0.95, 0.9) * 1.3, lip);
    alpha = mix(0.8, 1.0, lip);
  } else if (kind == 4) {
    // The carapace: clear glass over the body, a bright rim, a little denser with plating.
    col = uRim * (0.3 + 1.5 * fres + 0.6 * back) + uCore * 0.15;
    alpha = mix(0.1, 0.3, uPlating) + 0.8 * fres;
  } else if (kind == 5) {
    // A seta: a hair-thin bright stroke.
    col = uRim * 1.3 + 0.06;
    alpha = 0.9;
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
    float vein = max(ray * smoothstep(0.0, 0.15, vUv.y), max(max(arc * 0.5, net * 0.35), edge));
    // Look pass 2 made the sheet between the veins clearer (0.45 and 0.16), so stacked wings stay
    // veined glass instead of a milky cloud.
    col = uRim * (0.4 + 1.1 * vein) + uCore * 0.2;
    alpha = 0.12 + 0.65 * vein;
  } else if (kind == 7) {
    // An eye: a dark lens with one bright highlight toward the light.
    vec2 n = normal.xy;
    float spot = 1.0 - smoothstep(0.12, 0.3, length(n - vec2(-0.3, 0.35)));
    col = vec3(0.02, 0.025, 0.03) + vec3(0.95) * spot + uRim * fres * 0.7;
    alpha = 0.96;
  } else if (kind == PART_GLINT) {
    // A glint: a white-hot point with four thin rays and four fainter ones, twinkling slowly.
    float id = floor(vUv.y * 0.5);
    vec2 q = vec2(vUv.x, vUv.y - 2.0 * id) * 2.0 - 1.0;
    float r = length(q);
    vec2 d = abs(vec2(q.x + q.y, q.x - q.y)) * 0.7071;
    float rays = exp(-abs(q.x) * 12.0) * pow(max(1.0 - abs(q.y), 0.0), 2.0) +
      exp(-abs(q.y) * 12.0) * pow(max(1.0 - abs(q.x), 0.0), 2.0);
    float diagonal = exp(-d.x * 16.0) * pow(max(1.0 - d.y * 1.6, 0.0), 2.0) +
      exp(-d.y * 16.0) * pow(max(1.0 - d.x * 1.6, 0.0), 2.0);
    float star = exp(-r * r * 40.0) * 2.4 + 0.45 * rays + 0.15 * diagonal;
    float twinkle = 0.85 + 0.15 * sin(uTime * 2.7 + id * 2.39);
    // Iridescent bodies throw a faint colour into the rays.
    vec3 tint = mix(vec3(1.0, 0.97, 0.92), uRim, 0.25 * uIrid);
    col = tint * star * twinkle * uGlint;
    alpha = clamp(star * uGlint, 0.0, 1.0);
  } else if (kind >= PART_GUT) {
    // The organs, seen through the body: lit through from behind, so their centres glow. Each takes
    // one of the two organ hues by its number (look pass 2), so a body mixes colours inside, and
    // rarer bodies glow brighter from within.
    vec2 n = normal.xy;
    float spot = 1.0 - smoothstep(0.1, 0.32, length(n - vec2(-0.3, 0.35)));
    vec3 tint = tame(hash21(vec2(floor(vUv.x / ORGAN_TAG), 7.31)) < 0.45 ? uOrgan2 : uOrgan);
    vec3 oil = tame(uOil);
    float inner = 1.0 + 0.15 * uVivid;
    if (vUv.y >= HALO_V) {
      // An organ's glow: soft tissue in its colour, fading out to its rim, so neighbouring lobes
      // merge into one coloured mass (references 02 and 03); brighter on rarer bodies.
      float out_ = clamp(vUv.y - HALO_V, 0.0, 1.0);
      float fall = 1.0 - smoothstep(0.2, 1.0, out_);
      col = (kind == PART_DROPLET ? oil : tint) * (0.6 + 0.1 * uVivid);
      alpha = fall * (HALO_ALPHA + 0.12 * uVivid);
    } else if (kind == PART_GUT) {
      col = tame(mix(uOrgan, uOrgan2, 0.35)) * (0.35 + 0.45 * z);
      alpha = 0.3 + 0.35 * z;
    } else if (kind == PART_CHAMBER) {
      // A fluid lobe: a glowing body of colour with a brighter wall, its outer edge soft, so lobes
      // packed side by side read as one organ mass (references 02 and 03).
      col = tint * (0.5 + 0.3 * z + 0.45 * fres) * inner + 0.12 * spot;
      alpha = (0.6 + 0.3 * z) * smoothstep(0.0, 0.25, z);
    } else if (kind == PART_DROPLET) {
      // An oil droplet: amber-leaning lipid with one bright point toward the light.
      col = oil * (0.6 + 0.35 * z) + 0.3 * spot;
      alpha = 0.7 + 0.25 * z;
    } else if (kind == PART_HEART) {
      float beat = 0.85 + 0.15 * sin(uTime * 5.0);
      col = tint * (0.6 + 0.4 * z) * beat * inner;
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
    // with its size on screen; then the wet highlight of the key light.
    // Each costs a neighbourhood search (or noise), so it is skipped while its fade is zero.
    float wallFade = detailFade(DETAIL_CELL, px);
    float poreFade = detailFade(DETAIL_PORE, px);
    float flawFade = detailFade(DETAIL_FLAW, px);
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

  // Dark water (M6 T16): beyond the player's sight in the deep and the abyss the body fades into
  // the fog unless glow lights it, but its rim always stays, so a creature is never invisible.
  col = mix(uRim * (fres * 1.8 + back * 0.9) * uRimStrength, col, uSight);

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
