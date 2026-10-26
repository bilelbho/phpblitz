// The Hide button of a tool window closes the place it is open in: the bottom panel, or the side
// column it was dragged to. Tool windows read it here instead of assuming the bottom panel.
// In a column of the Focus layout the button closes the column, with Maximize next to it.

import { createContext, useContext } from 'react';
import { Icon } from './Icon';

export const ToolHideContext = createContext<(() => void) | null>(null);

/** A column of the Focus layout: maximized over the editor or not. */
export const ToolColumnContext = createContext<{ maximized: boolean; toggleMaximized: () => void } | null>(null);

/** The tool window's Hide action; `fallback` when it isn't inside a ToolHideContext. */
export function useHideTool(fallback: () => void): () => void {
  return useContext(ToolHideContext) ?? fallback;
}

/** The buttons at the right end of a tool window's header: Hide (Close in a column), and Maximize in a column. */
export function HideToolButton({ onHide, label = 'tool window' }: { onHide: () => void; label?: string }) {
  const column = useContext(ToolColumnContext);
  // "Close Project" would read like File ▸ Close Project: "Close Project panel".
  const name = label === 'tool window' ? label : `${label} panel`;
  return (
    <>
      {column && (
        <button
          type="button"
          className="icon-btn small"
          aria-label={column.maximized ? `Restore ${name}` : `Maximize ${name}`}
          aria-pressed={column.maximized}
          title={column.maximized ? 'Restore' : 'Maximize'}
          onClick={column.toggleMaximized}
        >
          <Icon name={column.maximized ? 'restore' : 'maximize'} size={14} />
        </button>
      )}
      <button type="button" className="icon-btn small" aria-label={`${column ? 'Close' : 'Hide'} ${name}`} title={column ? 'Close' : 'Hide'} onClick={onHide}>
        <Icon name={column ? 'close' : 'minus'} size={14} />
      </button>
    </>
  );
}
