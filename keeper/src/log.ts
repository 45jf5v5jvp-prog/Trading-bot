const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) || "info"] ?? 20;
const COLOR: Record<Level, string> = { debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" };

export function log(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}` +
    (extra ? " " + JSON.stringify(extra, (_, v) => (typeof v === "bigint" ? v.toString() : v)) : "");
  console.log(`${COLOR[level]}${line}\x1b[0m`);
}
