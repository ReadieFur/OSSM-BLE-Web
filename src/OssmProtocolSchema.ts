/**
 * Typings based on:
 * https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/services/communication/rad_ble.cpp
 */

import * as RadSchema from "./RadProtocolSchema";

// #region Surface
// https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/services/communication/rad_ble.cpp#L570

export interface OssmStateSnapshot extends RadSchema.RadState {
    state: string;
}

export interface OssmEssentialSnapshot {
    state: string;
    powered: boolean;
    batteryPercent: number | null;
    charging: boolean | null;
    positionMm: number;
    sessionDistanceMeters: number;
    sessionStrokeCount: number;
}

export type OssmButtonSnapshot = Array<{
    id: string;
    pressed: boolean;
}>

export interface OssmEncoderSnapshot {
    id: "encoder";
    value: number;
}

export interface OssmAnalogSnapshot {
    speedKnob: number;
    speedKnobPercent: number;
    motorCurrent: number;
    motorCurrentFiltered: number;
    expansion1: number;
    expansion2: number;
    expansion3: number;
    expansion4: number;
}

export interface OssmMotionSnapshot {
    homed: boolean;
    positionMm: number;
    speed: number;
    stroke: number;
    depth: number;
    sensation: number;
    buffer: number;
    pattern: number;
    targetPosition: number;
    targetTimeMs: number;
    strokeCount: number;
    distanceMeters: number;
}

export interface OssmConnectivitySnapshot {
    wifi: string;
    rssi: number;
    ip: string;
    ble: boolean;
}

export interface OssmIndicatorSnapshot {
    id: "led";
    r: number;
    g: number;
    b: number;
}
// #endregion

export interface OssmReadResult<T> {
    path: string;
    value: T;
}

// https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/services/communication/rad_ble.cpp#L196
export interface OssmWifiStatus {
    connected: boolean;
    rssi?: number;
    ip?: string;
}

// https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/services/communication/rad_ble.cpp#L570
export interface OssmFirmwareProvenance {
    origin: string;
    keyId: string;
    provenanceId: string;
    imageSha256: string;
    compactJws: string;
}

export enum OssmGpioPinMode {
    Input = "input",
    InputPullup = "inputPullup",
    Output = "output"
}

export enum OssmButtonClickType {
    Single = "click",
    Double = "double",
    Long = "long"
}

export enum OssmMenu {
    MainMenu = "menu",
    SimplePenetration = "simplePenetration",
    StrokeEngine = "strokeEngine",
    Streaming = "streaming",
    Pairing = "pairing",
}

export type OssmSurface = Extract<RadSchema.RadSurface,
    RadSchema.RadSurface.Essential
    | RadSchema.RadSurface.Encoder
    | RadSchema.RadSurface.Connectivity
    | RadSchema.RadSurface.Analog
    | RadSchema.RadSurface.Button
    | RadSchema.RadSurface.Motion
>;
