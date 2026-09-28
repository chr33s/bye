// Cursor paging (§8 API views). Pages are appended in server order; rows already shown (same key)
// are replaced in place rather than duplicated, so a thread that changed between pages never
// appears twice.

export interface Page<T> {
  readonly items: ReadonlyArray<T>;
  readonly nextCursor: string | null;
}

export interface Paged<T> {
  readonly items: ReadonlyArray<T>;
  readonly cursor: string | null;
  readonly done: boolean;
}

export const emptyPaged = <T>(): Paged<T> => ({ items: [], cursor: null, done: false });

export const appendPage = <T>(
  current: Paged<T>,
  page: Page<T>,
  keyOf: (item: T) => string,
): Paged<T> => {
  const index = new Map(current.items.map((item, i) => [keyOf(item), i] as const));
  const items = [...current.items];

  for (const item of page.items) {
    const at = index.get(keyOf(item));

    if (at === undefined) {
      index.set(keyOf(item), items.length);
      items.push(item);
    } else {
      items[at] = item;
    }
  }

  return { items, cursor: page.nextCursor, done: page.nextCursor === null };
};

/** Query string for the next page request, or null when exhausted. */
export const nextPageQuery = (paged: Paged<unknown>, limit = 50): string | null => {
  if (paged.done) return null;
  const q = new URLSearchParams({ limit: String(limit) });

  if (paged.cursor) q.set("cursor", paged.cursor);

  return q.toString();
};
