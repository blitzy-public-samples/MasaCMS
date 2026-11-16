// Captures the log-record.v1 lines a logger writes to a test destination.

/** One parsed log line. */
export type LogLine = Record<string, unknown>;

/** A destination and the lines written to it, parsed. */
export function captureLines(): { lines: LogLine[]; destination: { write(chunk: string): void } } {
  const lines: LogLine[] = [];
  return {
    lines,
    destination: {
      write: (chunk) => {
        for (const text of chunk.split('\n')) if (text !== '') lines.push(JSON.parse(text) as LogLine);
      },
    },
  };
}
