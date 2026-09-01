import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Paths } from './paths.js';
import { parseYaml, stringifyYaml, type YamlMap } from './yaml.js';
import { DEFAULT_LOG_POLICY, type LogPolicy } from './logstore.js';

/**
 * Global configuration at `<root>/config.yaml`.
 *
 * Deliberately small at stage 0: the fields that decide anything about risk
 * live in the repository's `.eyes-on.yml` and are read from the default branch
 * at a pinned SHA (report D4), which is stage 1. What lives here is machine
 * policy - whether the daemon is managed by the OS service manager, how much
 * history to keep - none of which a pushed branch may influence.
 *
 * A LaunchAgent exports only HOME and PATH (report Appendix A3), so nothing
 * here may fall back to an environment variable to be correct.
 */
export interface GlobalConfig {
  schema: string;
  daemon: {
    /** Whether `init` registers an OS-managed service for the daemon. `init`
     *  owns this decision both ways: set to false it also removes a job it
     *  registered earlier, rather than leaving one loaded. */
    managed_service: boolean;
  };
  logs: {
    max_bytes: number;
    backups: number;
  };
  reports: {
    /** How many per-head report files to keep (Appendix C.2: 200). */
    retention: number;
  };
  telemetry: {
    enabled: boolean;
  };
}

export const CONFIG_SCHEMA = 'eyes-on/v1';

export function defaultConfig(): GlobalConfig {
  return {
    schema: CONFIG_SCHEMA,
    daemon: { managed_service: true },
    logs: { max_bytes: 8 * 1024 * 1024, backups: 2 },
    reports: { retention: 200 },
    telemetry: { enabled: false },
  };
}

function asMap(value: unknown): YamlMap {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as YamlMap) : {};
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asPositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Merges a parsed document onto the defaults; unknown keys are ignored and
 *  malformed values fall back rather than failing the whole CLI. */
export function normalizeConfig(parsed: unknown): GlobalConfig {
  const base = defaultConfig();
  const map = asMap(parsed);
  const daemon = asMap(map.daemon);
  const logs = asMap(map.logs);
  const reports = asMap(map.reports);
  const telemetry = asMap(map.telemetry);
  return {
    schema: typeof map.schema === 'string' ? map.schema : base.schema,
    daemon: { managed_service: asBool(daemon.managed_service, base.daemon.managed_service) },
    logs: {
      max_bytes: asPositiveInt(logs.max_bytes, base.logs.max_bytes),
      backups: asPositiveInt(logs.backups, base.logs.backups),
    },
    reports: { retention: asPositiveInt(reports.retention, base.reports.retention) },
    telemetry: { enabled: asBool(telemetry.enabled, base.telemetry.enabled) },
  };
}

export function loadConfig(paths: Paths): GlobalConfig {
  try {
    return normalizeConfig(parseYaml(readFileSync(paths.configFile, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig();
    throw error;
  }
}

/**
 * The log bound, from config when it can be read and from the default when it
 * cannot.
 *
 * A hand-edited config.yaml that no longer parses is a file the user owns, not
 * an eyes-on bug, and how many bytes a log keeps is not a policy worth failing
 * a daemon start over. `init` is what repairs the file.
 */
export function logPolicy(paths: Paths): LogPolicy {
  try {
    const logs = loadConfig(paths).logs;
    return { maxBytes: logs.max_bytes, backups: logs.backups };
  } catch {
    return DEFAULT_LOG_POLICY;
  }
}

const CONFIG_HEADER = `# eyes-on global configuration.
# Repository-scoped risk settings belong in .eyes-on.yml on the default branch,
# not here: eyes-on reads those at a pinned SHA so a branch cannot remove a rule
# that would have sent it to a human.
`;

/** Writes the config only when absent, or when force repairs a broken file.
 *  Returns whether the file was written, so `init` can report honestly. */
export function ensureConfig(paths: Paths, force: boolean): boolean {
  let existing: string | null = null;
  try {
    existing = readFileSync(paths.configFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing !== null && !force) {
    try {
      normalizeConfig(parseYaml(existing));
      return false;
    } catch {
      // Unreadable config is repaired rather than left to fail every command.
    }
  }
  mkdirSync(dirname(paths.configFile), { recursive: true });
  writeFileSync(paths.configFile, CONFIG_HEADER + stringifyYaml(defaultConfig() as unknown as YamlMap), {
    mode: 0o644,
  });
  return true;
}
