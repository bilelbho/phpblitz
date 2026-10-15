import { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { AI_SUGGESTIONS } from '../mock';
import { baseName } from '../backend/types';

export function AiPanel({ ws }: { ws: Workspace }) {
  const [input, setInput] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [ws.aiMessages]);

  const send = (text: string) => {
    ws.askAi(text);
    setInput('');
  };

  return (
    <>
      <div className="panel-body">
        <div className="chat">
          {ws.aiMessages.length === 0 && <div className="muted">Ask about the open file or the project. Replies are mocked for now.</div>}
          {ws.aiMessages.map((m, i) => (
            <div key={i} className={`msg ${m.who}`}>
              <span className="who">{m.who === 'you' ? 'You' : 'Assistant'}</span>
              <div className="bubble">{m.text}</div>
              {m.code && <pre>{m.code}</pre>}
            </div>
          ))}
          <div ref={end} />
        </div>
      </div>
      <div className="panel-foot">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {AI_SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="suggestion" onClick={() => send(s)}>
              {s}
            </button>
          ))}
        </div>
        <label htmlFor="ai-input" className="sr-only">
          Ask the AI Assistant
        </label>
        <textarea
          id="ai-input"
          className="textarea"
          rows={3}
          placeholder="Ask about this project… (Enter to send)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="muted" style={{ fontSize: 11.5 }}>
            Context: {ws.activePath ? baseName(ws.activePath) : 'whole project'}
          </span>
          <span className="grow" />
          <button type="button" className="btn primary" onClick={() => send(input)} disabled={!input.trim()}>
            Send
          </button>
        </div>
      </div>
    </>
  );
}
