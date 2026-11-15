import type { FileEntry } from '../types/index.ts';

export type SortColumn = 'name' | 'size' | 'owner' | 'mtime' | 'permissions';
export type SortDirection = 'asc' | 'desc';

export interface SortOptions {
  column: SortColumn;
  direction: SortDirection;
  foldersFirst?: boolean;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortFiles(files: FileEntry[], options: SortOptions): FileEntry[] {
  const { column, direction, foldersFirst = true } = options;

  return [...files].sort((a, b) => {
    // 1. Folders first
    if (foldersFirst && a.is_dir !== b.is_dir) {
      return a.is_dir ? -1 : 1;
    }

    // 2. Primary comparison
    let comparison = 0;

    switch (column) {
      case 'name':
        comparison = collator.compare(a.name, b.name);
        break;

      case 'size': {
        const sizeA = a.is_dir ? 0 : (a.size ?? 0);
        const sizeB = b.is_dir ? 0 : (b.size ?? 0);
        comparison = sizeA - sizeB;
        break;
      }

      case 'owner': {
        const ownerA = `${a.owner || ''}:${a.group || ''}`;
        const ownerB = `${b.owner || ''}:${b.group || ''}`;
        comparison = collator.compare(ownerA, ownerB);
        break;
      }

      case 'mtime': {
        const timeA = a.modified_at ? new Date(a.modified_at).getTime() : 0;
        const timeB = b.modified_at ? new Date(b.modified_at).getTime() : 0;
        const validA = Number.isNaN(timeA) ? 0 : timeA;
        const validB = Number.isNaN(timeB) ? 0 : timeB;
        comparison = validA - validB;
        break;
      }

      case 'permissions':
        comparison = collator.compare(a.permissions || '', b.permissions || '');
        break;
    }

    if (comparison !== 0) {
      return direction === 'desc' ? -comparison : comparison;
    }

    // 3. Secondary tie-breaker: always alphabetical by name
    return collator.compare(a.name, b.name);
  });
}

/**
 * Returns the recommended initial sort direction when clicking a new column.
 * - 'mtime' and 'size' start with 'desc' (most recent / largest first)
 * - others start with 'asc' (alphabetical)
 */
export function getDefaultDirection(column: SortColumn): SortDirection {
  return column === 'mtime' || column === 'size' ? 'desc' : 'asc';
}
