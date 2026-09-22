type QueueItem = {
    execute: () => Promise<void>;
    reject: (reason: Error) => void;
};

export class AsyncFunctionQueue {
    #queue: Array<QueueItem> = [];
    #isProcessing = false;

    /**
     * Returns the current number of pending tasks in the queue.
     */
    get pendingCount(): number {
        return this.#queue.length;
    }

    /**
     * Enqueues an asynchronous function for sequential execution.
     */
    async enqueue<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const queueItem: QueueItem = {
                execute: async () => {
                    try { resolve(await fn()); }
                    catch (err) { reject(err); }
                },
                reject
            };
            this.#queue.push(queueItem);
            this.processQueue();
        });
    }

    /**
     * Prepends an asynchronous function to the front of the queue for sequential execution.
     */
    async prepend<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const queueItem: QueueItem = {
                execute: async () => {
                    try { resolve(await fn()); }
                    catch (err) { reject(err); }
                },
                reject
            };
            this.#queue.unshift(queueItem);
            this.processQueue();
        });
    }

    /**
     * Clears all pending tasks in the queue.
     */
    clearQueue(reason?: Error | string): void {
        const error = typeof reason === 'string' ? new DOMException(reason, "AbortError") : (reason ?? new DOMException("Queue cleared", "AbortError"));
        
        const pendingItems = [...this.#queue]; // Create a copy of the queue instead of grabbing the reference since the write of [] to it would clear the local variable too
        this.#queue = [];
        
        for (const item of pendingItems)
            item.reject(error);
    }

    private async processQueue(): Promise<void> {
        if (this.#isProcessing) return;
        this.#isProcessing = true;

        while (this.#queue.length > 0) {
            const item = this.#queue.shift();
            if (item) {
                try { await item.execute(); }
                catch { /* Task errors are caught and handled by individual promise wrappers in enqueue() */ }
            }
        }

        this.#isProcessing = false;
    }
}
