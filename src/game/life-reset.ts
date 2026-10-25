export interface LifeResetHooks {
  /** The loop's speed multiplier; 1 is real time. */
  setSpeed(speed: number): void;
  /** Closes the chat input and releases the keyboard back to steering. */
  closeChat(): void;
}

/**
 * Runs whenever a life ends or a session starts (local, title or a new pond). A slew factor belongs
 * to the pond clock it chases, and an open chat input would swallow the Enter that hatches again.
 */
export function resetLife(hooks: LifeResetHooks): void {
  hooks.setSpeed(1);
  hooks.closeChat();
}
