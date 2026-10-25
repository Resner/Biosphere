import { readFileSync } from 'node:fs';

/** The release version from the `VERSION` file, as a `define` for `__VERSION__`. */
export function versionDefine(): Record<string, string> {
  const version = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
  return { __VERSION__: JSON.stringify(version) };
}
