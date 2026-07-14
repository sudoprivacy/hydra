import type { CreationRepositoryOption } from '@hydra/protocol';

export const MANUAL_REPOSITORY = '__manual_repository__';

/** Turn an initial task into an editable, conventional branch suggestion. */
export function suggestBranchFromTask(task: string): string {
  const slug = task
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return `feat/${slug || 'new-worker'}`;
}

/** Prefer explicit sidebar context, then the most recent repository. */
export function chooseInitialRepository(
  repositories: readonly CreationRepositoryOption[],
  candidate?: string,
): string {
  if (candidate) {
    return repositories.find(option => repositoryMatches(option, candidate))?.value
      ?? MANUAL_REPOSITORY;
  }
  return repositories.find(option => option.sources.includes('recent'))?.value
    ?? repositories[0]?.value
    ?? MANUAL_REPOSITORY;
}

function repositoryMatches(option: CreationRepositoryOption, candidate: string): boolean {
  const normalizedCandidate = normalizeRepositoryValue(candidate);
  return [option.value, option.path, ...option.aliases]
    .some(value => normalizeRepositoryValue(value) === normalizedCandidate);
}

function normalizeRepositoryValue(value: string): string {
  return value.trim().replace(/[\\/]+$/, '');
}
