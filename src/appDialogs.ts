// App-wide dialogs opened from menus (Help ▸ About, Open Source Licenses, Error Log).

import { useSyncExternalStore } from 'react';

export type AppDialog = 'about' | 'licenses' | 'errors' | null;

let current: AppDialog = null;
const listeners = new Set<() => void>();

export function openAppDialog(dialog: AppDialog) {
  current = dialog;
  listeners.forEach((l) => l());
}

export function useAppDialog(): AppDialog {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
