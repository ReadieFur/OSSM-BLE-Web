export function isClientBleCapable() {
    return !(!navigator.bluetooth || !navigator.bluetooth.requestDevice);
}

/** @internal */
export function enforceRange(value: number, min: number, max: number, errorStr?: string): void {
    if (value < min || value > max)
        throw new DOMException(errorStr ?? `Value must be between ${min} and ${max}`, "IndexSizeError");
}

/** @internal */
export type SnakeToCamelCase<S extends string> = S extends `${infer Head}_${infer Tail}`
    ? `${Lowercase<Head>}${Capitalize<SnakeToCamelCase<Tail>>}`
    : Lowercase<S>;
