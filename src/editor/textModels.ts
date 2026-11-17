// The documents the editor's own features ask for by address: Ctrl+hover's preview of a declaration,
// the peek references widget. Monaco's built-in service only knows the files open in an editor and
// rejects the rest ("Model not found"); this one reads a file that isn't open from the project and
// lends it under a scratch address of its own (so it never stands in for the file's open model),
// disposed as soon as the feature lets go of it.

import * as monaco from 'monaco-editor';
import { StandaloneServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js';
import { languageOf } from '../php';
import { pathOfUri } from './active';

type Reader = (path: string) => Promise<string>;
let read: Reader | null = null;

/** The open project's file reader (null when no project is open). */
export function setModelFileReader(reader: Reader | null) {
  read = reader;
}

interface Reference {
  object: { textEditorModel: monaco.editor.ITextModel };
  dispose(): void;
}

const lend = (model: monaco.editor.ITextModel, dispose = () => {}): Reference => ({ object: { textEditorModel: model }, dispose });

let loaned = 0;

export const textModelService = {
  async createModelReference(uri: monaco.Uri): Promise<Reference> {
    const open = monaco.editor.getModel(uri);
    if (open) return lend(open);
    const path = pathOfUri(uri);
    // A file that can't be read (deleted since it was indexed) or an address that isn't a file:
    // an empty document, which every feature takes as "nothing to show".
    let text = '';
    if (uri.scheme === 'file' && read) text = await read(path).catch(() => '');
    // Opened in the meantime: that model is the file.
    const opened = monaco.editor.getModel(uri);
    if (opened) return lend(opened);
    const copy = monaco.editor.createModel(text, languageOf(path, text), monaco.Uri.parse(`inmemory://loan/${++loaned}/${encodeURIComponent(path)}`));
    return lend(copy, () => copy.dispose());
  },
};

// Before the first editor exists: Monaco takes overrides for services it hasn't created yet.
StandaloneServices.initialize({ textModelService });
