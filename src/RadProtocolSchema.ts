/**
 * Typings based on:
 * https://github.com/researchanddesire/rad-ble/blob/main/src/RadBle.cpp
 */

export type RadStage = "accepted" | "completed" | "failed";

export interface RadResponse<T = unknown> {
    v: number;
    id: number;
    stage: RadStage;
    ok: boolean;
    code?: ResultCode;
    message?: string;
    result?: T;
    stateBefore?: string;
    stateAfter?: string;
}
// https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L847
export interface RadRequest {
    v: 1;
    id: number;
    op: string;
    path?: string;
    args?: Record<string, unknown>;
    lease?: number;
    ifState?: string;
}

// https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/protocol/rad-ble-v1.json#L96
export enum ResultCode {
    Ok = "ok",
    Aborted = "aborted",
    BeginFailed = "begin_failed",
    Busy = "busy",
    CrcMismatch = "crc_mismatch",
    HardwareFault = "hardware_fault",
    HardwareUnavailable = "hardware_unavailable",
    ImageTooLarge = "image_too_large",
    IncompleteImage = "incomplete_image",
    InvalidArgs = "invalid_args",
    InvalidFrame = "invalid_frame",
    InvalidOffset = "invalid_offset",
    InvalidRequest = "invalid_request",
    InvalidSession = "invalid_session",
    InvalidState = "invalid_state",
    InvalidValue = "invalid_value",
    LeaseConflict = "lease_conflict",
    LeaseExpired = "lease_expired",
    LeaseReleased = "lease_released",
    LeaseRequired = "lease_required",
    NetworkFailed = "network_failed",
    NotReady = "not_ready",
    OtaNotStarted = "ota_not_started",
    OtaUnavailable = "ota_unavailable",
    OutOfMemory = "out_of_memory",
    PreflightFailed = "preflight_failed",
    ResourceUnavailable = "resource_unavailable",
    ResumeTimeout = "resume_timeout",
    ShaFailed = "sha_failed",
    ShaMismatch = "sha_mismatch",
    StorageFailed = "storage_failed",
    UnknownPath = "unknown_path",
    Unsupported = "unsupported",
    UnsupportedPartition = "unsupported_partition",
    VerifyFailed = "verify_failed",
    WriteFailed = "write_failed"
}

// https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L950
export interface ControlAcquireResult {
    lease: number;
    ttlMs: number;
}

// https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L2003
export interface ProtocolInfoCompact {
    protocol: string;
    version: number;
    libraryVersion: string;
    deviceType: string;
    serviceUuid: string;
    security: string;
    directOta: boolean;
    directFilesystemOta: boolean;
    channels: number;
    capabilityHash: string;
    capabilities: string[];
}

export interface ProtocolInfo extends ProtocolInfoCompact {
    maxMtu: number;
    maxMessageBytes: number;
    stateHeartbeatMs: number;
    essentialState: string;
    otaResumeTlsMs: number;
    streamHeaderBytes: number;
}

// https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1010
export interface OtaCapabilities {
    direct: boolean;
    network: boolean;
    verified: boolean;
    framing: string;
    chunkMax: number;
    flashSizeBytes: number;
    otaSlotSizeBytes: number;
    partitionLayout: string;
    components: string[];
}

// https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L2051
export interface CatalogPage {
    page: number;
    pageSize: number;
    total: number;
    pages: number;
    resources: CatalogEntry[];
}

// https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L2061
export interface CatalogEntry {
    id: string;
    path: string;
    category: string;
    type: object;
    units?: string;
    readable: boolean;
    writable: boolean;
    streamable: boolean;
    persistent: boolean;
    leaseRequired: boolean;
    safetyCritical: boolean;
    available: boolean;
    constraints: unknown;
}

// https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1966
export type State<T extends Record<string, unknown> = Record<string, unknown>> = T & {
    state: string;
    v: number;
    sequence: number;
    uptimeMs: number;
    activeOperation: string;
    lease: {
        active: boolean;
        owner?: number;
        expiresInMs?: number;
    }
}

// https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1121
export interface SensorReadManyEntry<T = unknown> {
    path: string;
    ok: boolean;
    code?: string;
    result?: T;
} 

// https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1593
export interface StreamResult {
    streamId: number;
    path: string;
    surface: string;
    rateHz: number;
    batchSize: 1;
    encoding: 'json-v1';
}

export type OtaComponent = "application" | "filesystem";

// https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1393
export interface OtaBeginResult {
    session: number;
    offset: 0;
    chunkMax: 480;
    size: number;
    component: OtaComponent;
}

// https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1204
export interface OtaResumeResult {
    session: number;
    offset: number;
    size: number;
    component: OtaComponent;
}

// https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1434
export interface OtaFinishResult {
    size: number;
    sha256: string;
    component: OtaComponent;
}

// https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1688
export interface WiFiScanResult {
    running: boolean;
    count: number;
    partial?: true;
    networks: {
        ssid: string;
        rssi: number;
        secure: boolean;
    }[];
}

// https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L760
export interface SetDeviceNameResult {
    name: string;
    default: string;
    custom: boolean;
    changed: boolean;
    maxBytes: number;
}
