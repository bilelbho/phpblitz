// The Hide button of a tool window closes the place it is open in: the bottom panel, or the side
// column it was dragged to. Tool windows read it here instead of assuming the bottom panel.

import { createContext, useContext } from 'react';

export const ToolHideContext = createContext<(() => void) | null>(null);

/** The tool window's Hide action; `fallback` when it isn't inside a ToolHideContext. */
export function useHideTool(fallback: () => void): () => void {
  return useContext(ToolHideContext) ?? fallback;
}
