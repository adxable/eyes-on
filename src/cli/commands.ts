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
 * whether it does anything yet. Stages 0 through 3 are built; a command that is
 * listed and not built says so plainly and exits non-zero, naming the stage
 * that owns it - it never pretends to have an answer.
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
    usage:
      'eyes-on axi {status|check|logs [--lines <n>]|respond --action read|waive --reason "..." [--check-id <id>] [--by <name>]|abort} [--base <ref>] [--head <ref>] [--default-branch <ref>]',
    summary:
      'Agent surface: TOON on stdout, progress on stderr, exit 0 success, 1 error, 2 usage error. `respond` answers a run parked by a hard rule and records who decided what, and why. `abort` is answered rather than implemented: eyes-on has no in-flight run to stop, and it says so.',
    stage: 0,
    mutating: false,
    implemented: true,
  },
  {
    name: 'check',
    usage:
      'eyes-on check [--base <ref>] [--head <ref>] [--default-branch <ref>] [--intent "..."] [--no-model] [--strict] [--format toon|md|json]',
    summary:
      'Score the change from repository history and apply the hard rules. With --intent it also measures intent-versus-diff drift and scores it as S7. A hard-rule hit parks the run as `must_read` until `axi respond` answers it. Exits 0 whatever the band is, unless --strict is passed.',
    stage: 1,
    mutating: true,
    implemented: true,
  },
  {
    name: 'why',
    usage: 'eyes-on why <file> | eyes-on why --top <n> [--default-branch <ref>]',
    summary:
      'Explain where the risk of this file came from: the fix commits that blamed into it, the commits that touched it, and any hard rule naming it. With --top and no file, list the riskiest code files in the repository instead.',
    stage: 1,
    mutating: false,
    implemented: true,
  },
  {
    name: 'rules',
    usage: 'eyes-on rules --check [--strict] [--base <ref>] [--head <ref>] [--default-branch <ref>]',
    summary:
      'Evaluate the hard rules alone, without scoring. Rules are read from the default branch at a pinned commit, so a branch that deletes one still gets it.',
    stage: 1,
    mutating: false,
    implemented: true,
  },
  {
    name: 'export-path-instructions',
    usage: 'eyes-on export-path-instructions [--min-risk <0-100>] [--default-branch <ref>]',
    summary:
      'Emit a review.path_instructions block for .no-mistakes.yaml, inside its 32-entry and 16384-byte caps. A bridge, never a dependency.',
    stage: 1,
    mutating: false,
    implemented: true,
  },
  {
    name: 'backtest',
    usage: 'eyes-on backtest --split <date>[,<date>...] [--horizon <days>] [--default-branch <ref>]',
    summary:
      'Replay the risk signal against history either side of a split date and report how much more often the flagged files were fixed afterwards.',
    stage: 1,
    mutating: false,
    implemented: true,
  },
  {
    name: 'spotlight',
    usage: 'eyes-on spotlight [--base <ref>] [--head <ref>] [--default-branch <ref>] [--n 5] [--intent "..."] [--no-model]',
    summary:
      'Rank the three to five fragments a human should actually read. Two stages: arithmetic over git narrows the diff to twelve candidates, then one model call picks a few and says why. --no-model returns stage one and calls nothing.',
    stage: 2,
    mutating: true,
    implemented: true,
  },
  {
    name: 'drift',
    usage: 'eyes-on drift [--base <ref>] [--head <ref>] [--default-branch <ref>] [--intent "..."] [--no-model]',
    summary:
      'Compare the stated intent with what the diff actually does, in two passes: one model describes the diff without seeing the intent, a second compares that description with it. The grade is folded into the recorded check as signal S7, so the score, its maximum and the band move with it. This command itself is never a gate.',
    stage: 2,
    mutating: true,
    implemented: true,
  },
  {
    name: 'comment',
    usage: 'eyes-on comment --pr <n> [--check-id <id>] [--base <ref>] [--head <ref>] [--default-branch <ref>] [--dry-run]',
    summary:
      'Publish the single sticky eyes-on comment on a pull request, found by its marker and updated in place. Never touches the body, never merges, never files a review.',
    stage: 2,
    mutating: true,
    implemented: true,
  },
  {
    name: 'label',
    usage: 'eyes-on label --pr <n> [--check-id <id>] [--default-branch <ref>] [--dry-run]',
    summary:
      'Append one register line for a merged change: the channel it merged under, the gate decision and the hits it answered, the drift grade and the intent it was measured against, and the commit that landed it. The chain from the change to that commit is reconstructed from the `(#N)` subject on the default branch and from GitHub, and the record says whether the two agree. Append-only; --dry-run reconstructs everything and writes nothing.',
    stage: 3,
    mutating: true,
    implemented: true,
  },
  {
    name: 'leaks',
    usage: 'eyes-on leaks [--window 14d] [--since 90d] [--default-branch <ref>]',
    summary:
      'Report, per channel, how often a registered merge was followed by a fix whose blame names it - the line-level variant only, because the file-level one has a base rate of 45-73% and can argue for no threshold. Below a hundred merges in a channel the header says the numbers are directional. Exits 0 whatever they are.',
    stage: 3,
    mutating: false,
    implemented: true,
  },
  {
    name: 'calibrate',
    usage: 'eyes-on calibrate [--window 14d] [--since 90d] [--default-branch <ref>]',
    summary:
      'Sweep a grid of thresholds over the register: what each pair would have sent to a human, and how much of what it let through leaked. Writes nothing - the thresholds live on the default branch, which eyes-on reads and never writes.',
    stage: 3,
    mutating: false,
    implemented: true,
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
