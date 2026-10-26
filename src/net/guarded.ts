/** Runs a listener so that one that throws cannot stop the others or the receive path. */
export function guarded(run: () => void): void {
  try {
    run();
  } catch (err) {
    console.error('listener threw', err);
  }
}
