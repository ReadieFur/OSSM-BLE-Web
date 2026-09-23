// https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/services/communication/BLE_Protocol.md#current-state-characteristic

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
    /** Streaming mode (experimental) */
    Streaming = "streaming",
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
    Restart = "restart"
};

export interface OssmStateCharacteristicResponse {
    /** Unknown */
    activeOperation: string;
    /** Unknown */
    lease: { 
        active: boolean;
    },
    /** Unknown */
    sequence: number;
    /** Current state */
    state: OssmStateString;
    /** Time since firmware boot in milliseconds */
    uptimeMs: number;
    /** Unknown */
    v: number;
}

export interface OssmPattern {
    idx: number;
    name: string;
    description: string;
}

export enum OssmMenu {
    MainMenu = "menu",
    SimplePenetration = "simplePenetration",
    StrokeEngine = "strokeEngine",
    Streaming = "streaming"
}
