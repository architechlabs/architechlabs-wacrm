import { describe, expect, it, vi } from 'vitest';
import { ProfileInitializationCoordinator } from './profile-initialization';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('ProfileInitializationCoordinator', () => {
  it('joins getSession and INITIAL_SESSION work for the same user', async () => {
    const coordinator = new ProfileInitializationCoordinator();
    const pending = deferred<string>();
    const load = vi.fn(() => pending.promise);
    const apply = vi.fn();

    coordinator.setActiveUser('user-a');
    const getSessionWork = coordinator.run('user-a', load, apply);
    const initialSessionWork = coordinator.run('user-a', load, apply);

    expect(initialSessionWork).toBe(getSessionWork);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);

    pending.resolve('profile-a');
    await expect(getSessionWork).resolves.toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith('profile-a');
  });

  it("serializes a user switch and cannot apply the stale user's result", async () => {
    const coordinator = new ProfileInitializationCoordinator();
    const first = deferred<string>();
    const second = deferred<string>();
    const applied: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    coordinator.setActiveUser('user-a');
    const firstWork = coordinator.run(
      'user-a',
      async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        const value = await first.promise;
        concurrent -= 1;
        return value;
      },
      (value) => applied.push(value)
    );

    coordinator.setActiveUser('user-b');
    const secondLoad = vi.fn(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const value = await second.promise;
      concurrent -= 1;
      return value;
    });
    const secondWork = coordinator.run('user-b', secondLoad, (value) =>
      applied.push(value)
    );

    expect(secondLoad).not.toHaveBeenCalled();
    first.resolve('stale-profile-a');
    await expect(firstWork).resolves.toBe(false);
    expect(secondLoad).toHaveBeenCalledOnce();

    second.resolve('profile-b');
    await expect(secondWork).resolves.toBe(true);
    expect(applied).toEqual(['profile-b']);
    expect(maxConcurrent).toBe(1);
  });

  it('suppresses an in-flight result after SIGNED_OUT', async () => {
    const coordinator = new ProfileInitializationCoordinator();
    const pending = deferred<string>();
    const apply = vi.fn();

    coordinator.setActiveUser('user-a');
    const work = coordinator.run('user-a', () => pending.promise, apply);
    coordinator.setActiveUser(null);
    pending.resolve('stale-profile');

    await expect(work).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('treats signing back in as a new epoch even for the same user id', async () => {
    const coordinator = new ProfileInitializationCoordinator();
    const stale = deferred<string>();
    const applied: string[] = [];

    coordinator.setActiveUser('user-a');
    const staleWork = coordinator.run(
      'user-a',
      () => stale.promise,
      (value) => applied.push(value),
    );

    coordinator.setActiveUser(null);
    coordinator.setActiveUser('user-a');
    const currentWork = coordinator.run(
      'user-a',
      async () => 'current-profile',
      (value) => applied.push(value),
    );

    stale.resolve('stale-profile');
    await expect(staleWork).resolves.toBe(false);
    await expect(currentWork).resolves.toBe(true);
    expect(applied).toEqual(['current-profile']);
  });

  it('does not permanently suppress a retry after failure', async () => {
    const coordinator = new ProfileInitializationCoordinator();
    const apply = vi.fn();

    coordinator.setActiveUser('user-a');
    await expect(
      coordinator.run(
        'user-a',
        async () => {
          throw new Error('temporary failure');
        },
        apply
      )
    ).rejects.toThrow('temporary failure');

    await expect(
      coordinator.run('user-a', async () => 'recovered', apply)
    ).resolves.toBe(true);
    expect(apply).toHaveBeenCalledWith('recovered');
  });
});
