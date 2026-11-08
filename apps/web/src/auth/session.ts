import { api } from '@/lib/api';

/**
 * One person's screens never carry over to the next: signing out, signing in, or a PIN that
 * switches to another user reloads the app on the Main menu, so nothing the previous user had
 * open (a Super Admin's settings, users, profit figures, the page itself) stays on the screen.
 */
export function startFresh(path = '/menu'): void {
  window.location.replace(path);
}

/** Signs out on the server, then starts the screens again from the sign-in page. */
export async function signOut(): Promise<void> {
  await api.post('/api/auth/logout', {}).catch(() => undefined);
  startFresh('/');
}
