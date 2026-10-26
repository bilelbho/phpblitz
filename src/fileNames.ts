// What a file or folder name can't be (the strictest rules, Windows', so a project stays portable).

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_LENGTH = 255;

/** Why `name` (one path segment) can't be a file or folder name; null when it can. */
export function fileNameProblem(name: string): string | null {
  if (!name || name === '.' || name === '..') return 'Enter a name.';
  // eslint-disable-next-line no-control-regex
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return 'A name can’t contain \\ / : * ? " < > |';
  if (/[. ]$/.test(name)) return 'A name can’t end with a dot or a space.';
  if (RESERVED.test(name)) return `“${name.split('.')[0]}” is a name Windows reserves for devices.`;
  if (name.length > MAX_LENGTH) return `A name can be at most ${MAX_LENGTH} characters (this one has ${name.length}).`;
  return null;
}
