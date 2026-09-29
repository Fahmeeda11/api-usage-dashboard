import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth.js';
import { LoginPage, SignupPage } from './features/auth/AuthPages.js';
import { BoardPage } from './features/board/BoardPage.js';
import { Spinner } from './components/ui.js';

/**
 * Gate for authenticated routes.
 *
 * The `isLoading` branch matters more than it looks. On a page reload the app
 * has no access token yet - it is mid-flight exchanging the refresh cookie for
 * one. Rendering the redirect during that window would bounce a signed-in user
 * to the login screen on every single refresh, which is exactly the bug that
 * makes people conclude cookie auth "doesn't work".
 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="size-6 text-slate-400" />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  return <>{children}</>;
}

/** Keep a signed-in user away from the login and signup screens. */
function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="size-6 text-slate-400" />
      </div>
    );
  }

  if (user) return <Navigate to="/board" replace />;

  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <RedirectIfAuthed>
            <LoginPage />
          </RedirectIfAuthed>
        }
      />
      <Route
        path="/signup"
        element={
          <RedirectIfAuthed>
            <SignupPage />
          </RedirectIfAuthed>
        }
      />
      <Route
        path="/board"
        element={
          <RequireAuth>
            <BoardPage />
          </RequireAuth>
        }
      />
      <Route path="/" element={<Navigate to="/board" replace />} />
      <Route path="*" element={<Navigate to="/board" replace />} />
    </Routes>
  );
}
