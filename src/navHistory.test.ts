import { beforeEach, describe, expect, it } from 'vitest';
import { caretMoved, edited, fileShown, goBack, goForward, recentPlaces, resetHistory, tabClosed, takeClosed, type Place } from './navHistory';

const at = (path: string, line: number): Place => ({ path, line, column: 1 });

/** Back / Forward, with the caret arriving where it was sent (as the editor does). */
function go(fn: typeof goBack): Place | null {
  let to: Place | null = null;
  fn((p) => {
    to = p;
    caretMoved(p);
  });
  return to;
}

beforeEach(resetHistory);

describe('Back and Forward', () => {
  it('remembers jumps, not small moves', () => {
    caretMoved(at('a.php', 10));
    caretMoved(at('a.php', 11)); // arrow key
    caretMoved(at('a.php', 13)); // typing
    caretMoved(at('b.php', 40)); // Go to Declaration
    caretMoved(at('b.php', 200)); // a usage far down
    expect(go(goBack)).toEqual(at('b.php', 40));
    expect(go(goBack)).toEqual(at('a.php', 13));
    expect(go(goBack)).toBeNull();
    expect(go(goForward)).toEqual(at('b.php', 40));
    expect(go(goForward)).toEqual(at('b.php', 200));
    expect(go(goForward)).toBeNull();
  });

  it("switching tabs is a jump, to where that file's caret was", () => {
    caretMoved(at('a.php', 22));
    caretMoved(at('a.php', 49)); // Ctrl+End
    caretMoved(at('b.php', 5));
    fileShown('a.php'); // its tab clicked
    fileShown('a.php'); // shown again: no new stop
    expect(go(goBack)).toEqual(at('b.php', 5));
    expect(go(goBack)).toEqual(at('a.php', 49));
    expect(go(goBack)).toEqual(at('a.php', 22));
  });

  it('a new jump after going back drops the forward history', () => {
    caretMoved(at('a.php', 1));
    caretMoved(at('b.php', 1));
    caretMoved(at('c.php', 1));
    go(goBack);
    caretMoved(at('d.php', 1));
    expect(go(goForward)).toBeNull();
    expect(go(goBack)).toEqual(at('b.php', 1));
  });
});

describe('Recent Locations', () => {
  it('lists visited and edited places, newest first, merging nearby ones', () => {
    caretMoved(at('a.php', 5));
    caretMoved(at('b.php', 50));
    edited('b.php', 52);
    edited('b.php', 53);
    expect(recentPlaces().map((p) => [p.path, p.line, p.edited])).toEqual([
      ['b.php', 53, true],
      ['a.php', 5, false],
    ]);
  });
});

describe('Reopen Closed Tab', () => {
  it('reopens the last closed file where the caret was, skipping open ones', () => {
    caretMoved(at('a.php', 30));
    caretMoved(at('b.php', 7));
    tabClosed('a.php');
    tabClosed('b.php');
    expect(takeClosed((p) => p === 'b.php')).toEqual(at('a.php', 30));
    expect(takeClosed(() => false)).toBeNull();
  });
});
