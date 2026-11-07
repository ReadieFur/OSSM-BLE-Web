export function isClientBleCapable() {
    return !(!navigator.bluetooth || !navigator.bluetooth.requestDevice);
}

export function enforceRange(value: number, min: number, max: number, errorStr?: string): void {
    if (value < min || value > max)
        throw new DOMException(errorStr ?? `Value must be between ${min} and ${max}`, "IndexSizeError");
}
