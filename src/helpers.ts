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
