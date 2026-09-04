import type { RepoReader } from '../git/reader.js';
import type { PullRecord } from '../gh/gh.js';
import type { UncheckedReason } from '../gh/comment.js';

/**
 * Change -> pull request -> the commit that landed it, from git and GitHub and
 * nothing else.
 *
 * This is the stage 3 acceptance condition (report section 8): the chain has to
 * be reconstructible **without the no-mistakes database**. Nothing here reads
 * one, and nothing here can: the two sources are a `git log` of the default
 * branch and one GET of the pull request.
 *
 * ## Why there are two sources and not one
 *
 * Git alone gives the link a squash merge leaves behind: GitHub writes the pull
 * request number into the subject as `(#N)`, so the commit that landed the
 * change names the pull request it came from. That is the whole mechanism, and
 * it is why nothing is written into the commit or into a git note (Appendix
 * C.2): the squash eats a trailer and a note is a ref, which eyes-on must never
 * write into somebody's clone.
 *
 * GitHub alone gives `merge_commit_sha`, which is the same fact from the other
 * end. Neither is checked against the other by anyone else, so this module
 * carries **both** and says whether they agree, instead of picking one and
 * presenting it as the answer. A disagreement is a real state - a subject
 * edited after the fact, a pull request landed by another route, a default
 * branch that is not the one it merged into - and the register records which of
 * them it is rather than a sha with no provenance.
 */

/** A default-branch commit that names a pull request in its subject. */
export interface MergeCommit {
  number: number;
  sha: string;
  /** First parent: the commit the change landed on, and the base of the run
   *  that would have assessed it. Null only for a root commit. */
  parent: string | null;
  /** How many parents it has. One is a squash merge, which introduces every
   *  line of the change; more is a true merge commit, which introduces none. */
  parents: number;
  subject: string;
  /** Author timestamp: when the work was written. */
  timestamp: number;
  /** Committer timestamp: when the change landed on this branch. The register
   *  records this as the merge time when GitHub was not read, because it is
   *  the one of the two that answers "when did it merge". */
  committed: number;
}

/**
 * The `(#N)` suffix GitHub appends to a squash-merge subject.
 *
 * Anchored at the end, because a subject may mention another pull request in
 * passing ("revert #204") and only the trailing parenthesised form is the one
 * GitHub writes. A subject carrying two would be read by its last, which is the
 * one the merge added.
 */
