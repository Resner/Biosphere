// The title screen's Recovery code panel (M4 T11): show and copy the code, or import one to take
// over another creature line. The code is read only when the player opens the panel.

import { pick } from './dom';

const REMINDER_FLAG = 'bs-recovery-seen';

export interface RecoveryHandlers {
  /** The recovery code of this browser's identity. */
  code(): string;
  /** Replaces the identity with the one `code` names; rejects when the code is not valid. */
  replace(code: string): Promise<void>;
}

/** Whether the code has been revealed before; without storage the reminder just stays. */
function seenBefore(): boolean {
  try {
    return localStorage.getItem(REMINDER_FLAG) === '1';
  } catch {
    return false;
  }
}

function rememberSeen(): void {
  try {
    localStorage.setItem(REMINDER_FLAG, '1');
  } catch {
    // The page works without storage.
  }
}

export class RecoveryPanel {
  private readonly panel = pick('[data-testid="recovery"]');
  private readonly code = pick<HTMLButtonElement>('[data-testid="recovery-code"]');
  private readonly copied = pick('[data-testid="recovery-copied"]');
  private readonly input = pick<HTMLInputElement>('[data-testid="recovery-input"]');
  private readonly confirm = pick('[data-testid="recovery-confirm"]');
  private readonly error = pick('[data-testid="recovery-error"]');
  private readonly opener = pick('[data-testid="recovery-open"]');
  private readonly reminder = pick('[data-testid="recovery-reminder"]');
  private readonly importButton = pick<HTMLButtonElement>('[data-testid="recovery-import"]');

  constructor(private readonly handlers: RecoveryHandlers) {
    this.reminder.hidden = seenBefore();
    this.opener.addEventListener('click', () => this.open());
    pick('[data-testid="recovery-close"]').addEventListener('click', () => this.close());
    this.code.addEventListener('click', () => this.reveal());
    pick('[data-testid="recovery-copy"]').addEventListener('click', () => void this.copy());
    this.importButton.addEventListener('click', () => this.ask());
    pick('[data-testid="recovery-no"]').addEventListener('click', () => {
      this.confirm.hidden = true;
    });
    pick('[data-testid="recovery-yes"]').addEventListener('click', () => void this.replace());
    this.input.addEventListener('input', () => {
      this.error.hidden = true;
      this.confirm.hidden = true;
    });
    // Leaving the title screen closes the panel, so the code never stays in the page during play.
    new MutationObserver(() => {
      if (document.body.dataset.screen !== 'title') this.close();
    }).observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });
    // Typing here must not hatch (Enter) or steer; Enter imports and Escape closes instead.
    this.panel.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
      else if (e.key === 'Enter' && e.target === this.input) {
        e.preventDefault();
        this.ask();
      }
    });
  }

  /** Hides the button and the reminder where an import could not last (no storage). */
  disable(): void {
    this.reminder.hidden = true;
    this.opener.hidden = true;
  }

  private open(): void {
    this.panel.hidden = false;
    this.code.textContent = this.handlers.code();
    this.code.dataset.revealed = 'false';
    this.copied.hidden = true;
    this.confirm.hidden = true;
    this.error.hidden = true;
    this.input.value = '';
    this.code.focus();
  }

  private close(): void {
    this.panel.hidden = true;
    // The code leaves the page with the panel.
    this.code.textContent = '';
  }

  private reveal(): void {
    this.code.dataset.revealed = 'true';
    this.reminder.hidden = true;
    rememberSeen();
  }

  private async copy(): Promise<void> {
    this.reveal();
    try {
      await navigator.clipboard.writeText(this.handlers.code());
      this.copied.textContent = 'Copied';
    } catch {
      this.copied.textContent = 'Could not copy: select the code and copy it';
    }
    this.copied.hidden = false;
  }

  private ask(): void {
    this.error.hidden = true;
    if (this.input.value.trim() === '') return;
    this.confirm.hidden = false;
  }

  private async replace(): Promise<void> {
    this.confirm.hidden = true;
    this.importButton.disabled = true;
    try {
      await this.handlers.replace(this.input.value);
      // The page reloads with the new identity; nothing else to do here.
    } catch {
      this.error.hidden = false;
      this.importButton.disabled = false;
    }
  }
}
