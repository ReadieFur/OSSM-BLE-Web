export interface SingleEvent<Args extends any[] = []> {
    subscribe(callback: (...args: Args) => void): void;
    unsubscribe(callback: (...args: Args) => void): void;
}

export class SingleEventSource<Args extends any[] = []> implements SingleEvent<Args> {
    #listeners = new Set<(...args: Args) => void>();

    [Symbol.dispose](): void {
        this.#listeners.clear();
    }

    subscribe(callback: (...args: Args) => void): void {
        this.#listeners.add(callback);
    }

    unsubscribe(callback: (...args: Args) => void): void {
        this.#listeners.delete(callback);
    }

    dispatch(...args: Args): void {
        for (const listener of this.#listeners)
            listener(...args);
    };
}
