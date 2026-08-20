/**
 * Serializes profile/account initialization across Supabase auth callbacks.
 *
 * Supabase can emit INITIAL_SESSION while the provider's explicit
 * getSession() call is still resolving. Both paths may ask for the same
 * profile at once. This coordinator joins identical work, serializes user
 * switches, and only applies the result for the latest active user epoch.
 */
export class ProfileInitializationCoordinator {
  private activeUserId: string | null = null;
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();
  private current:
    | {
        requestId: symbol;
        userId: string;
        generation: number;
        promise: Promise<boolean>;
      }
    | undefined;

  setActiveUser(userId: string | null): boolean {
    if (userId === this.activeUserId) return false;
    this.activeUserId = userId;
    this.generation += 1;
    return true;
  }

  isActive(userId: string): boolean {
    return this.activeUserId === userId;
  }

  invalidate(): void {
    this.activeUserId = null;
    this.generation += 1;
  }

  run<T>(
    userId: string,
    load: (isCurrent: () => boolean) => Promise<T>,
    apply: (value: T) => void
  ): Promise<boolean> {
    if (userId !== this.activeUserId) return Promise.resolve(false);

    const generation = this.generation;
    if (
      this.current?.userId === userId &&
      this.current.generation === generation
    ) {
      return this.current.promise;
    }

    const previous = this.tail;
    const requestId = Symbol('profile-initialization');
    const promise = (async () => {
      try {
        await previous;
        if (!this.isCurrent(userId, generation)) return false;

        const value = await load(() => this.isCurrent(userId, generation));
        if (!this.isCurrent(userId, generation)) return false;

        apply(value);
        return true;
      } finally {
        if (this.current?.requestId === requestId) this.current = undefined;
      }
    })();

    this.current = { requestId, userId, generation, promise };
    // Keep the serial queue usable after a failed load. The caller still
    // receives the original rejection and may surface/log it.
    this.tail = promise.then(
      () => undefined,
      () => undefined
    );
    return promise;
  }

  private isCurrent(userId: string, generation: number): boolean {
    return this.activeUserId === userId && this.generation === generation;
  }
}
