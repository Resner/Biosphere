// Size outlines (M6 T21). A bigger creature: a broken ring of 8 dashes, about 2 px wide, that
// swells and brightens with the pulse. A smaller one: 16 faint dots that hold still. Line widths
// are in screen pixels (`fwidth`), so the ring reads the same at any zoom; a dark halo keeps it
// readable over the bright shallows.
uniform float uRing;
varying vec2 vP;
varying float vPhase;
varying float vAlpha;

const float TAU = 6.2831853;
const float DASHES = 8.0;
const float DOTS = 16.0;

void main() {
  float d = length(vP);
  float px = max(fwidth(d), 1e-5);
  float kind = floor(vPhase + 0.001);
  float pulse = vPhase - kind;
  float turn = atan(vP.y, vP.x) / TAU + 0.5;
  float core;
  float halo;
  vec3 col;
  float strength;
  if (kind > 0.5) {
    float r = uRing * (1.0 + 0.035 * pulse);
    float off = abs(d - r) / px;
    float w = 1.0 + 0.6 * pulse;
    // Along the ring, in pixels from the start of this dash's cell; the dash fills 60% of it.
    float cell = TAU * r / DASHES / px;
    float along = fract(turn * DASHES) * cell;
    float dash = smoothstep(0.0, 1.0, along) * (1.0 - smoothstep(0.6 * cell - 1.0, 0.6 * cell, along));
    core = (1.0 - smoothstep(w - 0.5, w + 0.5, off)) * dash;
    halo = (1.0 - smoothstep(w + 1.0, w + 2.5, off)) * dash;
    col = vec3(1.0, 0.62, 0.42);
    strength = 0.75 + 0.25 * pulse;
  } else {
    float cell = TAU * uRing / DOTS / px;
    float along = (fract(turn * DOTS) - 0.5) * cell;
    float off = length(vec2(along, (d - uRing) / px));
    core = 1.0 - smoothstep(0.9, 1.9, off);
    halo = 1.0 - smoothstep(2.0, 3.2, off);
    col = vec3(0.78, 0.93, 1.0);
    strength = 0.5;
  }
  float line = core * strength;
  float cover = max(line, halo * 0.35);
  if (cover <= 0.0) discard;
  // A bright core over a dark halo: the shade follows how much of the cover is line.
  gl_FragColor = vec4(mix(vec3(0.01, 0.03, 0.04), col, line / cover), cover * vAlpha);
}
