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

export type OssmEventCallbackParameters = {
    event: OssmEventType;
    // [OssmEventType.Connected]?: null;
    // [OssmEventType.Disconnected]?: null;
    [OssmEventType.StateChanged]?: {
        newState: OssmState;
        // oldState: OssmState | null;
    }
};

export type OssmEventCallback = (data: OssmEventCallbackParameters) => Promise<any> | any;

export enum OssmStatus {
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

export interface OssmPlayData {
    speed: number;
    stroke: number;
    sensation: number;
    depth: number;
    pattern: number;
}

export interface OssmState extends OssmPlayData {
    status: OssmStatus;
};

export enum OssmPage {
    /** Switch to simple penetration mode */
    SimplePenetration = "simplePenetration",
    /** Switch to stroke engine mode */
    StrokeEngine = "strokeEngine",
    /** Return to main menu */
    Menu = "menu",
};

// Certain pages can only navigate to specific other pages, so we create a graph which we can traverse.
export const OSSM_PAGE_NAVIGATION_GRAPH: Record<OssmPage, OssmPage[]> = {
    [OssmPage.Menu]: [OssmPage.SimplePenetration, OssmPage.StrokeEngine],
    [OssmPage.SimplePenetration]: [OssmPage.Menu],
    [OssmPage.StrokeEngine]: [OssmPage.Menu],
};

export interface OssmPattern {
    name: string;
    idx: number;
    description: string;
};
