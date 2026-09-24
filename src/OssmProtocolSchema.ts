/**
 * Typings based on:
 * https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/services/communication/rad_ble.cpp
 */

import * as RadSchema from "./RadProtocolSchema";

// https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/services/communication/rad_ble.cpp#L574
export interface OssmStateSnapshot extends RadSchema.RadState {
    state: string;
}

// https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/services/communication/rad_ble.cpp#L584
export interface OssmEssentialSnapshot {
    state: string;
    powered: boolean;
    batteryPercent: number | null;
    charging: boolean | null;
    positionMm: number;
    sessionDistanceMeters: number;
    sessionStrokeCount: number;
}

// https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/services/communication/rad_ble.cpp#L601
export type OssmButtonSnapshot = Array<{
    id: string;
    pressed: boolean;
}>

export interface OssmReadResult<T> {
    path: string;
    value: T;
}

export interface OssmWifiStatus {
    connected: boolean;
    rssi?: number;
    ip?: string;
}

export interface OssmFirmwareProvenance {
    origin: string;
    keyId: string;
    provenanceId: string;
    imageSha256: string;
    compactJws: string;
}
