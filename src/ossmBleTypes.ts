// https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/services/communication/BLE_Protocol.md#current-state-characteristic

export enum OssmEventType {
    /** Emitted when the device is successfully connected */
    Connected,
    /** Emitted when the device is disconnected */
    Disconnected,
    /**
     * Emitted when the device state changes  
     * 
     * Notification Behavior:
     * - State changes trigger immediate notifications
     * - Periodic notifications every 1000ms if no state change
     * - Notifications stop when no clients connected
     */
    StateChanged
};

export type OssmEventCallback = (data: null | OssmState) => Promise<any> | any;

export enum OssmStateName {
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
    simplePenetration = "simple.penetration",
    /** Simple penetration idle */
    simplePenetrationIdle = "simple.penetration.idle",
    /** Pre-flight checks */
    simplePenetrationPreflight = "simple.penetration.preflight",
    /** Stroke engine mode */
    strokeEngine = "strokeEngine",
    /** Stroke engine idle */
    strokeEngineIdle = "strokeEngine.idle",
    /** Pre-flight checks */
    strokeEnginePreflight = "strokeEngine.preflight",
    /** Pattern selection */
    strokeEnginePattern = "strokeEngine.pattern",
    /** Update mode */
    update = "update",
    /** Checking for updates */
    updateChecking = "update.checking",
    /** Update in progress */
    updateUpdating = "update.updating",
    /** Update idle */
    updateIdle = "update.idle",
    /** WiFi setup mode */
    wifi = "wifi",
    /** WiFi setup idle */
    wifiIdle = "wifi.idle",
    /** Help screen */
    help = "help",
    /** Help idle */
    helpIdle = "help.idle",
    /** Error state */
    error = "error",
    /** Error idle */
    errorIdle = "error.idle",
    /** Error help */
    errorHelp = "error.help",
    /** Restart state */
    restart = "restart",
}

export interface OssmState {
    state: OssmStateName;
    speed: number;
    stroke: number;
    sensation: number;
    depth: number;
    pattern: number;
};

export enum KnownPatterns {
    SimpleStroke = 0,
    TeasingPounding = 1,
    RoboStroke = 2,
    HalfNHalf = 3,
    Deeper = 4,
    StopNGo = 5,
    Insist = 6,
};

export enum OssmMenu {
    /** Switch to simple penetration mode from the menu */
    SimplePenetration = "simplePenetration",
    /** Switch to stroke engine mode from the menu */
    StrokeEngine = "strokeEngine",
    /** Return to main menu from either stroke engine or simple penetration */
    Menu = "menu",
};

export interface OssmPattern {
    name: string;
    idx: number;
    description: string;
};
