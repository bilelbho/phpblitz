import { Icon, type IconName } from './Icon';

export interface StripItem {
  id: string;
  label: string;
  icon: IconName;
  active: boolean;
  dot?: boolean;
  count?: number;
  /** Draw a separator line above this item. */
  sepBefore?: boolean;
}

interface Props {
  side: 'left' | 'right';
  items: StripItem[];
  /** Items pinned to the bottom of the strip (bottom tool windows). */
  bottomItems?: StripItem[];
  onPick: (id: string) => void;
}

export function ToolStrip({ side, items, bottomItems, onPick }: Props) {
  const button = (item: StripItem) => (
    <span key={item.id} style={{ display: 'contents' }}>
      {item.sepBefore && <span className="strip-sep" />}
      <button
        type="button"
        className={'strip-btn' + (item.active ? ' active' : '')}
        aria-label={item.label}
        aria-pressed={item.active}
        title={item.label}
        onClick={() => onPick(item.id)}
      >
        <Icon name={item.icon} size={17} strokeWidth={1.8} />
        {item.dot && <span className="strip-dot" />}
        {!!item.count && <span className="strip-count">{item.count > 9 ? '9+' : item.count}</span>}
      </button>
    </span>
  );

  return (
    <nav className={`strip ${side}`} aria-label={side === 'left' ? 'Tool windows' : 'Right tool windows'}>
      {items.map(button)}
      {bottomItems && (
        <>
          <span className="grow" />
          {bottomItems.map(button)}
        </>
      )}
    </nav>
  );
}
