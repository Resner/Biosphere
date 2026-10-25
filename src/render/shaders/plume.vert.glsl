varying vec2 vP;
varying float vPhase;

void main() {
  vP = position.xy;
  vPhase = instanceMatrix[2][2];
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position.xy, 0.0, 1.0);
}
