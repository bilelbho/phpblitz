// A read-only editor for text the app shows (responses, inspect output): syntax colors, search
// (Ctrl+F), folding for long JSON.

import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';

/** A read-only editor: syntax colors, search (Ctrl+F), folding for long JSON. */
export function CodeView({ text, language }: { text: string; language: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const model = monaco.editor.createModel(text, language);
    const editor = monaco.editor.create(host.current, {
      model,
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbers: 'off',
      folding: true,
      wordWrap: 'on',
      contextmenu: false,
      renderLineHighlight: 'none',
      fontSize: 12.5,
    });
    return () => {
      editor.dispose();
      model.dispose();
    };
  }, [text, language]);
  return <div ref={host} className="http-code" />;
}
