// The composite onto the canvas: radial chromatic aberration (CHROMATIC), god rays (M6 T17,
// godrays.glsl) where the sunlight reaches, bloom added back, the
// grade (a teal lift in the shadows and a filmic shoulder that keeps highlights neutral), the
// vignette and animated film grain (GRAIN). The scene's shaders write display values, so nothing
// here converts colour spaces.
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uBloom;
/** Width over height, so the vignette and the aberration are round. */
uniform float uAspect;
uniform float uVignette;
uniform vec3 uLift;
uniform float uKnee;
uniform float uChromatic;
uniform float uGrain;
uniform float uSeed;
/** The god rays' strength (0: none), the view's centre and half size in wu, and their clock. */
uniform float uRays;
uniform vec2 uRayCam;
uniform vec2 uRayHalf;
uniform float uRayTime;
varying vec2 vUv;

/** The shafts' colour at full strength: a pale, sunlit cyan. */
const vec3 RAY_LIGHT = vec3(0.22, 0.34, 0.31);

vec3 sceneAt(vec2 uv) {
#ifdef CHROMATIC
  // Red is sampled further out and blue further in, more strongly towards the frame edge.
  vec2 d = uv - 0.5;
  vec2 rd = d * vec2(uAspect, 1.0);
  vec2 shift = d * dot(rd, rd) * uChromatic;
  return vec3(
    texture2D(tScene, uv + shift).r,
    texture2D(tScene, uv).g,
    texture2D(tScene, uv - shift).b
  );
#else
  return texture2D(tScene, uv).rgb;
#endif
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

void main() {
  vec3 c = sceneAt(vUv);
  // Light in the water between the camera and the plane: over the water and the bodies alike.
  if (uRays > 0.0) c += RAY_LIGHT * (godRays(uRayCam + (vUv * 2.0 - 1.0) * uRayHalf, uRayTime) * uRays);
#ifdef BLOOM
  c += texture2D(tBloom, vUv).rgb * uBloom;
#endif

  // Grade: the shadows lean teal and the highlights roll off towards white, never past it.
  float luma = dot(c, LUMA);
  c += uLift * (1.0 - smoothstep(0.0, 0.3, luma));
  vec3 over = max(c - uKnee, 0.0);
  c = min(c, vec3(uKnee)) + (1.0 - uKnee) * (1.0 - exp(-over / (1.0 - uKnee)));

  vec2 r = (vUv - 0.5) * vec2(uAspect, 1.0);
  float corner = length(vec2(uAspect, 1.0) * 0.5);
  c *= 1.0 - uVignette * smoothstep(0.3, 1.0, length(r) / corner);

#ifdef GRAIN
  // Strongest in the mid-tones: the dark water stays clean and glows fade out smoothly.
  float grain = uGrain * smoothstep(0.02, 0.4, dot(c, LUMA));
  c += (hash12(gl_FragCoord.xy + uSeed) - 0.5) * grain;
#endif
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
