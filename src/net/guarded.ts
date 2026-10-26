/** Runs a listener so that one that throws cannot stop the others or the receive path. */
export function guarded(run: () => void): void {
  try {
    run();
  } catch {
    // The listener's bug is its own: the next listener and the next message still run.
  }
}
