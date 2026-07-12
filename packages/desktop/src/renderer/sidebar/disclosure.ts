export interface DisclosedRows<T> {
  readonly visible: readonly T[];
  readonly hiddenCount: number;
  readonly canToggle: boolean;
}

export function discloseRows<T>(
  rows: readonly T[],
  limit: number,
  expanded: boolean,
  filtering: boolean,
): DisclosedRows<T> {
  const hasOverflow = rows.length > limit;
  const showAll = expanded || filtering || !hasOverflow;
  return {
    visible: showAll ? rows : rows.slice(0, limit),
    hiddenCount: showAll ? 0 : rows.length - limit,
    canToggle: hasOverflow && !filtering,
  };
}
