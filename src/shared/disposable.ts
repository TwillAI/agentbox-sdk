export type AsyncCleanup = () => void | Promise<void>;

export class AsyncDisposer {
  private readonly cleanups: AsyncCleanup[] = [];

  add(cleanup: AsyncCleanup): void {
    this.cleanups.push(cleanup);
  }

  async dispose(): Promise<void> {
    const errors: unknown[] = [];

    while (this.cleanups.length > 0) {
      const cleanup = this.cleanups.pop();

      try {
        await cleanup?.();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }

    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Multiple async cleanup operations failed.",
      );
    }
  }
}
