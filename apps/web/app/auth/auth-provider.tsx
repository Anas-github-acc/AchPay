'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type AuthRole = 'merchant' | 'client';
export type AuthProviderName = 'google' | 'demo';
export interface AuthState {
  isAuthenticated: boolean;
  role: AuthRole | null;
  isDemo: boolean;
  authProvider: AuthProviderName | null;
  user: { id: string } | null;
}

const initialState: AuthState = { isAuthenticated: false, role: null, isDemo: false, authProvider: null, user: null };
const AuthContext = createContext<AuthState>(initialState);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(initialState);
  useEffect(() => {
    fetch('/api/auth/session', { cache: 'no-store' })
      .then((response) => response.json() as Promise<AuthState>)
      .then(setState)
      .catch(() => setState(initialState));
  }, []);
  const value = useMemo(() => state, [state]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState { return useContext(AuthContext); }
