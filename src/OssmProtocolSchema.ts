/**
 * Typings based on:
 * https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/services/communication/rad_ble.cpp
 */

import * as RadSchema from "./RadProtocolSchema";

// #region Surface
// https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/services/communication/rad_ble.cpp#L570

export interface OssmStateSnapshot extends RadSchema.RadState {
    state: OssmStateString;
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

type EnforceExhaustiveMap<K extends string | number | symbol, T extends Record<K, any>> = T;

export type OssmSurfacePayloadMap = EnforceExhaustiveMap<OssmSurface, {
    [RadSchema.RadSurface.Essential]: OssmEssentialSnapshot,
    [RadSchema.RadSurface.Encoder]: OssmEncoderSnapshot,
    [RadSchema.RadSurface.Connectivity]: OssmConnectivitySnapshot,
    [RadSchema.RadSurface.Analog]: OssmAnalogSnapshot,
    [RadSchema.RadSurface.Button]: OssmButtonSnapshot,
    [RadSchema.RadSurface.Motion]: OssmMotionSnapshot
}>;

export interface OssmBasicPatternInfo {
    idx: number;
    name: string;
}

export interface OssmPattern extends OssmBasicPatternInfo {
    description: string;
}

export enum OssmStateString {
    /** Initializing */
    Idle = "idle",
    /** Homing sequence active */
    Homing = "homing",
    /** Forward homing in progress */
    HomingForward = "homing.forward",
    /** Backward homing in progress */
    HomingBackward = "homing.backward",
    /** Main menu displayed */
    Menu = "menu",
    /** Menu idle state */
    MenuIdle = "menu.idle",
    /** Simple penetration mode */
    SimplePenetration = "simplePenetration",
    /** Simple penetration idle */
    SimplePenetrationIdle = "simplePenetration.idle",
    /** Pre-flight checks */
    SimplePenetrationPreflight = "simplePenetration.preflight",
    /** Stroke engine mode */
    StrokeEngine = "strokeEngine",
    /** Stroke engine idle */
    StrokeEngineIdle = "strokeEngine.idle",
    /** Pre-flight checks */
    StrokeEnginePreflight = "strokeEngine.preflight",
    /** Pattern selection */
    StrokeEnginePattern = "strokeEngine.pattern",
    /** Update mode */
    Update = "update",
    /** Checking for updates */
    UpdateChecking = "update.checking",
    /** Update in progress */
    UpdateUpdating = "update.updating",
    /** Update idle */
    UpdateIdle = "update.idle",
    /** WiFi setup mode */
    Wifi = "wifi",
    /** WiFi setup idle */
    WifiIdle = "wifi.idle",
    /** Help screen */
    Help = "help",
    /** Help idle */
    HelpIdle = "help.idle",
    /** Error state */
    Error = "error",
    /** Error idle */
    ErrorIdle = "error.idle",
    /** Error help */
    ErrorHelp = "error.help",
    /** Restart state */
    Restart = "restart",
};
