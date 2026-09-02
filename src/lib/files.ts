/**
 * One file, as a listing of the folder reports it.
 *
 * Paths are '/'-joined from the folder's root with a leading slash, and `rev`
 * changes whenever the file does — modified time and size — so a re-exported
 * stem is noticed and its cached renders thrown away.
 */
export interface FileEntry {
  path: string;
  name: string;
  rev: string;
  size: number;
  /** Epoch ms, used to tell newer copies of a project file from older ones. */
  modified: number;
}
