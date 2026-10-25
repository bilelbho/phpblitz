// Window ▸ Layouts ▸ Save Current Layout As… / Rename: the preset's name.

import { useEffect, useRef, useState } from 'react';
import { focusPresets, openPresetDialog, renameFocusPreset, saveFocusPreset, type PresetDialog } from '../focusLayouts';
import type { FocusState } from '../toolLayout';

export function FocusPresetDialog({ dialog, layout }: { dialog: NonNullable<PresetDialog>; layout: FocusState }) {
  const [name, setName] = useState(dialog.mode === 'rename' ? dialog.from : '');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const close = () => openPresetDialog(null);
  const trimmed = name.trim();
  /** Another preset of that name: saving replaces it. */
  const replaces = focusPresets().some((p) => p.name.toLowerCase() === trimmed.toLowerCase() && (dialog.mode === 'save' || p.name !== dialog.from));

  const submit = () => {
    if (!trimmed) return;
    if (dialog.mode === 'save') saveFocusPreset(trimmed, layout);
    else if (trimmed !== dialog.from) renameFocusPreset(dialog.from, trimmed);
    close();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="pb-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preset-title"
        style={{ width: 380 }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
          if (e.key === 'Enter') submit();
        }}
      >
        <div className="pb-dialog-title" id="preset-title">
          {dialog.mode === 'save' ? 'Save Current Layout As' : 'Rename Layout'}
        </div>
        <div className="pb-dialog-body">
          <label htmlFor="preset-name">Name:</label>
          <div className="field">
            <input id="preset-name" ref={input} value={name} placeholder="Debugging, Database work…" onChange={(e) => setName(e.target.value)} />
          </div>
          {replaces && <span className="muted" style={{ fontSize: 12 }}>Replaces the layout of that name.</span>}
        </div>
        <div className="pb-dialog-buttons">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!trimmed} onClick={submit}>
            {dialog.mode === 'save' ? 'Save' : 'Rename'}
          </button>
        </div>
      </div>
    </div>
  );
}
