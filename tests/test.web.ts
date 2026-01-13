export class Assert {
    static condition(condition: any, message?: string): asserts condition {
        if (!condition)
            throw new Error(message || "Assertion failed");
    }

    static true(condition: boolean, message?: string): void {
        if (!condition)
            throw new Error(message || "Assertion failed: condition is not true");
    }

    static false(condition: boolean, message?: string): void {
        if (condition)
            throw new Error(message || "Assertion failed: condition is not false");
    }

    static equals<T>(actual: T, expected: T): void {
        if (actual !== expected)
            throw new Error(`Assertion failed: expected ${expected}, but got ${actual}`);
    }

    static notEquals<T>(actual: T, expected: T): void {
        if (actual === expected)
            throw new Error(`Assertion failed: expected value not to be ${expected}`);
    }

    static exists<T>(value: T | null | undefined, message?: string): asserts value is T {
        if (value === null || value === undefined)
            throw new Error(message || "Assertion failed: value is null or undefined");
    }

    static notExists<T>(value: T | null | undefined, message?: string): void {
        if (value !== null && value !== undefined)
            throw new Error(message || "Assertion failed: value is not null or undefined");
    }

    static async throws(fn: () => Promise<void> | void, message?: string): Promise<void> {
        let errorCaught = false;
        try {
            await fn();
        } catch {
            errorCaught = true;
        }
        if (!errorCaught)
            throw new Error(message || "Expected function to throw an error, but it did not.");
    }

}
