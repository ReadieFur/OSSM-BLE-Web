type ServiceDefinition<TCharacteristics extends Record<string, string>> = {
    uuid: string;
    characteristics: TCharacteristics;
}
export type ServicesDefinition = Record<string, ServiceDefinition<Record<string, string>>>

export async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export enum DOMExceptionError {
    InvalidState = "InvalidStateError",
    NetworkError = "NetworkError",
    Timeout = "TimeoutError",
    TypeError = "TypeError",
    OperationError = "OperationError",
    DataError = "DataError",
    AbortError = "AbortError",
}

//#region Voodoo compile time type manipulation magic
// I"m not even going to start to pretend to know how this works.

// Capitalize first letter helper
type CapitalizeFirst<S extends string> = S extends `${infer F}${infer R}` ? `${Uppercase<F>}${Lowercase<R>}` : S;

// Convert UPPER_SNAKE_CASE to camelCase
export type UpperSnakeToCamel<S extends string> =
    S extends `${infer Head}_${infer Tail}`
        ? `${Head extends Head ? Lowercase<Head> : never}${CamelCapitalize<Tail>}`
        : Lowercase<S>;

// Helper: capitalize each following word after underscore
type CamelCapitalize<S extends string> =
    S extends `${infer Head}_${infer Tail}`
        ? `${CapitalizeFirst<Lowercase<Head>>}${CamelCapitalize<Tail>}`
        : CapitalizeFirst<Lowercase<S>>;
//#endregion

export function upperSnakeToCamel(str: string): string {
    return str
        .toLowerCase()
        .split("_")
        .map((word, index) =>
            index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)
        )
        .join("");
}

export function gattRead(characteristic: BluetoothRemoteGATTCharacteristic): Promise<DataView> {
    return characteristic.readValue();
}

export class AsyncFunctionQueue {
    private chain: Promise<any> = Promise.resolve();
    private currentAbort?: AbortController;
    // Generation token to invalidate queued tasks
    private generation = 0;

    private withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
        let timer: number;

        return new Promise<T>((resolve, reject) => {
            if (signal?.aborted) {
                reject(signal.reason);
                return;
            }

            const onAbort = () => {
                clearTimeout(timer);
                reject(signal!.reason);
            };

            signal?.addEventListener("abort", onAbort, { once: true });

            timer = window.setTimeout(() => reject(new DOMException("Timeout", DOMExceptionError.Timeout)), ms);

            p.then(
                value => {
                    clearTimeout(timer);
                    signal?.removeEventListener("abort", onAbort);
                    resolve(value);
                },
                error => {
                    clearTimeout(timer);
                    signal?.removeEventListener("abort", onAbort);
                    reject(error);
                }
            );
        });
    }

    clearQueue(): void {
        this.generation++;
        this.currentAbort?.abort(new DOMException("Operation aborted due to queue clear", DOMExceptionError.AbortError));
        this.chain = Promise.resolve();
    }

    enqueue<T>(func: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const capturedGeneration = this.generation;

        const task = async () => {
            if (capturedGeneration !== this.generation)
                throw new DOMException('Queue cleared', 'AbortError');

            this.currentAbort = new AbortController();

            try {
                return await func(this.currentAbort.signal);
            } finally {
                this.currentAbort = undefined;
            }
        };

        const next = this.chain.then(task, task);
        this.chain = next.catch(() => {});
        return next;
    }

    enqueueWithTimeout<T>(func: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
        return this.enqueue(signal =>
            this.withTimeout(func(signal), timeoutMs, signal)
        );
    }

    /** Force-fail the currently running task */
    abortCurrent(reason = "Operation aborted"): void {
        this.currentAbort?.abort(new DOMException(reason, DOMExceptionError.AbortError));
    }
}