const PULL_SUFFIX = /\(#(\d+)\)\s*$/;

/** The pull request a merge subject names, or null when it names none. */
export function pullNumberInSubject(subject: string): number | null {
  const match = PULL_SUFFIX.exec(subject);
  if (!match?.[1]) return null;
  const number = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export interface MergeWalkOptions {
  /** Only commits at or after this instant. Undefined walks the whole branch. */
  sinceSeconds?: number;
  maxCount?: number;
}

/**
 * Every pull request the default branch landed, newest first.
 *
 * `--first-parent` is what makes this the *branch's* history rather than every
 * commit that ever reached it: on a repository that merges without squashing,
 * the second parent's commits carry their own subjects and none of them landed
 * a pull request on this branch.
 *
 * Later entries win nothing: a pull request number that appears twice is kept
 * twice, and the caller decides. Reporting one and hiding the other would be
 * the register silently choosing between two candidate merge commits.
 */
export function mergedPulls(reader: RepoReader, anchorSHA: string, options: MergeWalkOptions = {}): MergeCommit[] {
  const commits = reader.firstParentLog(anchorSHA, options);
  const merges: MergeCommit[] = [];
  for (const commit of commits) {
    const number = pullNumberInSubject(commit.subject);
    if (number === null) continue;
    merges.push({
      number,
      sha: commit.sha,
      parent: commit.parents[0] ?? null,
      parents: commit.parents.length,
      subject: commit.subject,
      timestamp: commit.timestamp,
      committed: commit.committed,
    });
  }
  return merges;
}

/**
 * What the two sources said about where a change landed.
 *
 * Six states, and they are six because collapsing any pair loses something a
 * reader of the register has to be able to act on. In particular `not-merged`
 * and `neither` are different: the first is a pull request that is open or was
 * closed unmerged, which is a correct answer, and the second is a merged change
 * whose commit neither source could name, which is a gap.
 */
export type LinkAgreement =
  /** Both named a commit and it is the same one. The acceptance condition
   *  counts these. */
  | 'agrees'
  /** Both named a commit and they differ. */
  | 'disagrees'
  /** Git named one; GitHub was not read, so nothing confirmed it. */
  | 'git-only'
  /** GitHub named one; no commit on the default branch carries `(#N)`. */
  | 'github-only'
  /** GitHub says it did not merge, and git found no commit for it either. */
  | 'not-merged'
  /** Neither source named a commit for a pull request that is not open. */
  | 'neither';

export interface PullLink {
  number: number;
  /** The default-branch commit naming this pull request, or null. When more
   *  than one does, this is the newest and `git_candidates` says how many. */
  git: MergeCommit | null;
  /** How many default-branch commits carry this pull request's `(#N)` subject.
   *
   *  Ordinarily one. Two happens - a change reverted and re-landed under a
   *  subject that kept the suffix, a cherry-pick onto the default branch - and
   *  it is the state in which `git` above is a *choice* rather than the answer:
   *  `leaks` blames every later fix against whichever commit was recorded. So
   *  the count travels on the link, on the register row and into the sentence,
   *  and no surface can present the newest of two candidates as the only one
   *  there was. */
  git_candidates: number;
  /** GitHub's answer, or null when gh was not read. */
  github: PullRecord | null;
  /** Why GitHub was not read, when it was not. */
  unread: UncheckedReason | null;
  agreement: LinkAgreement;
  /** The commit both sources point at, or the one the single source that
   *  answered named. Null when nothing named one. */
  merge_sha: string | null;
  /** One sentence saying what each source said, for the surface that shows it
   *  and for the record that keeps it. */
  sentence: string;
}

export interface LinkInput {
  number: number;
  /** Commits on the default branch naming this pull request, newest first. */
  fromGit: readonly MergeCommit[];
  fromGitHub: PullRecord | null;
  unread: UncheckedReason | null;
}

/**
 * Compares the two sources. The single place the chain is decided, so no
 * surface can present a merge commit whose provenance another surface would
 * describe differently.
 */
export function linkPull(input: LinkInput): PullLink {
  const link = decideLink(input);
  return { ...link, sentence: `${link.sentence}${candidateSentence(input, link.merge_sha !== null)}` };
}

/**
 * What a second default-branch commit carrying the same `(#N)` adds to the
 * sentence, when there is one.
 *
 * The count is said in every state, because it is a fact about the branch. What
 * was *done* with it is not: on a disagreement no merge commit is recorded at
 * all, and a sentence saying the newest was taken would contradict the sentence
 * it is appended to and the null the row carries.
 */
function candidateSentence(input: LinkInput, recorded: boolean): string {
  if (input.fromGit.length < 2) return '';
  const others = input.fromGit
    .slice(1)
    .map((commit) => commit.sha.slice(0, 12))
    .join(', ');
  const rest = `the ${input.fromGit.length === 2 ? 'other is' : 'others are'} ${others}`;
  return recorded
    ? ` ${input.fromGit.length} commits on the default branch carry a \`(#${input.number})\` subject - the newest was taken and ${rest}, so this row names a choice between candidates rather than the only one there was.`
    : ` ${input.fromGit.length} commits on the default branch carry a \`(#${input.number})\` subject - the newest is ${(input.fromGit[0] as MergeCommit).sha.slice(0, 12)} and ${rest} - and no merge commit was recorded here, so none of them was chosen.`;
}

function decideLink(input: LinkInput): PullLink {
  const git = input.fromGit[0] ?? null;
  const github = input.fromGitHub;
  const githubSHA = github?.merge_commit_sha ?? null;
  const gitSHA = git?.sha ?? null;

  const base = {
    number: input.number,
    git,
    git_candidates: input.fromGit.length,
    github,
    unread: input.unread,
  };

  if (gitSHA !== null && githubSHA !== null) {
    const agrees = gitSHA === githubSHA;
    return {
      ...base,
      agreement: agrees ? 'agrees' : 'disagrees',
      // On a disagreement neither sha is the answer, so none is offered. A
      // register row naming one of two commits that contradict each other is
      // worse than one saying it does not know which.
      merge_sha: agrees ? gitSHA : null,
      sentence: agrees
        ? `The default-branch commit ${gitSHA.slice(0, 12)} names #${input.number} in its subject, and GitHub names the same commit as the one that merged it.`
        : `The default-branch commit ${gitSHA.slice(0, 12)} names #${input.number} in its subject, and GitHub names ${githubSHA.slice(0, 12)} as the commit that merged it. The two disagree, so eyes-on records neither as the merge commit.`,
    };
  }

  if (gitSHA !== null) {
    return {
      ...base,
      agreement: 'git-only',
      merge_sha: gitSHA,
      sentence: `The default-branch commit ${gitSHA.slice(0, 12)} names #${input.number} in its subject. ${githubUnreadSentence(input)}`,
    };
  }

  if (githubSHA !== null) {
    return {
      ...base,
      agreement: 'github-only',
      merge_sha: githubSHA,
      sentence: `GitHub names ${githubSHA.slice(0, 12)} as the commit that merged #${input.number}, and no commit on the default branch read here carries a \`(#${input.number})\` subject - the merge may be on another branch, or outside the range walked.`,
    };
  }

  if (github !== null && !github.merged) {
    return {
      ...base,
      agreement: 'not-merged',
      merge_sha: null,
      sentence: `GitHub says #${input.number} has not merged${github.state ? ` (it is ${github.state})` : ''}, and no commit on the default branch carries a \`(#${input.number})\` subject.`,
    };
  }

  return {
    ...base,
    agreement: 'neither',
    merge_sha: null,
    sentence: `No commit on the default branch carries a \`(#${input.number})\` subject. ${githubUnreadSentence(input)}`,
  };
}

/** What GitHub contributed, when it contributed no merge commit. */
function githubUnreadSentence(input: LinkInput): string {
  switch (input.unread) {
    case 'gh-missing':
      return 'The GitHub CLI is not installed, so nothing confirmed it from the other end.';
    case 'no-repository':
      return 'gh could not name a GitHub repository for this clone, so nothing confirmed it from the other end.';
    case 'gh-error':
      return 'gh ran and GitHub answered with an error, so nothing confirmed it from the other end.';
    case null:
      break;
  }
  if (input.fromGitHub === null) {
    return 'gh answered nothing eyes-on could read as a pull request, so nothing confirmed it from the other end.';
  }
  return input.fromGitHub.merged
    ? 'GitHub says it merged but named no merge commit for it.'
    : `GitHub says it has not merged${input.fromGitHub.state ? ` (it is ${input.fromGitHub.state})` : ''}.`;
}
