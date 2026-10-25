import * as THREE from 'three';

// Placeholder title scene until M1: one backlit cell in dark water with drifting particles.
// It also proves that WebGL renders in CI, where Chromium falls back to software (SwiftShader).

const membraneVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const membraneFragment = /* glsl */ `
  uniform vec3 uCore;
  uniform vec3 uRim;
  uniform vec3 uBacklight;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec3 n = normalize(vNormal);
    float facing = max(dot(n, normalize(vView)), 0.0);
    float rim = pow(1.0 - facing, 2.2);
    float back = pow(max(dot(n, normalize(uBacklight)), 0.0), 3.0);
    vec3 color = uCore + uRim * (rim * 1.6 + back * 0.9);
    gl_FragColor = vec4(color, 0.18 + 0.82 * rim);
  }
`;

const flagellumVertex = /* glsl */ `
  uniform float uTime;
  void main() {
    vec3 p = position;
    float reach = clamp((-p.x - 1.4) / 2.8, 0.0, 1.0);
    p.y += sin(p.x * 3.2 + uTime * 7.0) * 0.32 * reach;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const flagellumFragment = /* glsl */ `
  uniform vec3 uColor;
  void main() { gl_FragColor = vec4(uColor, 0.75); }
`;

const particleVertex = /* glsl */ `
  uniform float uTime;
  uniform float uSize;
  uniform vec3 uBox;
  attribute float aSeed;
  varying float vSeed;
  void main() {
    vec3 p = position;
    p.x += uTime * (0.05 + 0.08 * aSeed);
    p.y += sin(uTime * 0.3 + aSeed * 6.2831) * 0.15;
    p.xy = mod(p.xy + uBox.xy * 0.5, uBox.xy) - uBox.xy * 0.5;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uSize * (0.6 + aSeed) / -mv.z;
    vSeed = aSeed;
    gl_Position = projectionMatrix * mv;
  }
`;

const particleFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uBokeh;
  varying float vSeed;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float disc = smoothstep(0.5, 0.42, d);
    float edge = mix(1.0, 0.55 + 0.45 * smoothstep(0.25, 0.47, d), uBokeh);
    float soft = mix(smoothstep(0.5, 0.0, d), disc * edge, uBokeh);
    gl_FragColor = vec4(uColor, soft * uOpacity * (0.5 + 0.5 * vSeed));
  }
`;

const backdropFragment = /* glsl */ `
  varying vec2 vUv;
  void main() {
    float d = distance(vUv, vec2(0.42, 0.58));
    vec3 haze = mix(vec3(0.075, 0.13, 0.135), vec3(0.012, 0.03, 0.035), smoothstep(0.0, 0.75, d));
    gl_FragColor = vec4(haze, 1.0);
  }
`;

const glowFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    float d = distance(vUv, vec2(0.5)) * 2.0;
    float glow = pow(clamp(1.0 - d, 0.0, 1.0), 1.8);
    gl_FragColor = vec4(uColor, glow * uStrength);
  }
`;

const backdropVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

function particleLayer(
  count: number,
  z: number,
  options: { size: number; color: number; opacity: number; bokeh: number },
): THREE.Points {
  const box = new THREE.Vector3(26, 16, 0);
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  // A fixed sequence keeps screenshots comparable between runs.
  let state = 0x9e3779b9 ^ count;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (next() - 0.5) * box.x;
    positions[i * 3 + 1] = (next() - 0.5) * box.y;
    positions[i * 3 + 2] = z + (next() - 0.5) * 0.8;
    seeds[i] = next();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  const material = new THREE.ShaderMaterial({
    vertexShader: particleVertex,
    fragmentShader: particleFragment,
    uniforms: {
      uTime: { value: 0 },
      uSize: { value: options.size },
      uBox: { value: box },
      uColor: { value: new THREE.Color(options.color) },
      uOpacity: { value: options.opacity },
      uBokeh: { value: options.bokeh },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Points(geometry, material);
}

export function startPreview(canvas: HTMLCanvasElement): void {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x04090b);

  const scene = new THREE.Scene();
  // Top-down: the gameplay plane is x–y and the camera looks down the z axis.
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, -1.2, 10);
  camera.lookAt(0, 0.4, 0);

  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 36),
    new THREE.ShaderMaterial({ vertexShader: backdropVertex, fragmentShader: backdropFragment }),
  );
  backdrop.position.z = -8;
  scene.add(backdrop);

  const cell = new THREE.Group();
  const membrane = new THREE.Mesh(
    new THREE.SphereGeometry(1.6, 64, 48),
    new THREE.ShaderMaterial({
      vertexShader: membraneVertex,
      fragmentShader: membraneFragment,
      uniforms: {
        uCore: { value: new THREE.Color(0x06161a) },
        uRim: { value: new THREE.Color(0x8ff2dc) },
        uBacklight: { value: new THREE.Vector3(-0.6, 0.7, -0.4) },
      },
      transparent: true,
      depthWrite: false,
    }),
  );
  membrane.scale.set(1, 0.82, 0.7);
  const glow = (size: number, color: number, strength: number) =>
    new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.ShaderMaterial({
        vertexShader: backdropVertex,
        fragmentShader: glowFragment,
        uniforms: { uColor: { value: new THREE.Color(color) }, uStrength: { value: strength } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
  const halo = glow(10, 0x4fbfae, 0.16);
  halo.position.set(-0.8, 0.9, -1.5);
  const nucleus = glow(1.3, 0x9be6a0, 0.75);
  nucleus.position.set(0.35, 0.18, 0.1);
  const flagellum = new THREE.Mesh(
    new THREE.TubeGeometry(
      new THREE.LineCurve3(new THREE.Vector3(-1.45, 0, 0), new THREE.Vector3(-4.4, 0, 0)),
      96,
      0.035,
      8,
    ),
    new THREE.ShaderMaterial({
      vertexShader: flagellumVertex,
      fragmentShader: flagellumFragment,
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0x9fe8d6) } },
      transparent: true,
    }),
  );
  const organelles = particleLayer(90, 0, { size: 30, color: 0xfff4d6, opacity: 0.9, bokeh: 0 });
  organelles.scale.set(0.09, 0.1, 0.4);
  cell.add(halo, membrane, nucleus, flagellum, organelles);
  scene.add(cell);

  const layers = [
    particleLayer(70, -4, { size: 260, color: 0x7fb8ad, opacity: 0.22, bokeh: 1 }),
    particleLayer(260, 0, { size: 28, color: 0xd8efe8, opacity: 0.7, bokeh: 0 }),
    particleLayer(24, 4.5, { size: 900, color: 0x9ad7c4, opacity: 0.12, bokeh: 1 }),
  ];
  scene.add(...layers);

  const timed = [flagellum, organelles, ...layers].map(
    (mesh) => (mesh.material as THREE.ShaderMaterial).uniforms,
  );

  const resize = () => {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  let frames = 0;
  renderer.setAnimationLoop((ms: number) => {
    const t = ms / 1000;
    for (const uniforms of timed) {
      const time = uniforms.uTime;
      if (time) time.value = t;
    }
    cell.rotation.z = Math.sin(t * 0.2) * 0.25;
    cell.position.y = 0.7 + Math.sin(t * 0.5) * 0.12;
    renderer.render(scene, camera);
    frames += 1;
    canvas.dataset.frames = String(frames);
  });
}
