/**
 * What an emulator printed during one session. An emulator that stops keeps printing while it
 * unloads, so the lines that say why are kept apart from the most recent ones.
 */
export interface SessionLog {
  /** The first lines that read like a failure, in the order they arrived. */
  readonly problems: readonly string[];
  readonly recent: readonly string[];
}

const PROBLEMS = 40;
const RECENT = 200;
const LINE = 300;
/** Kept in step with the same test in `public/play/sandbox.html`. */
export const PROBLEM_LINE =
  /error|exception|abort|fatal|fail|unreachable|out of memory|shut ?down|unsupported|unhandled|invalid|not found|cannot|could ?n.t/i;

export const emptyLog = (): SessionLog => ({ problems: [], recent: [] });

export function addLine(log: SessionLog, text: string): SessionLog {
  const line = text.slice(0, LINE);
  return {
    problems:
      log.problems.length < PROBLEMS && PROBLEM_LINE.test(line)
        ? [...log.problems, line]
        : log.problems,
    recent: [...log.recent.slice(-(RECENT - 1)), line],
  };
}

export function logText(log: SessionLog): string {
  const early = log.problems.filter((line) => !log.recent.includes(line));
  return [
    ...(early.length ? ['Earlier problems:', ...early, '', 'Latest messages:'] : []),
    ...log.recent,
  ].join('\n');
}
