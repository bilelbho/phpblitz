// Options of the Project tool window (⋮ menu), remembered between sessions.

import { useCallback, useState } from 'react';

export interface TreePrefs {
  /** Behavior ▸ Enable Preview Tab: a single click shows the file in a reusable preview tab. */
  previewTab: boolean;
  /** Behavior ▸ Open Files with Single Click. */
  singleClickOpen: boolean;
  /** Behavior ▸ Open Directories with Single Click. */
  singleClickDirs: boolean;
  /** Behavior ▸ Always Select Opened File: follow the active editor in the tree. */
  alwaysSelect: boolean;
  /** Appearance ▸ Folders Always on Top. */
  foldersFirst: boolean;
  /** Appearance ▸ Show Project Path next to the root. */
  showPath: boolean;
  sortBy: 'name' | 'type' | 'modified';
  /** Project ▾ view: the whole project, open files, or files changed in Git. */
  view: 'project' | 'open' | 'changed';
}

/** The defaults. */
const DEFAULTS: TreePrefs = {
  previewTab: false,
  singleClickOpen: false,
  singleClickDirs: false,
  alwaysSelect: true,
  foldersFirst: true,
  showPath: true,
  sortBy: 'name',
  view: 'project',
};

const KEY = 'phpblitz.projectView';

function load(): TreePrefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

export function useTreePrefs(): [TreePrefs, (patch: Partial<TreePrefs>) => void] {
  const [prefs, setPrefs] = useState(load);
  const update = useCallback((patch: Partial<TreePrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Not persisted when storage is unavailable; the options still apply for this session.
      }
      return next;
    });
  }, []);
  return [prefs, update];
}
