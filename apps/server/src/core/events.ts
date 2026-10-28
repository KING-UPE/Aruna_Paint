/**
 * Live updates pushed to every open screen over the WebSocket, e.g. stock changed after a sale,
 * so counters never show stale stock. Published only after the transaction commits.
 */
export type LiveEvent =
  | { type: 'stock'; subProductIds: string[] }
  | { type: 'products' }
  | { type: 'sale'; counterId: string }
  | { type: 'settings' }
  /** Every screen reloads everything: the data underneath changed. */
  | { type: 'testmode'; on: boolean };

type Listener = (event: LiveEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  publish(event: LiveEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // A broken socket must never break billing.
      }
    }
  }
}
