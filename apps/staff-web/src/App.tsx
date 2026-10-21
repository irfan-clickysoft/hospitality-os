import { lazy, Suspense, useState } from 'react';
import { LocaleProvider } from './i18n/index.js';
import { Login } from './screens/Login.js';
import { Invite } from './screens/Invite.js';
import { StepUpProvider } from './lib/stepup.js';
import { AuthProvider, useAuth, WorkProvider } from './state.js';
import { Spinner } from './ui/kit.js';
import { AppShell } from './shell/AppShell.js';

const GuestBooking = lazy(() => import('./pages/GuestBooking.js').then((m) => ({ default: m.GuestBooking })));

function Gate() {
  const { status, me } = useAuth();
  const [invite, setInvite] = useState(() => { const q = new URLSearchParams(window.location.search); const token = q.get('invite'); const tenant = q.get('tenant'); return token && tenant ? { token, tenant } : null; });
  if (invite) return <Invite tenant={invite.tenant} token={invite.token} onDone={() => { window.history.replaceState(null, '', window.location.pathname); setInvite(null); }} />;
  if (status === 'loading') return <Spinner />;
  if (status === 'out' || status === 'mfa') return <Login />;
  return <WorkProvider userId={me!.user.id}><StepUpProvider><AppShell /></StepUpProvider></WorkProvider>;
}
/** The guest's own booking page opens from a link and needs no sign-in, so it never touches the staff session. */
const guestToken = () => /^#\/b\/([0-9a-f]{32}-[0-9a-f]{32})$/.exec(window.location.hash)?.[1] ?? null;
export function App() {
  const token = guestToken();
  if (token) return <LocaleProvider><Suspense fallback={<Spinner />}><GuestBooking token={token} /></Suspense></LocaleProvider>;
  return <AuthProvider><Gate /></AuthProvider>;
}
