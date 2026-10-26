import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from '../platform';
import { Icon } from './Icon';

/** Minimize / maximize / close for the frameless window (the title bar is our toolbar). */
export function WindowControls() {
  const maximized = useMaximized();
  if (!isTauri) return null;
  const win = getCurrentWindow();
  return (
    <div className="win-controls">
      <button type="button" className="win-btn" aria-label="Minimize" onClick={() => win.minimize()}>
        <Icon name="winMin" size={14} />
      </button>
      <button type="button" className="win-btn" aria-label={maximized ? 'Restore' : 'Maximize'} title={maximized ? 'Restore Down' : 'Maximize'} onClick={() => win.toggleMaximize()}>
        <Icon name={maximized ? 'winRestore' : 'winMax'} size={12} />
      </button>
      <button type="button" className="win-btn close" aria-label="Close" onClick={() => win.close()}>
        <Icon name="winClose" size={14} />
      </button>
    </div>
  );
}

/** Whether the window is maximized, following resizes (double-click on the title bar, snapping). */
function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!isTauri) return;
    const win = getCurrentWindow();
    const read = () => void win.isMaximized().then(setMaximized, () => {});
    read();
    const stop = win.onResized(read);
    return () => void stop.then((f) => f());
  }, []);
  return maximized;
}

/** Stable color per project name, for the colored project widget. */
export function projectColor(name: string): string {
  const palette = ['#3d7a4b', '#3574f0', '#9b5fc0', '#c2803a', '#2a8f96', '#c25863', '#5b7cc2', '#7d8f2e'];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}
