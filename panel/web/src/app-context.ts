import { createContext, useContext } from 'react';
import type { CspIdentity } from './types';

export interface AppContextValue {
  identity: CspIdentity;
  /** Auto-refresh interval in ms, 0 = off. */
  interval: number;
  /** Global profile filter, empty string = all profiles. */
  profile: string;
  setProfile: (p: string) => void;
  /** Called when the API answers 401 so the shell can show the login form. */
  onUnauthorized: () => void;
  mock: boolean;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('AppContext missing');
  return ctx;
}
