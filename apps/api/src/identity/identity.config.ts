export interface IdentityConfig {
  idleMinutes: number; absoluteHours: number; stepUpMinutes: number; lockoutThreshold: number; lockoutMinutes: number;
  allowedOrigins: string[]; cookieName: string; cookieSecure: boolean; issuer: string; mfaMaxFailures: number;
}

export function loadIdentityConfig(env: NodeJS.ProcessEnv = process.env): IdentityConfig {
  const insecureDev = env.COOKIE_INSECURE_DEV === '1';
  if (insecureDev && env.NODE_ENV === 'production') throw new Error('COOKIE_INSECURE_DEV must never be set in production');
  return {
    idleMinutes: 60, absoluteHours: 12, stepUpMinutes: 15, lockoutThreshold: 5, lockoutMinutes: 15, mfaMaxFailures: 5,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    cookieName: insecureDev ? 'hos_session' : '__Host-hos_session', cookieSecure: !insecureDev, issuer: env.MFA_ISSUER ?? 'Hospitality OS',
  };
}
