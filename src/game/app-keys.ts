import type { App } from './app';
import { fightKey } from './engage';
import { enterHatches } from './input';

/** A click this close (in CSS pixels) to a creature's centre picks it, however small it is drawn. */
const INSPECT_MIN_PX = 24;

/** The canvas's pointer: the player's egg, and a click that inspects another creature. */
export function attachPointer(app: App): void {
  const { canvas, controller, eggs, scene } = app;
  // The player's egg answers the pointer (M6b T11, M6c T11). A click on an egg that waits, or on a
  // genesis or hatch egg that waits for its crack, pokes it: a wobble and more charge, and a held
  // button or three quick clicks crack it. In the still scene the egg is the moment, so a click
  // anywhere counts. A click on a mating's stirring or cracking egg skips to the burst.
  canvas.addEventListener('pointerdown', (e) => {
    const { eggAt, eggOnScreen } = app.frame;
    if (e.button !== 0 || !eggOnScreen || controller.typing) return;
    const rect = canvas.getBoundingClientRect();
    const on =
      Math.hypot(e.clientX - rect.left - eggAt.x, e.clientY - rect.top - eggAt.y) <= eggAt.r;
    const now = app.eggClock();
    const { phase, paced } = eggs.reveal;
    if (phase === 'waiting' || (paced && phase === 'stirring')) {
      if (on || eggs.still()) eggs.poke(now);
    } else if (!paced && (on || (eggs.mode === 'genesis' && !app.playing()))) {
      eggs.skip(now);
    }
  });
  const lift = (e: PointerEvent): void => {
    if (e.button === 0) eggs.lift();
  };
  window.addEventListener('pointerup', lift);
  window.addEventListener('pointercancel', lift);
  // A release missed while the window lost focus must not leave the hold running.
  window.addEventListener('blur', () => eggs.lift());
  canvas.addEventListener('click', (e) => {
    if (!app.playing() || !app.session.player.alive || controller.typing) return;
    const rect = canvas.getBoundingClientRect();
    const at = app.worldAt(e.clientX - rect.left, e.clientY - rect.top);
    // In a fight a click on a fighter or an egg targets it (M7 T15).
    if (app.fight.pickTarget(at.x, at.y, INSPECT_MIN_PX / scene.pxPerWu)) return;
    let best = Number.POSITIVE_INFINITY;
    app.inspected = null;
    for (const r of app.remoteViews) {
      if (r.alpha < 0.5) continue;
      const gap = Math.hypot(r.x - at.x, r.y - at.y);
      if (gap > Math.max(r.radius, INSPECT_MIN_PX / scene.pxPerWu) || gap >= best) continue;
      best = gap;
      app.inspected = r.id;
    }
  });
}

/**
 * Enter hatches from the title and death screens (Space stays the dash key). Enter opens the chat
 * input while playing. G (the wheel), T then 1-6 and the middle button are social keys.
 */
export function attachKeys(app: App): void {
  const { controller, eggs, lineagePanel, settingsPanel, wheel, scene, pondMap, menu, mate } = app;
  const { social, screens } = app;
  controller.attach(
    window,
    document,
    () => {
      if (lineagePanel.isOpen || settingsPanel.isOpen) return;
      // Enter during a genesis or hatch egg's stir or crack cracks it and skips to the burst
      // (M6b T11, M6c T11); during a hatch it does not open the chat.
      if (eggs.still() && (eggs.skip(app.eggClock()) || app.playing())) return;
      if (app.playing()) app.socialUi.open();
      else if (enterHatches(app.screen, performance.now() - app.screenShownAt)) {
        const first = screens.firstOption;
        if (first) app.life.become(first);
        else app.life.hatch();
      }
    },
    {
      key: (key, at) => {
        if (settingsPanel.isOpen) {
          if (key === 'Escape') settingsPanel.close();
          return;
        }
        if (lineagePanel.isOpen) {
          if (key === 'Escape') lineagePanel.close();
          return;
        }
        // Space pokes a genesis egg on the title or death screen (M6b T11, M6c T11); in play it dashes.
        if (key === ' ' && eggs.mode === 'genesis' && !app.playing()) eggs.poke(app.eggClock());
        if (!app.playing()) return;
        // While the wheel is open, Esc and the numbers are its own.
        if (wheel.isOpen && key === 'Escape') {
          wheel.cancel();
          return;
        }
        if (wheel.pick(key)) return;
        // F engages; while locked, 1-3 set the stance and Shift braces (M7 T11).
        if (app.attack.key(key)) return;
        if (key === 'g' || key === 'G') {
          const cursor = controller.pointerAt() ?? { x: scene.width / 2, y: scene.height / 2 };
          const view = { width: scene.width, height: scene.height };
          wheel.press(cursor, app.worldAt(cursor.x, cursor.y), view, at);
          return;
        }
        if ((key === 'h' || key === 'H') && app.offspring.child()) {
          app.life.become('child');
          return;
        }
        if (key === 'm' || key === 'M') pondMap.toggle();
        if (key === 'Escape' && pondMap.isOpen) {
          pondMap.close();
        } else if (key === 'Escape' && menu.isOpen) {
          menu.close();
        } else if (mate.view().state === 'invited') {
          if (key === 'e' || key === 'E') mate.accept();
          else if (key === 'Escape') mate.decline();
        } else if (key === 'Escape' && app.inspected) {
          app.inspected = null;
        } else if (key === 'Escape') {
          menu.open();
        } else if ((key === 'e' || key === 'E') && app.nearby) {
          mate.court(app.nearby.id);
        }
        social.key(key, app.selfKey());
      },
      keyUp: (key, at) => {
        if (key === ' ') eggs.lift();
        if (key === 'g' || key === 'G') wheel.release(controller.pointerAt(), at);
      },
      // A quick "look" ping.
      middle: (x, y) => {
        if (app.playing()) social.ping(app.worldAt(x, y), app.selfKey(), 0);
      },
      // Tab cycles the target in a fight instead of moving the browser's focus.
      holds: (key) =>
        app.fight.fighting && app.playing() && fightKey(key, true, false)?.t === 'target',
    },
  );
}
