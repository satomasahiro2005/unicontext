import { useEffect, useRef } from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { countUnhealthy } from '../lib/labels';
import { useAdmin } from './AppContext';
import { ErrorAlert } from './ui';

export function Layout() {
  const admin = useAdmin();
  const mainRef = useRef<HTMLElement>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [pathname]);

  const conflicts = admin.data?.conflicts.length ?? 0;
  const unhealthy = countUnhealthy(admin.data?.sources ?? []);

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        本文へ移動
      </a>
      <header className="app-header">
        <Link to="/" className="brand">
          UniContext
        </Link>
        <nav aria-label="メイン">
          <ul>
            <li>
              <Link to="/" activeOptions={{ exact: true }}>
                今日
              </Link>
            </li>
            <li>
              <Link to="/courses">授業</Link>
            </li>
            <li>
              <Link to="/assignments">課題</Link>
            </li>
            <li>
              <Link to="/calendar">カレンダー</Link>
            </li>
            <li>
              <Link to="/announcements">お知らせ</Link>
            </li>
            <li>
              <Link to="/changes">変更</Link>
            </li>
            <li>
              <Link to="/search">検索</Link>
            </li>
            <li>
              <Link to="/sources">
                ソース
                {unhealthy > 0 ? (
                  <>
                    <span className="dot" aria-hidden="true" />
                    <span className="sr-only">要確認{unhealthy}件</span>
                  </>
                ) : null}
              </Link>
            </li>
            <li>
              <Link to="/conflicts">
                競合
                {conflicts > 0 ? (
                  <>
                    <span className="nav-count" aria-hidden="true">
                      {conflicts}
                    </span>
                    <span className="sr-only">未解決{conflicts}件</span>
                  </>
                ) : null}
              </Link>
            </li>
            <li>
              <Link to="/settings">設定</Link>
            </li>
          </ul>
        </nav>
      </header>
      <main id="main" ref={mainRef} tabIndex={-1}>
        {admin.error && !admin.data ? (
          <ErrorAlert error={admin.error} onRetry={() => void admin.refetch()} />
        ) : null}
        <Outlet />
      </main>
    </div>
  );
}
