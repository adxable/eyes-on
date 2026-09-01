import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Deterministic repository identifier: the first 6 bytes of sha256 over the
 * absolute clone path, rendered as 12 hex characters.
 *
 * The algorithm is the one no-mistakes uses (internal/gate/gate.go:26-29, with
 * the symlink normalisation its own harness documents at
 * internal/e2e/harness.go:687-697), so a freshly registered clone gets the same
 * id in both tools and correlating an assessment with a run is free. It is not
 * a guarantee of equality: no-mistakes reuses a previously stored `existing.ID`
 * when a clone moves, so an old gate can carry an id no longer derivable from
 * its current path. Correlation is therefore a convenience, never a dependency
 * - eyes-on computes its own id and reads nothing of theirs to do it.
 */
export function repoID(clonePath: string): string {
  return createHash('sha256').update(canonicalPath(clonePath)).digest('hex').slice(0, 12);
}

/** Physical absolute path, so two spellings of one clone yield one id. */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}
