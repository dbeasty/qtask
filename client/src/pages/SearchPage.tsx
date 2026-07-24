import { useCallback, useEffect, useRef, useState } from 'react';
import { search as searchApi } from '../api/client';
import type { SearchHit, SearchResults } from '../types';

interface SearchPageProps {
  query: string;
  refreshKey?: number;
  onOpenProject: (projectId: string) => void;
  onOpenTask: (taskId: string) => void;
}

const STATUS_LABELS: Record<string, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

function ResultRow({
  hit,
  onSelect,
}: {
  hit: SearchHit;
  onSelect: () => void;
}) {
  return (
    <button type="button" className="search-result-row" onClick={onSelect}>
      <div className="search-result-main">
        <span className="search-result-type">{hit.type === 'project' ? 'Project' : 'Task'}</span>
        <span className="search-result-title">{hit.title}</span>
      </div>
      {hit.snippet ? <p className="search-result-snippet muted">{hit.snippet}</p> : null}
      <div className="search-result-meta">
        {hit.status ? (
          <span className="search-result-badge">{STATUS_LABELS[hit.status] ?? hit.status}</span>
        ) : null}
        {hit.projectNames?.length ? (
          <span className="search-result-projects muted">{hit.projectNames.join(', ')}</span>
        ) : null}
      </div>
    </button>
  );
}

export function SearchPage({ query, refreshKey = 0, onOpenProject, onOpenTask }: SearchPageProps) {
  const [results, setResults] = useState<SearchResults>({ projects: [], tasks: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const runSearch = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setResults({ projects: [], tasks: [] });
      setError(null);
      setLoading(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const next = await searchApi(trimmed);
      if (requestId !== requestIdRef.current) return;
      setResults(next);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : 'Search failed');
      setResults({ projects: [], tasks: [] });
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void runSearch(query);
    }, 300);
    return () => window.clearTimeout(handle);
  }, [query, refreshKey, runSearch]);

  const hasQuery = query.trim().length > 0;
  const hasResults = results.projects.length > 0 || results.tasks.length > 0;

  return (
    <div className="search-page">
      {loading ? <p className="search-status muted">Searching…</p> : null}
      {error ? <p className="search-status error-text">{error}</p> : null}

      {!loading && !error && hasQuery && !hasResults ? (
        <p className="search-status muted">No matching projects or tasks.</p>
      ) : null}

      {results.projects.length > 0 ? (
        <section className="search-results-section">
          <h2>Projects</h2>
          <div className="search-results-list">
            {results.projects.map((hit) => (
              <ResultRow key={hit.id} hit={hit} onSelect={() => onOpenProject(hit.id)} />
            ))}
          </div>
        </section>
      ) : null}

      {results.tasks.length > 0 ? (
        <section className="search-results-section">
          <h2>Tasks</h2>
          <div className="search-results-list">
            {results.tasks.map((hit) => (
              <ResultRow key={hit.id} hit={hit} onSelect={() => onOpenTask(hit.id)} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
