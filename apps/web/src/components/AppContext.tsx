import { createContext, useContext, type ReactNode } from 'react';
import { useApi, type ApiState } from '../hooks';
import { DEFAULT_TIMEZONE } from '../lib/dates';
import type { AdminContext } from '../types';

const AdminCtx = createContext<ApiState<AdminContext> | undefined>(undefined);
const TimezoneCtx = createContext<string | undefined>(undefined);

/** Loads /api/v1/admin once for the nav badges and shares it (and its refetch) with every screen. */
export function AdminProvider({ children }: { children: ReactNode }) {
  const state = useApi<AdminContext>('/api/v1/admin', { pollMs: 60_000 });
  return <AdminCtx.Provider value={state}>{children}</AdminCtx.Provider>;
}

export function useAdmin(): ApiState<AdminContext> {
  const ctx = useContext(AdminCtx);
  if (!ctx) throw new Error('useAdmin outside AdminProvider');
  return ctx;
}

/** Pages wrap their content in this with the `timezone` field of their response. */
export function TimezoneProvider({
  value,
  children,
}: {
  value: string | undefined;
  children: ReactNode;
}) {
  return <TimezoneCtx.Provider value={value}>{children}</TimezoneCtx.Provider>;
}

export function useTimezone(): string {
  const own = useContext(TimezoneCtx);
  const admin = useContext(AdminCtx);
  return own ?? admin?.data?.timezone ?? DEFAULT_TIMEZONE;
}
