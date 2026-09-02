import { useEffect, useState } from 'react';

/** Hash routing, so the built app works from any static host with no rewrites. */

export interface Route {
  path: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = raw.split('?');
  return {
    path: pathPart.split('/').filter(Boolean).map(decodeURIComponent),
    query: new URLSearchParams(queryPart ?? ''),
  };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(path: string, query?: Record<string, string>): void {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  window.location.hash = path + qs;
}

export function back(): void {
  if (window.history.length > 1) window.history.back();
  else navigate('/');
}

/**
 * Song ids are Dropbox paths and so contain slashes; they go in the query
 * string rather than a path segment, where a browser may normalise `%2F`.
 */
export const songUrl = (id: string, setlistId?: string) => {
  const query = new URLSearchParams({ id });
  if (setlistId) query.set('sl', setlistId);
  return `/song?${query.toString()}`;
};

/**
 * Setlists made by hand have a plain id, but one standing for an Ableton set
 * is named after the set's path — slashes and all — so it needs the query
 * string for the same reason a song does.
 */
export const setlistUrl = (id: string) => `/setlist?${new URLSearchParams({ id }).toString()}`;
