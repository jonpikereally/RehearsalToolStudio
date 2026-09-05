import { useState } from 'react';
import {
  choose,
  flip,
  readSort,
  rememberSort,
  SORT_KEYS,
  SORT_LABEL,
  type SortKey,
  type SortSpec,
} from '../lib/songSort';

/**
 * A row of the orders a list can take, one of them lit and carrying an arrow.
 *
 * Tap a field to sort by it. Tap the lit one twice to turn it over — a single
 * tap on it does nothing, so the list can't flip under a finger that only
 * meant to press. The arrow says which way up it is.
 */
export default function SortBar({
  sort,
  onChange,
  label = 'Order',
}: {
  sort: SortSpec;
  onChange: (next: SortSpec) => void;
  label?: string;
}) {
  return (
    <div className="controls flush sortbar" role="toolbar" aria-label="Sort the songs">
      <span className="control-label">{label}</span>
      {SORT_KEYS.map((key: SortKey) => {
        const on = sort.key === key;
        return (
          <button
            key={key}
            className={on ? 'chip on' : 'chip'}
            aria-pressed={on}
            onClick={() => onChange(choose(sort, key))}
            onDoubleClick={() => on && onChange(flip(sort))}
            title={on ? 'Double-tap to reverse' : `Sort by ${SORT_LABEL[key].toLowerCase()}`}
          >
            {SORT_LABEL[key]}
            {on && (
              <span className="sort-arrow" aria-label={sort.dir === 'asc' ? 'ascending' : 'descending'}>
                {sort.dir === 'asc' ? '↑' : '↓'}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The order for one list, remembered on this device under `storageKey`. */
export function useSort(storageKey: string): [SortSpec, (next: SortSpec) => void] {
  const [sort, setSort] = useState<SortSpec>(() => readSort(storageKey));
  return [
    sort,
    (next) => {
      rememberSort(storageKey, next);
      setSort(next);
    },
  ];
}
