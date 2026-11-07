// A test switch (`?gpu=watch`, M11 T11): wraps the WebGL context's float uploads (uniforms and
// vertex buffers) and keeps the largest magnitude sent, with the uniform's name, so a scenario can
// check that every position and world-space uniform stays near the floating origin. Off by default:
// the wrappers cost a scan of every float uploaded.

export interface GpuExtent {
  /** The largest |value| of any float uniform or float vertex buffer uploaded so far. */
  max: number;
  /** The uniform that sent it (`buffer` for vertex data). */
  name: string;
  /** Float uploads seen. */
  uploads: number;
}

type Floats = ArrayLike<number>;

const UNIFORM_SCALARS = ['uniform1f', 'uniform2f', 'uniform3f', 'uniform4f'] as const;
const UNIFORM_ARRAYS = ['uniform1fv', 'uniform2fv', 'uniform3fv', 'uniform4fv'] as const;
const UNIFORM_MATRICES = ['uniformMatrix2fv', 'uniformMatrix3fv', 'uniformMatrix4fv'] as const;

/** Starts watching `gl`'s float uploads; returns what has been seen so far, on each call. */
export function watchGpu(gl: WebGL2RenderingContext): () => GpuExtent {
  const extent: GpuExtent = { max: 0, name: '', uploads: 0 };
  const names = new WeakMap<WebGLUniformLocation, string>();
  const seen = (values: Floats, name: string, from = 0, count = values.length - from): void => {
    extent.uploads++;
    for (let i = from; i < from + count; i++) {
      const v = Math.abs(values[i] as number);
      if (v > extent.max) {
        extent.max = v;
        extent.name = name;
      }
    }
  };
  const nameOf = (location: WebGLUniformLocation | null): string =>
    (location && names.get(location)) ?? 'uniform';
  const target = gl as unknown as Record<string, (...args: unknown[]) => unknown>;
  const wrap = (key: string, before: (args: unknown[]) => void): void => {
    const original = (target[key] as (...args: unknown[]) => unknown).bind(gl);
    target[key] = (...args: unknown[]) => {
      before(args);
      return original(...args);
    };
  };
  const getLocation = gl.getUniformLocation.bind(gl);
  target.getUniformLocation = (...args: unknown[]) => {
    const location = getLocation(args[0] as WebGLProgram, args[1] as string);
    if (location) names.set(location, args[1] as string);
    return location;
  };
  for (const key of UNIFORM_SCALARS) {
    wrap(key, (args) => seen(args.slice(1) as number[], nameOf(args[0] as WebGLUniformLocation)));
  }
  for (const key of UNIFORM_ARRAYS) {
    wrap(key, (args) => seen(args[1] as Floats, nameOf(args[0] as WebGLUniformLocation)));
  }
  for (const key of UNIFORM_MATRICES) {
    wrap(key, (args) => seen(args[2] as Floats, nameOf(args[0] as WebGLUniformLocation)));
  }
  const buffer = (data: unknown, offset: unknown, length: unknown): void => {
    if (!(data instanceof Float32Array)) return;
    const from = typeof offset === 'number' ? offset : 0;
    const count = typeof length === 'number' && length > 0 ? length : data.length - from;
    seen(data, 'buffer', from, count);
  };
  wrap('bufferData', (args) => buffer(args[1], args[3], args[4]));
  wrap('bufferSubData', (args) => buffer(args[2], args[3], args[4]));
  return () => ({ ...extent });
}
