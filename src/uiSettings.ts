// Applies Settings ▸ Appearance & Behavior ▸ Appearance to the page: UI theme (or the OS's light /
// dark mode), font, zoom, and the switches the stylesheet reads as data-* attributes on <html>.

import { useEffect } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { effectiveTheme, getSettings, saveSettings, themeLook, useSettings, type UiSettings } from './settings';
import { isTauri } from './platform';

export const MIN_ZOOM = 50;
export const MAX_ZOOM = 200;

function apply(ui: UiSettings) {
  const root = document.documentElement;
  const look = themeLook(effectiveTheme(ui));
  root.dataset.uiTheme = look.colors;
  const flag = (name: string, on: boolean) => {
    if (on) root.setAttribute(`data-${name}`, '');
    else root.removeAttribute(`data-${name}`);
  };
  flag('flat', look.flat);
  flag('compact', ui.compact);
  flag('contrast-scrollbars', ui.contrastScrollbars);
  flag('no-menu-icons', !ui.menuIcons);
  flag('indent-guides', ui.indentGuides);
  flag('no-tool-bars', !ui.toolWindowBars);
  flag('tool-names', ui.toolWindowNames);
  flag('no-project-colors', !ui.projectColors);
  root.style.setProperty('--ui-font-size', `${ui.customFont ? ui.fontSize : 13}px`);
  if (ui.customFont && ui.fontFamily.trim()) root.style.setProperty('--sans', `'${ui.fontFamily.trim()}', 'Inter', 'Segoe UI', system-ui, sans-serif`);
  else root.style.removeProperty('--sans');

  // Zoom: the web view's own zoom in the desktop app (like a browser's), CSS zoom otherwise.
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, ui.zoom)) / 100;
  if (isTauri) {
    getCurrentWebview()
      .setZoom(zoom)
      .catch(() => ((root.style as CSSStyleDeclaration & { zoom: string }).zoom = String(zoom)));
  } else {
    (root.style as CSSStyleDeclaration & { zoom: string }).zoom = zoom === 1 ? '' : String(zoom);
  }
}

/** Keeps the page in sync with the UI settings; mount once (App). */
export function useApplyUiSettings() {
  const settings = useSettings();
  useEffect(() => apply(settings.ui), [settings.ui]);

  // Sync with OS: re-apply (and repaint the editor's "Theme default" scheme) when Windows switches.
  useEffect(() => {
    if (!settings.ui.syncOs || !window.matchMedia) return;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const change = () => saveSettings({ ...getSettings() });
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, [settings.ui.syncOs]);
}

/** Alt+Shift+= / Alt+Shift+Minus / Alt+Shift+0: zoom in, out, reset. */
export function zoomBy(step: number | 'reset') {
  const s = getSettings();
  const zoom = step === 'reset' ? 100 : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s.ui.zoom + step));
  if (zoom !== s.ui.zoom) saveSettings({ ...s, ui: { ...s.ui, zoom } });
}
