import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { enc } from '../api';
import { useTimezone } from '../components/AppContext';
import { KindBadge } from '../components/Cards';
import { Citations } from '../components/Citations';
import { Async, Badge, Empty, PageHeader } from '../components/ui';
import { useApi, usePageTitle } from '../hooks';
import { formatShort } from '../lib/dates';
import { searchViaLabel } from '../lib/labels';
import type { SearchResponse } from '../types';

export function SearchPage() {
  usePageTitle('検索');
  const { q } = useSearch({ strict: false }) as { q?: string };
  const navigate = useNavigate();
  const [text, setText] = useState(q ?? '');
  useEffect(() => setText(q ?? ''), [q]);
  const state = useApi<SearchResponse>(q ? `/api/v1/search?q=${enc(q)}` : null);

  function submit(e: FormEvent): void {
    e.preventDefault();
    const next = text.trim();
    void navigate({ to: '/search', search: next ? { q: next } : {} });
  }

  return (
    <>
      <PageHeader title="検索" />
      <form className="search-form" role="search" onSubmit={submit}>
        <input
          type="search"
          name="q"
          aria-label="検索語"
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus={!q}
        />
        <button type="submit">検索</button>
      </form>
      {q ? <Async state={state}>{(res) => <Results hits={res.hits} />}</Async> : null}
    </>
  );
}

function Results({ hits }: { hits: SearchResponse['hits'] }) {
  const tz = useTimezone();
  if (hits.length === 0) return <Empty />;
  return (
    <>
      <p className="meta" role="status">
        {hits.length}件
      </p>
      <ul className="plain-list stack">
        {hits.map((h) => (
          <li key={`${h.kind}-${h.id}`} className="card">
            <header className="card-head">
              <KindBadge kind={h.kind} />
              <h2 className="card-title">{h.title}</h2>
              {h.at ? (
                <time className="meta" dateTime={h.at}>
                  {formatShort(h.at, tz)}
                </time>
              ) : null}
              <Badge>{searchViaLabel(h.via)}</Badge>
            </header>
            {h.snippet ? <p className="snippet">{h.snippet}</p> : null}
            <Citations citations={h.citations} />
          </li>
        ))}
      </ul>
    </>
  );
}
