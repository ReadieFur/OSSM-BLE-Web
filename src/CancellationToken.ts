// Based on C#'s CancellationToken

export interface CancellationTokenRegistration {
    unregister: () => void;
}

export interface ICancellationToken {
    readonly isCancellationRequested: boolean;
    readonly reason?: string;
    readonly signal: AbortSignal;
    throwIfCancellationRequested(): void;
    register(callback: (reason?: string) => void): CancellationTokenRegistration
}

export class CancellationToken implements ICancellationToken {
    static readonly None: ICancellationToken = new CancellationToken();

    readonly #controller = new AbortController();
    #reason?: string;
    readonly #listeners = new Set<(reason?: string) => void>();

    get isCancellationRequested(): boolean {
        return this.#controller.signal.aborted;
    }

    get reason(): string | undefined {
        return this.#reason;
    }

    get signal(): AbortSignal {
        return this.#controller.signal;
    }

    throwIfCancellationRequested(): void {
        if (this.isCancellationRequested)
            throw new DOMException("The operation was canceled.", "AbortError");
    }

    register(callback: (reason?: string) => void): { unregister: () => void } {
        if (this.isCancellationRequested) {
            callback(this.#reason);
            return { unregister: () => {} };
        }

        this.#listeners.add(callback);
        return { unregister: () => this.#listeners.delete(callback) };
    }

    _cancel(reason?: string): void {
        if (this.isCancellationRequested) return;

        this.#reason = reason ?? "The operation was canceled.";
        this.#controller.abort(this.#reason);

        for (const listener of Array.from(this.#listeners)) {
            try { listener(this.#reason); }
            catch (err) { /* Ignore callback errors */ }
        }
        this.#listeners.clear();
    }
}

export class CancellationTokenSource implements Disposable {
    static createWithTimeout(delayMs: number, reason?: string): CancellationTokenSource {
        const cts = new CancellationTokenSource();
        cts.#cancelAfter(delayMs, reason);
        return cts;
    }

    readonly #token = new CancellationToken();
    #timerId?: ReturnType<typeof setTimeout>;
    #isDisposed = false;

    get token(): ICancellationToken {
        return this.#token;
    }

    get isCancellationRequested(): boolean {
        return this.#token.isCancellationRequested;
    }

    cancel(reason?: string): void {
        if (this.#isDisposed) return;
        this.#clearTimer();
        (this.#token as CancellationToken)._cancel(reason);
    }

    dispose(): void {
        if (this.#isDisposed) return;
        this.#clearTimer();
        this.#isDisposed = true;
    }

    [Symbol.dispose](): void {
        this.dispose();
    }

    #cancelAfter(delayMs: number, reason?: string): void {
        if (this.#isDisposed || this.isCancellationRequested) return;

        this.#clearTimer();
        this.#timerId = setTimeout(() => this.cancel(reason ?? `Operation timed out after ${delayMs}ms.`), delayMs);
    }

    #clearTimer(): void {
        if (this.#timerId === undefined) return;
        clearTimeout(this.#timerId);
        this.#timerId = undefined;
    }
}
