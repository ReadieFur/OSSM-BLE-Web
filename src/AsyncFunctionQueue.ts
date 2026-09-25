type QueueItem = {
    signature: Function;
    execute: () => Promise<void>;
    reject: (reason: Error) => void;
    timer?: number;
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
    async enqueue<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.#queue.push(this.#createQueueItem(fn, resolve, reject, timeoutMs));
            this.#processQueue();
        });
    }

    /**
     * Prepends an asynchronous function to the front of the queue for sequential execution.
     */
    async prepend<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.#queue.unshift(this.#createQueueItem(fn, resolve, reject, timeoutMs));
            this.#processQueue();
        });
    }

    /**
     * Replaces an queued task with a new task.
     * @note If found, the original caller's promise is rejected with `reason`.
     * @throws `NotFoundError` if the targetFunction does not exist
     */
    async replace<T>(
        targetFn: Function,
        newFn: () => Promise<T>,
        reason?: Error | string,
        timeoutMs?: number
    ): Promise<T> {
        const index = this.#queue.findIndex(item => item.signature === targetFn);

        if (index === -1)
            throw new DOMException("Task not found in queue", "NotFoundError");

        // Remove the old task and reject so it's promise does not hang
        const [evicted] = this.#queue.splice(index, 1);
        this.#clearItemTimer(evicted);

        const error = typeof reason === 'string'
            ? new DOMException(reason, "AbortError")
            : (reason ?? new DOMException("Task replaced in queue", "AbortError"));
        evicted.reject(error);

        // Insert the new task at the exact same queue position
        return new Promise<T>((resolve, reject) => {
            const queueItem = this.#createQueueItem(newFn, resolve, reject, timeoutMs);
            this.#queue.splice(index, 0, queueItem);
        });
    }

    /**
     * Attempts to replace a function in the queue, otherwise the new function is placed at the end of the queue
     */
    async replaceOrEnqueue<T>(
        targetFn: Function,
        newFn: () => Promise<T>,
        reason?: Error | string,
        timeoutMs?: number
    ) {
        try { return this.replace(targetFn, newFn, reason, timeoutMs); }
        catch { return this.enqueue(newFn, timeoutMs); }
    }

    /**
     * Removes a queued task
     * Returns true if the item was found and removed, false otherwise.
     */
    remove(targetFn: Function, reason?: Error | string): boolean {
        const index = this.#queue.findIndex(item => item.signature === targetFn);

        if (index === -1) return false;

        const [evicted] = this.#queue.splice(index, 1);
        this.#clearItemTimer(evicted);

        const error = typeof reason === 'string'
            ? new DOMException(reason, "AbortError")
            : (reason ?? new DOMException("Task removed from queue", "AbortError"));
        evicted.reject(error);

        return true;
    }

    /**
     * Clears all pending tasks in the queue.
     */
    clearQueue(reason?: Error | string): void {
        const error = typeof reason === 'string'
            ? new DOMException(reason, "AbortError")
            : (reason ?? new DOMException("Queue cleared", "AbortError"));

        const pendingItems = [...this.#queue]; // Create a copy of the queue instead of grabbing the reference since the write of [] to it would clear the local variable too
        this.#queue = [];
        
        for (const item of pendingItems) {
            this.#clearItemTimer(item);
            item.reject(error);
        }
    }

    #createQueueItem<T>(
        fn: () => Promise<T>,
        resolve: (value: T | PromiseLike<T>) => void,
        reject: (reason: Error) => void,
        timeoutMs?: number
    ): QueueItem {
        const queueItem: QueueItem = {
            signature: fn,
            execute: async () => {
                try {
                    const result = await fn();
                    this.#clearItemTimer(queueItem);
                    resolve(result);
                } catch (err) {
                    this.#clearItemTimer(queueItem);
                    reject(err as Error);
                }
            },
            reject: (err: Error) => {
                this.#clearItemTimer(queueItem);
                reject(err);
            }
        };

        if (timeoutMs !== undefined && timeoutMs > 0) {
            queueItem.timer = window.setTimeout(() => {
                // Remove the item if it is still in the queue since we have timed out
                const index = this.#queue.indexOf(queueItem);
                if (index !== -1)
                    this.#queue.splice(index, 1);
                queueItem.reject(new DOMException(`Task timed out after ${timeoutMs}ms`, "TimeoutError"));
            }, timeoutMs);
        }

        return queueItem;
    }

    #clearItemTimer(item: QueueItem): void {
        if (item.timer !== undefined) {
            window.clearTimeout(item.timer);
            item.timer = undefined;
        }
    }

    async #processQueue(): Promise<void> {
        if (this.#isProcessing) return;
        this.#isProcessing = true;

        while (this.#queue.length > 0) {
            const item = this.#queue.shift();
            if (item) {
                try { await item.execute(); }
                catch { /* Task errors are caught and handled by individual promise wrappers in #createQueueItem */ }
            }
        }

        this.#isProcessing = false;
    }
}
