const PAGES_ORIGIN = 'https://resner.github.io';
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/** The Pages site and local development are the only browser origins the Worker serves. */
export function isAllowedOrigin(origin: string): boolean {
  return origin === PAGES_ORIGIN || LOCAL_ORIGIN.test(origin);
}
