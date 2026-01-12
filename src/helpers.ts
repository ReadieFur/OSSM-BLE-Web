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
}

//#region Voodoo compile time type manipulation magic
// I'm not even going to start to pretend to know how this works.

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
        .split('_')
        .map((word, index) =>
            index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)
        )
        .join('');
}

export function gattRead(characteristic: BluetoothRemoteGATTCharacteristic): Promise<DataView> {
    return characteristic.readValue();
}
