import { Link, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { Layout } from './components/Layout';
import { PageHeader } from './components/ui';
import { AssignmentsPage } from './pages/AssignmentsPage';
import { CalendarPage } from './pages/CalendarPage';
import { ChangesPage } from './pages/ChangesPage';
import { ConflictsPage } from './pages/ConflictsPage';
import { CourseDetailPage } from './pages/CourseDetailPage';
import { CoursesPage } from './pages/CoursesPage';
import { SearchPage } from './pages/SearchPage';
import { SettingsPage } from './pages/SettingsPage';
import { SourcesPage } from './pages/SourcesPage';
import { TodayPage } from './pages/TodayPage';
import { usePageTitle } from './hooks';

function NotFound() {
  usePageTitle('見つかりません');
  return (
    <>
      <PageHeader title="ページが見つかりません" />
      <p>
        <Link to="/">今日へ</Link>
      </p>
    </>
  );
}

const rootRoute = createRootRoute({ component: Layout, notFoundComponent: NotFound });

const todayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: TodayPage,
});
const coursesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/courses',
  component: CoursesPage,
});
const courseDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/courses/$id',
  component: CourseDetailPage,
});
const assignmentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/assignments',
  component: AssignmentsPage,
});
const calendarRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/calendar',
  component: CalendarPage,
});
const changesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/changes',
  component: ChangesPage,
});
const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/search',
  validateSearch: (search: Record<string, unknown>): { q?: string } =>
    typeof search.q === 'string' && search.q !== '' ? { q: search.q } : {},
  component: SearchPage,
});
const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sources',
  component: SourcesPage,
});
const conflictsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/conflicts',
  component: ConflictsPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  todayRoute,
  coursesRoute,
  courseDetailRoute,
  assignmentsRoute,
  calendarRoute,
  changesRoute,
  searchRoute,
  sourcesRoute,
  conflictsRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree, defaultPreload: false });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
