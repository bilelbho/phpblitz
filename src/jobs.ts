// Long-running tools whose output is shown as it comes (test runs, project generators): the Rust
// side runs them and streams their output through a channel, whole lines grouped in frames, then
// their exit code as the last message.

import { Channel, invoke } from '@tauri-apps/api/core';

type JobEvent = { kind: 'output'; text: string } | { kind: 'exit'; code: number };

/**
 * Runs `job_exec` (a program and its arguments) or `job_run` (a shell command line) with `args`,
 * calling `onLine` for each line of output. Resolves with the exit code once all output has arrived.
 */
export async function runJob(command: 'job_exec' | 'job_run', args: Record<string, unknown>, onLine: (line: string) => void): Promise<number> {
  const channel = new Channel<JobEvent>();
  let exited: (code: number) => void = () => {};
  const exit = new Promise<number>((resolve) => (exited = resolve));
  channel.onmessage = (event) => {
    if (event.kind === 'exit') return exited(event.code);
    for (const line of event.text.split(/(?<=\n)/)) if (line) onLine(line);
  };
  const code = await invoke<number>(command, { ...args, onOutput: channel });
  // The exit message comes after the last output on the channel; the command's own answer may
  // arrive first. Wait for it (a moment at most) so no line is lost.
  return Promise.race([exit, new Promise<number>((resolve) => setTimeout(() => resolve(code), 2000))]);
}
