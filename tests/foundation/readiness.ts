// Parses the service's readiness line from accumulated stdout.
//
// Only complete, newline-terminated lines are considered: stdout may arrive in
// arbitrary chunks, and a partial line such as "...127.0.0.1:4" (before the
// rest of ":43210\n" arrives) must not be mistaken for a port.
const READY_LINE = /listening on http:\/\/127\.0\.0\.1:(\d+)\r?$/;

export function readinessPort(buffered: string): number | undefined {
  const lastNewline = buffered.lastIndexOf("\n");
  if (lastNewline === -1) return undefined;
  for (const line of buffered.slice(0, lastNewline).split("\n")) {
    const match = READY_LINE.exec(line);
    if (match) return Number(match[1]);
  }
  return undefined;
}
