// A dialog takes the keyboard focus when it opens (unless one of its fields already has it), so
// Escape, Tab and screen readers reach it even when it was opened from a menu; when it closes,
// the focus goes back to where it was. Put the ref on the element with role="dialog" (tabIndex -1).

import { useEffect, useRef } from 'react';

export function useDialogFocus<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    // The dialog closed: the focus goes back (to the editor, a tree row…) if that is still there.
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return ref;
}
