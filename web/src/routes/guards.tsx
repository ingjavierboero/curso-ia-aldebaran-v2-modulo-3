import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useSession } from '../stores/session';

/** Pantallas con sesión. Sin usuarios lleva al registro; sin sesión, al login (RF-01). */
export function RequireAuth({ children }: { children: ReactNode }) {
  const needsSetup = useSession((s) => s.appInfo?.needsSetup);
  const user = useSession((s) => s.user);
  const location = useLocation();

  if (needsSetup) return <Navigate to="/setup" replace />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

/** Login: solo sin sesión y con al menos un usuario registrado. */
export function LoginRoute({ children }: { children: ReactNode }) {
  const needsSetup = useSession((s) => s.appInfo?.needsSetup);
  const user = useSession((s) => s.user);

  if (needsSetup) return <Navigate to="/setup" replace />;
  if (user) return <Navigate to="/" replace />;
  return children;
}

/** Registro del primer Admin: solo mientras no existe ningún usuario (RF-04, RF-05). */
export function SetupRoute({ children }: { children: ReactNode }) {
  const needsSetup = useSession((s) => s.appInfo?.needsSetup);
  const user = useSession((s) => s.user);

  if (!needsSetup) return <Navigate to={user ? '/' : '/login'} replace />;
  return children;
}

/** RF-204: pantallas que solo existen en modo mock. */
export function MockOnly({ children }: { children: ReactNode }) {
  const mockMode = useSession((s) => s.appInfo?.mockMode);
  if (!mockMode) return <Navigate to="/" replace />;
  return children;
}
