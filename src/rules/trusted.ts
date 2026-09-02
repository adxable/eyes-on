import { defaultBranch, gitReadClone } from '../git/git.js';
import type { RepoReader } from '../git/reader.js';
import {
  defaultRepoConfig,
  parseRepoConfig,
  REPO_CONFIG_FILE,
  RepoConfigError,
  type RepoConfig,
} from '../risk/repoconfig.js';

/**
 * Where `.eyes-on.yml` is read from, and why it is the only place.
 *
 * The rule the whole product rests on (report D4, section 5 P2): the fields
 * that decide whether a change reaches a human are read from the **default
 * branch**, at a pinned commit, and never from the branch being assessed. A
 * branch that deletes a hard rule from `.eyes-on.yml` still gets that rule.
 * no-mistakes reaches the same conclusion for `path_instructions`
 * (`internal/config/config_repo_trust_test.go`) and for the same reason: a
 * config the change itself supplies is a config the change can switch off.
 *
 * There is no opt-out and no "allow this branch's copy" flag. Where the trusted
 * copy cannot be read, the answer is `unverified` - stated - rather than a
 * quiet fallback to the pushed branch.
 */

export type TrustState =
  /** No `.eyes-on.yml` on the default branch. Defaults apply; there are no hard
   *  rules to miss. */
  | 'absent'
  /** Read and understood. */
  | 'trusted'
  /** The trusted copy exists and could not be parsed, or the default branch
   *  itself could not be resolved. eyes-on does not know which paths a human
   *  should have been sent to, and says so. */
  | 'unverified';

export interface TrustedConfig {
  state: TrustState;
  config: RepoConfig;
  /** Branch the copy was taken from, and the commit it was pinned at. */
  branch: string;
  /** Ref actually read - a local head or a remote-tracking one. */
  ref: string | null;
  sha: string | null;
  /** Present only for `unverified`, and always a sentence a human can act on. */
  detail: string | null;
}

/**
 * Resolves the default branch to a commit.
 *
 * The remote-tracking ref is preferred over the local head, because the local
 * head of a repository that has been sitting on a feature branch for a week is
 * simply out of date, while `refs/remotes/origin/<branch>` is what the reviewer
 * on the other end will actually merge into. Both are read from the clone,
 * which is where refs live; nothing here contacts the network.
 */
export function resolveDefaultBranch(
  clonePath: string,
  reader: RepoReader,
  branchOverride?: string | null,
): { branch: string; ref: string; sha: string } | null {
  const branch = branchOverride && branchOverride.length > 0 ? branchOverride : defaultBranch(clonePath);
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`, branch]) {
    if (gitReadClone(clonePath, ['show-ref', '--verify', '--quiet', ref]).status !== 0 && ref !== branch) {
      continue;
    }
    const sha = reader.resolve(ref);
    if (sha) return { branch, ref, sha };
  }
  return null;
}

/** Reads the trusted `.eyes-on.yml`. Never reads the working tree. */
export function readTrustedConfig(
  clonePath: string,
  reader: RepoReader,
  branchOverride?: string | null,
): TrustedConfig {
  const resolved = resolveDefaultBranch(clonePath, reader, branchOverride);
  if (!resolved) {
    return {
      state: 'unverified',
      config: defaultRepoConfig(),
      branch: branchOverride ?? '(unresolved)',
      ref: null,
      sha: null,
      detail:
        'the default branch could not be resolved in this clone, so the trusted copy of ' +
        `${REPO_CONFIG_FILE} could not be read; hard rules were not evaluated`,
    };
  }

  const source = reader.fileAt(resolved.sha, REPO_CONFIG_FILE);
  if (source === null) {
    return {
      state: 'absent',
      config: defaultRepoConfig(),
      branch: resolved.branch,
      ref: resolved.ref,
      sha: resolved.sha,
      detail: null,
    };
  }

  try {
    return {
      state: 'trusted',
      config: parseRepoConfig(source),
      branch: resolved.branch,
      ref: resolved.ref,
      sha: resolved.sha,
      detail: null,
    };
  } catch (error) {
    const message = error instanceof RepoConfigError ? error.message : (error as Error).message;
    return {
      state: 'unverified',
      config: defaultRepoConfig(),
      branch: resolved.branch,
      ref: resolved.ref,
      sha: resolved.sha,
      detail: `${message}; the assessment used defaults and no hard rule was evaluated`,
    };
  }
}
