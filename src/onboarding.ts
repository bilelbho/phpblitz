// The onboarding screen (components/Onboarding.tsx): shown once, on the first launch, and again from
// Help ▸ Onboarding or the welcome screen's Customize.

const KEY = 'phpblitz.onboarded';

/** True on the first launch. People who used PHPBlitz before onboarding existed don't get it. */
export function needsOnboarding(): boolean {
  try {
    if (localStorage.getItem(KEY)) return false;
    const usedBefore = localStorage.getItem('phpblitz.settings') !== null || JSON.parse(localStorage.getItem('phpblitz.recentProjects') ?? '[]').length > 0;
    if (usedBefore) {
      localStorage.setItem(KEY, '1');
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function finishOnboarding() {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    // Shown again next time: no harm.
  }
}

/** Help ▸ Onboarding: App shows the screen when this event fires. */
export const OPEN_ONBOARDING = 'phpblitz:onboarding';
export const openOnboarding = () => window.dispatchEvent(new Event(OPEN_ONBOARDING));
