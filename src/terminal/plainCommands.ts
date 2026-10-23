// Commands typed into a terminal for the user (a README's code block, an npm script): one per
// line, without control characters. Those are invisible in the code block but would reach the
// shell (Ctrl+C, escape sequences, a carriage return in the middle of a line).

export function plainCommands(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      // C0 controls and DEL, except tab and newline.
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
      .trim()
  );
}
