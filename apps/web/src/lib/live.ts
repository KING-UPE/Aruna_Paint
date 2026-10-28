import type { QueryClient } from '@tanstack/react-query';

/**
 * Listens to the server's live events (a sale or purchase anywhere) and refreshes the lists that
 * show stock, so counters never show stale stock. Reconnects after a drop.
 */
export function connectLive(queryClient: QueryClient): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let retry: number | undefined;

  const open = () => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${window.location.host}/api/live`);
    socket.onmessage = (msg) => {
      const event = JSON.parse(String(msg.data)) as { type: string };
      if (event.type === 'stock' || event.type === 'products') {
        void queryClient.invalidateQueries({ queryKey: ['billing-items'] });
        void queryClient.invalidateQueries({ queryKey: ['products'] });
        void queryClient.invalidateQueries({ queryKey: ['product'] });
        void queryClient.invalidateQueries({ queryKey: ['mix'] });
      }
      if (event.type === 'sale')
        void queryClient.invalidateQueries({ queryKey: ['billing-status'] });
      if (event.type === 'settings') void queryClient.invalidateQueries({ queryKey: ['me'] });
      // Test mode switched: the data underneath changed, so everything reloads.
      if (event.type === 'testmode') void queryClient.invalidateQueries();
    };
    socket.onclose = () => {
      if (!stopped) retry = window.setTimeout(open, 5000);
    };
  };
  open();
  return () => {
    stopped = true;
    window.clearTimeout(retry);
    socket?.close();
  };
}
