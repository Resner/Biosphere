// The water is a grid over the screen (M6 T16): each vertex looks up the zone under it (the depth
// map, `zoneDepth`), and the fragments interpolate its look, which is far cheaper than a lookup
// per pixel. A zone feature spans thousands of wu, so the grid (water.ts) is fine enough at any zoom.
uniform vec2 uCam;
uniform vec2 uHalf;
varying vec2 vNdc;
// The zone's trough and haze colours, and its fog and caustic strengths.
varying vec3 vLow;
varying vec3 vHaze;
varying vec2 vZone;

void main() {
  vNdc = position.xy;
  vec4 zone = zoneWeights(zoneDepth(uCam + position.xy * uHalf));
  vLow = zoneMix(zone, ZONE_WATER_0, ZONE_WATER_1, ZONE_WATER_2, ZONE_WATER_3);
  vHaze = zoneMix(zone, ZONE_HAZE_0, ZONE_HAZE_1, ZONE_HAZE_2, ZONE_HAZE_3);
  vZone = vec2(dot(zone, ZONE_DARK), dot(zone, ZONE_CAUSTIC));
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
