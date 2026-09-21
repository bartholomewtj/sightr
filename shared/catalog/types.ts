export interface AgentCommand {
  /** Includes the leading slash, e.g. "/compact". */
  command: string;
  /** One-line, action-oriented description. */
  description: string;
  /** True if the command commonly takes an argument — tap inserts it into the composer to edit. */
  takesArg: boolean;
  /** Placeholder shown after insert, e.g. "[instructions]" / "<model>". Empty if no arg. */
  argHint: string;
  /** True for the handful surfaced first on a phone. The rest are reachable via search. */
  common: boolean;
  /** Destructive/disruptive enough to warrant a two-tap confirm (e.g. /clear wipes context). */
  dangerous: boolean;
}
