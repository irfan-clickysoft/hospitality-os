import { useState } from 'react';
import { Login } from './screens/Login.js';
import { Invite } from './screens/Invite.js';
import { StepUpProvider } from './lib/stepup.js';
import { AuthProvider, useAuth, WorkProvider } from './state.js';
import { Spinner } from './ui/kit.js';
import { AppShell } from './shell/AppShell.js';

function Gate() {
  const { status, me } = useAuth();
  const [invite, setInvite] = useState(() => { const q = new URLSearchParams(window.location.search); const token = q.get('invite'); const tenant = q.get('tenant'); return token && tenant ? { token, tenant } : null; });
  if (invite) return <Invite tenant={invite.tenant} token={invite.token} onDone={() => { window.history.replaceState(null, '', window.location.pathname); setInvite(null); }} />;
  if (status === 'loading') return <Spinner />;
  if (status === 'out' || status === 'mfa') return <Login />;
  return <WorkProvider userId={me!.user.id}><StepUpProvider><AppShell /></StepUpProvider></WorkProvider>;
}
export function App() { return <AuthProvider><Gate /></AuthProvider>; }
