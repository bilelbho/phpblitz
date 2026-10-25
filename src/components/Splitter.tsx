import { useState } from 'react';

/** A 1px divider that can be dragged to resize the panel next to it. `onStart`: once, as a drag starts. */
export function Splitter({ dir, onDrag, onStart }: { dir: 'v' | 'h'; onDrag: (delta: number) => void; onStart?: () => void }) {
  const [dragging, setDragging] = useState(false);

  const start = (e: React.MouseEvent) => {
    e.preventDefault();
    onStart?.();
    let last = dir === 'v' ? e.clientX : e.clientY;
    setDragging(true);
    document.body.style.cursor = dir === 'v' ? 'col-resize' : 'row-resize';
    const move = (ev: MouseEvent) => {
      const pos = dir === 'v' ? ev.clientX : ev.clientY;
      onDrag(pos - last);
      last = pos;
    };
    const up = () => {
      setDragging(false);
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div
      className={`splitter ${dir}${dragging ? ' dragging' : ''}`}
      onMouseDown={start}
      role="separator"
      aria-orientation={dir === 'v' ? 'vertical' : 'horizontal'}
    />
  );
}
