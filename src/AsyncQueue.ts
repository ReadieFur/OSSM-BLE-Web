export class AsyncFunctionQueue {
    #queue: Array<() => Promise<any>> = [];
    #isProcessing = false;

    /**
     * Enqueues an asynchronous function for sequential execution.
     */
    async enqueue<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.#queue.push(async () => {
                try { resolve(await fn()); }
                catch (err) { reject(err); }
            });
            this.processQueue();
        });
    }

    /**
     * Clears all pending tasks in the queue.
     */
    clearQueue(): void {
        this.#queue = [];
    }

    /**
     * Returns the current number of pending tasks in the queue.
     */
    get pendingCount(): number {
        return this.#queue.length;
    }

    private async processQueue(): Promise<void> {
        if (this.#isProcessing) return;
        this.#isProcessing = true;

        while (this.#queue.length > 0) {
            const task = this.#queue.shift();
            if (task) {
                try { await task(); }
                catch { /* Task errors are caught and handled by individual promise wrappers in enqueue() */ }
            }
        }

        this.#isProcessing = false;
    }
}
