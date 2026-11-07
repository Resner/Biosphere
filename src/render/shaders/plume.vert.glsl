varying vec2 vP;
varying float vPhase;
// The quad's half-size in wu (the plume's radius), for the plume's rim (M11 T17).
varying float vSize;

void main() {
  vP = position.xy;
  vSize = length(instanceMatrix[0].xy);
  vPhase = instanceMatrix[2][2];
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position.xy, 0.0, 1.0);
}
