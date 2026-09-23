export interface ProtocolInfo {
    capabilities: string[];
    capabilityHash: string;
    channels: number;
    deviceType: string;
    directFilesystemOta: boolean;
    directOta: boolean;
    essentialState: string;
    libraryVersion: string;
    maxMessageBytes: number;
    maxMtu: number;
    otaResumeTlsMs: number;
    protocol: string;
    security: string;
    serviceUuid: string;
    stateHeartbeatMs: number;
    streamHeaderBytes: number;
    version: number;
}

export interface CatalogPage {
    page: number;
    pageSize: number;
    pages: number;
    resources: CatalogEntry[];
    total: number;
}

export interface CatalogEntry {
    available: boolean;
    category: string;
    constraints: unknown;
    id: string;
    leaseRequired: boolean;
    path: string;
    readable: boolean;
    safetyCritical: boolean;
    streamable: boolean;
    type: object;
    writable: boolean;
}
