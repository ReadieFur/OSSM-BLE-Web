/**
 * Typings based on:
 * https://github.com/researchanddesire/rad-ble/blob/main/src/RadBle.cpp
 * https://github.com/researchanddesire/rad-ble/blob/main/protocol/rad-ble-v1.json
 * https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/services/communication/rad_ble.cpp#L570-L667
 */

export type RadStage = "accepted" | "completed" | "failed";

export interface RadResponse<T = unknown> {
    v: number;
    id: number;
    stage: RadStage;
    ok: boolean;
    code?: string;
    message?: string;
    result?: T;
    stateBefore?: string;
    stateAfter?: string;
}

export interface RadRequest {
    v: 1;
    id: number;
    op: string;
    path?: string;
    args?: Record<string, unknown>;
    lease?: number;
    ifState?: string;
}

export interface ProtocolInfo extends DeviceCapabilities {
    essentialState: string;
    maxMessageBytes: number;
    maxMtu: number;
    otaResumeTlsMs: number;
    stateHeartbeatMs: number;
    streamHeaderBytes: number;
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

export interface CatalogPage {
    page: number;
    pageSize: number;
    pages: number;
    resources: CatalogEntry[];
    total: number;
}


export interface DeviceCapabilities {
    capabilities: string[];
    capabilityHash: string;
    channels: number;
    deviceType: string;
    directFilesystemOta: boolean;
    directOta: boolean;
    libraryVersion: string;
    protocol: string;
    security: string;
    serviceUuid: string;
    version: number;
}

export interface OtaCapabilities {
    chunkMax: number;
    components: string[];
    direct: boolean;
    flashSizeBytes: number;
    framing: string;
    network: boolean;
    otaSlotSizeBytes: number;
    partitionLayout: string;
    verified: boolean;
}

export interface State<T extends string = string> {
    /** Active background operation string, if any */
    activeOperation: string;
    /** Current lease status summary */
    lease: {
        active: boolean;
        remainingMs?: number; // Only set if active
        owner?: number;
    },
    /** State snapshot counter */
    sequence: number;
    /** Application state string (e.g. "menu.idle") */
    state: T;
    /** System uptime in milliseconds */
    uptimeMs: number;
    /** RAD Protocol Version */
    v: number;
}
