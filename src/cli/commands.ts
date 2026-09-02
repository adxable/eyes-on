/**
 * The command surface, in one table.
 *
 * This is the single source of truth for three consumers: the dispatcher, the
 * `--help` text, and the generated `/eyes-on` skill. no-mistakes generates its
 * skill from code for exactly this reason (internal/skill/skill.go:9-45) and
 * the report adds the missing half (M20): a drift test, because an agent-facing
 * instruction that is maintained by hand disagrees with the CLI within a week.
 *
 * `stage` records which delivery stage owns the command, and `implemented`
 * whether it does anything yet. Stages 0 and 1 are built; a stage-2 or stage-3
 * command that is listed but not built says so plainly and exits non-zero; it
 * never pretends to have an answer.
 */

export type Stage = 0 | 1 | 2 | 3;

export interface CommandSpec {
  name: string;
  usage: string;
  summary: string;
  stage: Stage;
  /**
   * Whether the command writes eyes-on state. Mutating commands are refused
   * from inside a no-mistakes run (report M24/K16); read-only ones are not.
   */
  mutating: boolean;
  implemented: boolean;
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'init',
    usage: 'eyes-on init [--watch] [--force]',
    summary:
      'Register this repository: create the state root, build the mirror, start the daemon and install the /eyes-on skill. Idempotent - re-running repairs. --watch also installs a post-commit hook in the clone.',
    stage: 0,
    mutating: true,
    implemented: true,
  },
  {
    name: 'doctor',
    usage: 'eyes-on doctor',
    summary:
      'Report git, node and gh availability, mirror reachability, daemon and service state, and any collision or degradation eyes-on can detect.',
    stage: 0,
    mutating: false,
    implemented: true,
  },
  {
    name: 'status',
    usage: 'eyes-on status',
    summary: 'Show the daemon, the registered repositories and the current head of this repository. Read-only.',
    stage: 0,
    mutating: false,
    implemented: true,
  },
  {
    name: 'daemon',
    usage: 'eyes-on daemon {start|stop|restart|status|run --root <dir>|notify-commit}',
    summary: 'Manage the eyes-on daemon. `run` is the foreground entry point the OS service invokes.',
    stage: 0,
    mutating: true,
    implemented: true,
  },
  {
    name: 'axi',
    usage: 'eyes-on axi {status|check|logs|respond --action read|waive --reason "..."}',
    summary:
      'Agent surface: TOON on stdout, progress on stderr, exit 0 success, 1 error, 2 usage error. `respond` answers a run parked by a hard rule and records who decided what, and why.',
    stage: 0,
    mutating: false,
    implemented: true,
  },
  {
    name: 'check',
    usage:
      'eyes-on check [--base <ref>] [--head <ref>] [--intent "..."] [--no-model] [--strict] [--format toon|md|json]',
    summary:
      'Score the change from repository history and apply the hard rules. With --intent it also measures intent-versus-diff drift and scores it as S7. A hard-rule hit parks the run as `must_read` until `axi respond` answers it. Exits 0 whatever the band is, unless --strict is passed.',
    stage: 1,
    mutating: true,
    implemented: true,
  },
  {
    name: 'why',
    usage: 'eyes-on why <file> | eyes-on why --top <n>',
    summary:
      'Explain where the risk of this file came from: the fix commits that blamed into it, the commits that touched it, and any hard rule naming it. With --top and no file, list the riskiest code files in the repository instead.',
    stage: 1,
    mutating: false,
    implemented: true,
  },
  {
    name: 'rules',
    usage: 'eyes-on rules --check [--strict]',
    summary:
      'Evaluate the hard rules alone, without scoring. Rules are read from the default branch at a pinned commit, so a branch that deletes one still gets it.',
    stage: 1,
    mutating: false,
    implemented: true,
  },
  {
    name: 'export-path-instructions',
    usage: 'eyes-on export-path-instructions [--min-risk <0-100>]',
    summary:
      'Emit a review.path_instructions block for .no-mistakes.yaml, inside its 32-entry and 16384-byte caps. A bridge, never a dependency.',
    stage: 1,
    mutating: false,
    implemented: true,
  },
  {
    name: 'backtest',
    usage: 'eyes-on backtest --split <date>[,<date>...] [--horizon <days>]',
    summary:
      'Replay the risk signal against history either side of a split date and report how much more often the flagged files were fixed afterwards.',
    stage: 1,
    mutating: false,
    implemented: true,
  },
  {
    name: 'spotlight',
    usage: 'eyes-on spotlight [--n 5] [--no-model]',
    summary:
      'Rank the three to five fragments a human should actually read. Two stages: arithmetic over git narrows the diff to twelve candidates, then one model call picks a few and says why. --no-model returns stage one and calls nothing.',
    stage: 2,
    mutating: true,
    implemented: true,
  },
  {
    name: 'drift',
    usage: 'eyes-on drift [--intent "..."]',
    summary:
      'Compare the stated intent with what the diff actually does, in two passes: one model describes the diff without seeing the intent, a second compares that description with it. Shown, never a gate.',
    stage: 2,
    mutating: true,
    implemented: true,
  },
  {
    name: 'comment',
    usage: 'eyes-on comment --pr <n> [--dry-run]',
    summary:
      'Publish the single sticky eyes-on comment on a pull request, found by its marker and updated in place. Never touches the body, never merges, never files a review.',
    stage: 2,
    mutating: true,
    implemented: true,
  },
  {
    name: 'label',
    usage: 'eyes-on label --pr <n>',
    summary: 'Record the channel, the decision and the merge commit in the ledger after a merge.',
    stage: 3,
    mutating: true,
    implemented: false,
  },
  {
    name: 'leaks',
    usage: 'eyes-on leaks [--window 14d] [--since 90d]',
    summary: 'Report post-merge fixes per channel - the line-level variant only.',
    stage: 3,
    mutating: false,
    implemented: false,
  },
  {
    name: 'calibrate',
    usage: 'eyes-on calibrate',
    summary: 'Propose thresholds from the ledger by sweeping them over recorded history.',
    stage: 3,
    mutating: true,
    implemented: false,
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}

export function implementedCommands(): CommandSpec[] {
  return COMMANDS.filter((command) => command.implemented);
}

export function plannedCommands(): CommandSpec[] {
  return COMMANDS.filter((command) => !command.implemented);
}
