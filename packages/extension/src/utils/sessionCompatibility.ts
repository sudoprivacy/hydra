import * as path from 'path';
import { getRepoName, getRepoSessionNamespace } from './git';
import { toCanonicalPath } from './path';
import { getActiveBackend } from './multiplexer';

export type SessionPrefixType = 'primary' | 'legacy';

export interface RepoSessionPrefixConfig {
  repoName: string;
  repoSessionNamespace: string;
  canonicalRepoRoot: string;
  primaryPrefix: string;
  legacyPrefix: string;
}

export function createRepoSessionPrefixConfig(repoRoot: string): RepoSessionPrefixConfig {
  const canonicalRepoRoot = toCanonicalPath(repoRoot) || path.resolve(repoRoot);
  const repoName = getRepoName(repoRoot);
  const repoSessionNamespace = getRepoSessionNamespace(repoRoot);

  return {
    repoName,
    repoSessionNamespace,
    canonicalRepoRoot,
    primaryPrefix: `${getActiveBackend().sanitizeSessionName(repoSessionNamespace)}_`,
    legacyPrefix: `${getActiveBackend().sanitizeSessionName(repoName)}_`
  };
}

export function isWorkdirInRepo(workdir: string | undefined, canonicalRepoRoot: string): boolean {
  if (!workdir) return false;
  const canonicalWorkdir = toCanonicalPath(workdir);
  if (!canonicalWorkdir) return false;
  return canonicalWorkdir === canonicalRepoRoot || canonicalWorkdir.startsWith(`${canonicalRepoRoot}${path.sep}`);
}

function parseSlugWithPrefix(sessionName: string, prefix: string): string | undefined {
  if (!sessionName.startsWith(prefix)) return undefined;
  const slug = sessionName.substring(prefix.length);
  return slug || undefined;
}

export function matchRepoSessionName(
  sessionName: string,
  workdir: string | undefined,
  config: RepoSessionPrefixConfig,
  options?: { allowLegacy?: boolean }
): { type: SessionPrefixType; slug: string } | undefined {
  const primarySlug = parseSlugWithPrefix(sessionName, config.primaryPrefix);
  if (primarySlug) {
    return { type: 'primary', slug: primarySlug };
  }

  if (!options?.allowLegacy) return undefined;
  if (!isWorkdirInRepo(workdir, config.canonicalRepoRoot)) return undefined;

  const legacySlug = parseSlugWithPrefix(sessionName, config.legacyPrefix);
  if (legacySlug) {
    return { type: 'legacy', slug: legacySlug };
  }

  return undefined;
}

export function extractRepoSessionSlug(
  sessionName: string,
  config: RepoSessionPrefixConfig,
  options?: { allowLegacy?: boolean }
): string | undefined {
  const primarySlug = parseSlugWithPrefix(sessionName, config.primaryPrefix);
  if (primarySlug) return primarySlug;

  if (!options?.allowLegacy) return undefined;
  return parseSlugWithPrefix(sessionName, config.legacyPrefix);
}
