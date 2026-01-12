// Reference: https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/services/communication/BLE_Protocol.md

import type { ServicesDefinition, UpperSnakeToCamel } from "./helpers";
import { AsyncFunctionQueue, delay, DOMExceptionError, upperSnakeToCamel } from "./helpers";
import { OssmMenu, OssmEventType, type OssmEventCallback, type OssmState, type OssmPattern } from "./ossmBleTypes";
export { OssmMenu, OssmEventType, type OssmEventCallback, type OssmState, type OssmPattern } from "./ossmBleTypes"; // Include specific types in bundled export.

//#region Constants
const OSSM_DEVICE_NAME = "OSSM";
const COMMAND_PROCESS_DELAY_MS = 50;
const DISCONNECT_TIMEOUT_MS = 5000; // Time after which to consider the device disconnected for safety reasons.
const OSSM_GATT_SERVICES = {
    PRIMARY: {
        uuid: '522b443a-4f53-534d-0001-420badbabe69',
        characteristics: {
            COMMAND: '522b443a-4f53-534d-1000-420badbabe69',
            SPEED_KNOB_CONFIGURATION: '522b443a-4f53-534d-1010-420badbabe69',
            CURRENT_STATE: '522b443a-4f53-534d-2000-420badbabe69',
            PATTERN_LIST: '522b443a-4f53-534d-3000-420badbabe69',
            PATTERN_DESCRIPTION: '522b443a-4f53-534d-3010-420badbabe69',
        }
    }
} as const satisfies ServicesDefinition;
//#endregion

//#region Misc setup
const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

// Auto-generate a clean structure to store the GATT services based on the above definition (voodoo magic shit).
type OSSMServices = {
    // https://stackoverflow.com/questions/42999983/typescript-removing-readonly-modifier
    -readonly [svc in keyof typeof OSSM_GATT_SERVICES as UpperSnakeToCamel<string & svc>]: {
        service: BluetoothRemoteGATTService;
        characteristics: {
            -readonly [char in keyof typeof OSSM_GATT_SERVICES[svc]["characteristics"] as UpperSnakeToCamel<string & char>]: BluetoothRemoteGATTCharacteristic;
        }
    }
};
//#endregion

export class OssmBle implements Disposable {
    //#region Static
    /**
     * Prompts the user via the browser to pair with an OSSM BLE device
     * @requires that the page is served over HTTPS or from localhost & is called by a user gesture
     * @returns BluetoothDevice on successful pairing
     * @throws DOMException if pairing is cancelled or fails
     */
    static async pairDevice(): Promise<OssmBle> {
        const bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: OSSM_DEVICE_NAME }],
            optionalServices: [OSSM_GATT_SERVICES.PRIMARY.uuid]
        });

        const ossmBle = new OssmBle(bleDevice);
        return ossmBle;
    }
    //#endregion

    //#region Instance variables & (de)constructor
    private readonly device: BluetoothDevice;
    private readonly bleTaskQueue = new AsyncFunctionQueue();
    private readonly eventCallbacks: Map<OssmEventType, OssmEventCallback[]> = new Map();
    private autoReconnect: boolean = true;
    private isReady: boolean = false;
    private ossmServices: OSSMServices | null = null;
    private lastPoll: number = 0;
    private cachedState: OssmState | null = null;
    private cachedPatternList: OssmPattern[] | null = null;

    private constructor(device: BluetoothDevice) {
        this.device = device;
        if (!device.gatt)
            throw new DOMException("Device is not connectable via GATT.", "NotSupportedError");

        this.device.addEventListener("gattserverdisconnected", this.onDisconnected.bind(this));
    }

    [Symbol.dispose](): void {
        this.end();
    }
    //#endregion

    //#region Instance methods (private)
    private async dispatchEvent(eventType: OssmEventType, data: null | OssmState): Promise<void> {
        const callbacks = this.eventCallbacks.get(eventType);
        if (callbacks)
            for (const callback of callbacks)
                callback(data); //Don't await; let them run async.
    }

    private async connect(): Promise<void> {
        if (this.device.gatt?.connected)
            return;

        this.bleTaskQueue.clearQueue();
        await this.bleTaskQueue.enqueue(async () => {
            const gattSnapshot = await this.device.gatt!.connect();

            await delay(100); // Short delay to try and help mitigate the error noted below.

            /* An error can occur here where the device randomly and suddenly disconnects during service/characteristic discovery.
             * I'm not sure what causes this, but my auto-reconnect logic should be able to handle it.
             * Apparently this is a known issue with web bluetooth.
             * Having implemented the BLE queue, this seems to have been mitigated, I suspected it was some kind of race condition on the network stack.
             */
            this.ossmServices = {} as OSSMServices;
            for (const svcKey in OSSM_GATT_SERVICES) {
                const svc = OSSM_GATT_SERVICES[svcKey as keyof typeof OSSM_GATT_SERVICES];
                const service = await gattSnapshot.getPrimaryService(svc.uuid);
                const characteristics: Record<string, BluetoothRemoteGATTCharacteristic> = {};
                for (const charKey in svc.characteristics) {
                    const charUuid = svc.characteristics[charKey as keyof typeof svc.characteristics];
                    characteristics[upperSnakeToCamel(charKey)] = await service.getCharacteristic(charUuid);
                }
                //Given I know what the data layout is here, this will work but is not the right solution.
                this.ossmServices[upperSnakeToCamel(svcKey) as keyof OSSMServices] = { service, characteristics } as any;
            }

            this.ossmServices.primary.characteristics.currentState.addEventListener("characteristicvaluechanged", this.onCurrentStateChanged.bind(this));
            await this.ossmServices.primary.characteristics.currentState.startNotifications();
        });

        this.debugLog("Connected");
        this.isReady = true;

        this.dispatchEvent(OssmEventType.Connected, null);
    }

    private throwIfNotReady(): void {
        if (!this.isReady)
            throw new DOMException("ossmBle not ready", DOMExceptionError.InvalidState);
    }

    private async onDisconnected(): Promise<void> {
        this.isReady = false;
        this.debugLog("Disconnected");

        this.dispatchEvent(OssmEventType.Disconnected, null);

        this.debugLogIf(this.autoReconnect, "Reconnecting...");
        let i = 0;
        while (this.autoReconnect)
        {
            try {
                const lastPollCaptured = this.lastPoll; // Capture required since the notification event may update before connect completes.

                await this.connect();

                // Because we disconnected we should immediately set to paused state for safety reasons (if disconnect was too long).
                if (lastPollCaptured + DISCONNECT_TIMEOUT_MS < Date.now()) {
                    this.debugLog("Disconnected for too long; stopping OSSM for safety.");
                    try { await this.stop(); }
                    catch {}
                }                    

                break;
            } catch (error) {
                this.debugLog(`Reconnection attempt ${i} failed:`, error);
                await new Promise(resolve => setTimeout(resolve, 250)); // Attempt to reconnect as fast as possible for safety reasons, but with some backoff.
                i++;
            }
        }
    }

    private onCurrentStateChanged(event: Event): void {
        this.lastPoll = Date.now();

        const state = JSON.parse(TEXT_DECODER.decode((event.target as BluetoothRemoteGATTCharacteristic).value!)) as OssmState;
        
        if (this.cachedState && JSON.stringify(this.cachedState) === JSON.stringify(state)) {
            // No change in state, ignore.
            return;
        }

        this.debugLogTable({ "On state changed": "", ...state });
        this.cachedState = state;

        this.dispatchEvent(OssmEventType.StateChanged, state);
    }

    private async sendCommand(value: string): Promise<void> {
        this.throwIfNotReady();

        const returnedValue = await this.bleTaskQueue.enqueue(async () => {
            await this.ossmServices!.primary.characteristics.command.writeValue(TEXT_ENCODER.encode(value));
            await delay(COMMAND_PROCESS_DELAY_MS); // Give OSSM time to process the command.
            return TEXT_DECODER.decode((await this.ossmServices!.primary.characteristics.command.readValue()).buffer) as string;
        });

        if (returnedValue === `fail:${value}`) {
            throw new DOMException(`OSSM failed to process command: ${value}`, DOMExceptionError.OperationError);
        } else if (returnedValue !== `${value}`) {
            throw new DOMException(`OSSM returned unexpected response for command "${value}": ${returnedValue}`, DOMExceptionError.DataError);
        }
    }
    //#endregion

    //#region Instance methods (public)
    /**
     * Begins automatic connection management.
     * A call to {@link waitForReady()} is recommended after this to ensure the library is ready before sending commands
     */
    begin(): void {
        this.autoReconnect = true;
        try { this.connect(); }
        catch (error) {} // Ignore errors here; onDisconnected will handle reconnection attempts.
    }

    /**
     * Ends automatic connection management and disconnects from the device
     */
    end(): void {
        this.autoReconnect = false;
        this.bleTaskQueue.clearQueue();
        if (this.device.gatt?.connected)
            this.device.gatt.disconnect();
    }

    /**
     * Waits until the OssmBle instance is ready for commands
     * @param timeout Maximum time to wait in milliseconds. Defaults to infinity.
     */
    async waitForReady(timeout: number = Number.POSITIVE_INFINITY): Promise<void> {
        const startTime = Date.now();
        while (!this.isReady) {
            if (Date.now() - startTime > timeout)
                throw new Error("Timeout waiting for ossmBle to be ready.");
            await delay(100);
        }
    }

    /**
     * Adds an event listener for the specified event type
     * @param eventType one of {@link OssmEventType}
     * @param callback Function to call when the event occurs (see {@link OssmEventCallback})
     */
    addEventListener(eventType: OssmEventType, callback: OssmEventCallback): void {
        if (!this.eventCallbacks.has(eventType))
            this.eventCallbacks.set(eventType, []);
        this.eventCallbacks.get(eventType)!.push(callback);
    }

    /**
     * Removes an event listener for the specified event type
     * @param eventType one of {@link OssmEventType}
     * @param callback Function to remove
     */
    removeEventListener(eventType: OssmEventType, callback: OssmEventCallback): void {
        if (!this.eventCallbacks.has(eventType))
            return;
        const callbacks = this.eventCallbacks.get(eventType)!;
        const index = callbacks.indexOf(callback);
        if (index !== -1)
            callbacks.splice(index, 1);
    }

    /**
     * Stops the OSSM device (sets speed to 0)
     */
    async stop(): Promise<void> {
        await this.setSpeed(0);
    }

    //#region Raw commands
    /**
     * Set stroke speed percentage
     * @param speed A {@link number} between 0 and 100
     * @throws RangeError if speed is out of range
     * @throws DOMException if the command fails
     */
    async setSpeed(speed: number): Promise<void> {
        if (speed < 0 || speed > 100)
            throw new RangeError("Speed must be between 0 and 100.");
        await this.sendCommand(`set:speed:${speed}`);
    }

    /**
     * Set stroke length percentage
     * @param stroke A {@link number} between 0 and 100
     * @throws RangeError if stroke is out of range
     * @throws DOMException if the command fails
     */
    async setStroke(stroke: number): Promise<void> {
        if (stroke < 0 || stroke > 100)
            throw new RangeError("Stroke must be between 0 and 100.");

        // For some reason the device will +1 whatever value is set here so we subtract 1 to compensate.
        if (stroke > 0 && stroke < 100)
            stroke -= 1;

        await this.sendCommand(`set:stroke:${stroke}`);
    }

    /**
     * Set penetration depth percentage
     * @param depth A {@link number} between 0 and 100
     * @throws RangeError if depth is out of range
     * @throws DOMException if the command fails
     */
    async setDepth(depth: number): Promise<void> {
        if (depth < 0 || depth > 100)
            throw new RangeError("Depth must be between 0 and 100.");

        // Same +1 quirk as stroke (see {@link setStroke})
        if (depth > 0 && depth < 100)
            depth -= 1;

        await this.sendCommand(`set:depth:${depth}`);
    }

    /**
     * Set sensation intensity percentage
     * @param sensation A {@link number} between 0 and 100
     * @throws RangeError if sensation is out of range
     * @throws DOMException if the command fails
     */
    async setSensation(sensation: number): Promise<void> {
        if (sensation < 0 || sensation > 100)
            throw new RangeError("Sensation must be between 0 and 100.");

        // Same +1 quirk as stroke (see {@link setStroke})
        if (sensation > 0 && sensation < 100)
            sensation -= 1;

        await this.sendCommand(`set:sensation:${sensation}`);
    }

    /**
     * Set stroke pattern (see {@link getPatternList} for available patterns)
     * @param patternId A {@link number} corresponding to a pattern ID (see {@link KnownPatterns})
     */
    async setPattern(patternId: number): Promise<void> {
        if (patternId < 0)
            throw new RangeError("Pattern ID must be a non-negative integer.");
        await this.sendCommand(`set:pattern:${patternId}`);
    }

    /**
     * Navigate to a specific menu page
     * @param page One of the {@link OssmMenu} enum values
     */
    async navigateTo(page: OssmMenu): Promise<void> {
        this.throwIfNotReady();

        // TODO: Fix this auto-navigation logic.
        /** Valid navigations:
         * Menu -> SimplePenetration
         * Menu -> StrokeEngine
         * SimplePenetration -> Menu
         * StrokeEngine -> Menu
         */
        // // Split state name at '.' to get base state
        // const activePage: string = this.cachedState!.state.indexOf('.') !== -1 ? this.cachedState!.state.split('.')[0] : this.cachedState!.state;
        // if (activePage == page)
        //     return; // Already on desired page
        // else if ((activePage == OssmMenu.SimplePenetration || activePage == OssmMenu.StrokeEngine) &&
        //     page == (OssmMenu.SimplePenetration || OssmMenu.StrokeEngine))
        //     await this.sendCommand(`go:${OssmMenu.Menu}`); // Navigate back to menu first (required)

        await this.sendCommand(`go:${page}`);
    }

    /**
     * Configure whether speed knob acts as upper limit for BLE speed commands
     * @param knobAsLimit
     * **When** `true`: BLE speed commands (0-100) are treated as a percentage of the current physical knob value  
     * Example: Knob at 50%, BLE command `set:speed:80` → Effective speed = 40%  
     * **When** `false`: BLE speed commands (0-100) are used directly as the speed value  
     * Example: BLE command `set:speed:80` → Effective speed = 80%
     */
    async setSpeedKnobConfig(knobAsLimit: boolean): Promise<void> {
        this.throwIfNotReady();
        await this.ossmServices!.primary.characteristics.speedKnobConfiguration.writeValue(TEXT_ENCODER.encode(knobAsLimit ? "true" : "false"));
        await delay(COMMAND_PROCESS_DELAY_MS); // Give OSSM time to process the command.
        if (await this.getSpeedKnobConfig() !== knobAsLimit)
            throw new Error("Failed to set speed knob configuration.");
    }

    /**
     * Gets whether speed knob acts as upper limit for BLE speed commands
     * @returns `true` if speed knob is configured as upper limit, `false` otherwise
     */
    async getSpeedKnobConfig(): Promise<boolean> {
        this.throwIfNotReady();
        const value = TEXT_DECODER.decode((await this.ossmServices!.primary.characteristics.speedKnobConfiguration.readValue()).buffer);
        return value === "true";
    }

    /**
     * Gets the list of available stroke patterns from the OSSM device
     * @returns An array of {@link OssmPattern} objects
     */
    async getPatternList(): Promise<OssmPattern[]> {
        this.throwIfNotReady();

        // Query pattern list
        interface RawPattern {
            name: string;
            idx: number;
        }
        const patternList = await this.bleTaskQueue.enqueue(async () =>
            JSON.parse(TEXT_DECODER.decode((await this.ossmServices!.primary.characteristics.patternList.readValue()).buffer)) as RawPattern[]);

        // Get each pattern's description
        let patterns: OssmPattern[] = [];
        for (const rawPattern of patternList) {
            const description = await this.bleTaskQueue.enqueue(async () => {
                await this.ossmServices!.primary.characteristics.patternDescription.writeValue(TEXT_ENCODER.encode(`${rawPattern.idx}`));
                await delay(COMMAND_PROCESS_DELAY_MS);
                return TEXT_DECODER.decode((await this.ossmServices!.primary.characteristics.patternDescription.readValue()).buffer);
            });
            if (!description)
                throw new DOMException(`Failed to get description for pattern ID ${rawPattern.idx}`, DOMExceptionError.DataError);
            
            patterns.push({
                name: rawPattern.name,
                idx: rawPattern.idx,
                description: description
            });
        }

        // type PatternMap = { [idx: number]: Omit<OssmPattern, "idx">; };
        this.debugLog("Fetched pattern list:");
        this.debugLogTable(patternList);

        return patterns;
    }
    //#endregion

    //#region Internal memory getters
    /**
     * Gets the last cached OSSM state
     * @returns An {@link OssmState} object or `null` if no state has been cached yet
     */
    getCachedState(): OssmState | null {
        return this.cachedState;
    }

    /**
     * Gets the last cached pattern list
     * @returns An array of {@link OssmPattern} objects or `null` if no pattern list has been cached yet
     */
    getCachedPatternList(): OssmPattern[] | null {
        return this.cachedPatternList;
    }

    getCurrentMenu(state: OssmState | null = null): OssmMenu | null {
        if (!state)
            state = this.cachedState;
        if (!state)
            return null;
        const currentMenu = state.state.indexOf('.') !== -1 ? state.state.split('.')[0] : state.state;
        return currentMenu as OssmMenu;
    }
    //#endregion
    //#endregion

    //#region Wrappers
    async strokeEngineSetSimpleStroke(
        speed: number,
        minDepthRelative: number,
        maxDepthRelative: number,
        minDepthAbsolute: number,
        maxDepthAbsolute: number
    ): Promise<void> {
        // Validate settings
        if (speed < 0 || speed > 100)
            throw new RangeError("Speed must be between 0 and 100.");
        if (minDepthRelative < 0 || minDepthRelative > 100)
            throw new RangeError("minDepthRelative must be between 0 and 100.");
        if (maxDepthRelative < 0 || maxDepthRelative > 100)
            throw new RangeError("maxDepthRelative must be between 0 and 100.");
        if (minDepthRelative >= maxDepthRelative)
            throw new RangeError("minDepthRelative must be less than maxDepthRelative.");
        if (minDepthAbsolute < 0 || minDepthAbsolute > 100)
            throw new RangeError("minDepthAbsolute must be between 0 and 100.");
        if (maxDepthAbsolute < 0 || maxDepthAbsolute > 100)
            throw new RangeError("maxDepthAbsolute must be between 0 and 100.");
        if (minDepthAbsolute >= maxDepthAbsolute)
            throw new RangeError("minDepthAbsolute must be less than maxDepthAbsolute.");

        // Calculate command values
        /* StrokeEngine.SimpleStroke command format:
         *
         * - Depth:
         *   Sets the maximum extension limit of the actuator.
         *   The device will extend up to this value (0–100) and will not exceed it.
         *
         * - Stroke:
         *   Sets how far the actuator retracts back from the depth limit.
         *   The actuator will move between:
         *     max = depth
         *     min = depth - stroke
         *
         * Notes:
         * - Motion always occurs backwards from depth (unless dip-switch 6 is set to invert motion).
         * - Stroke is a retraction distance, not a centered range.
         */
        const range = maxDepthAbsolute - minDepthAbsolute;
        const minPos = minDepthAbsolute + (minDepthRelative / 100) * range;
        const maxPos = minDepthAbsolute + (maxDepthRelative / 100) * range;
        const newDepth = maxPos;
        const newStroke = maxPos - minPos;
        const newMin = minPos;
        const newMax = newDepth;
        const newSpeed = speed;
        
        // Get current states
        const capturedState = this.getCachedState()!; //Should never be null here.
        const currentMenu = this.getCurrentMenu(capturedState)!;
        const oldDepth = capturedState.depth;
        const oldStroke = capturedState.stroke;
        const oldMin = oldDepth - oldStroke;
        const oldMax = oldDepth;
        const oldSpeed = capturedState.speed;

        this.debugLogTable({
            "Stroke engine: Set simple stroke": "",
            "Speed": `${oldSpeed} -> ${newSpeed}`,
            "Depth": `${oldDepth} -> ${newDepth}`,
            "Stroke": `${oldStroke} -> ${newStroke}`,
            "Min Pos": `${oldMin} -> ${newMin}`,
            "Max Pos": `${oldMax} -> ${newMax}`,
        });

        // Require that we are already on the StrokeEngine menu
        if (currentMenu !== OssmMenu.StrokeEngine)
            throw new DOMException(`Cannot set SimpleStroke settings when not on StrokeEngine menu (currently on ${currentMenu}).`, DOMExceptionError.InvalidState);

        // Check if any changes are needed
        if (oldSpeed === newSpeed && oldDepth === newDepth && oldStroke === newStroke) {
            this.debugLog("strokeEngineSetSimpleStroke:", "No changes needed.");
            return;
        }

        // Build setters
        const applySpeed = async () => {
            if (oldSpeed !== newSpeed)
                return this.setSpeed(newSpeed);
        };
        const applyDepth = async () => {
            if (oldDepth !== newDepth)
                return this.setDepth(newDepth);
        };
        const applyStroke = async () => {
            if (oldStroke !== newStroke)
                return this.setStroke(newStroke);
        };

        // Queue commands
        await this.bleTaskQueue.enqueue(async () => {
            // Queue in a specific order to try and reduce jerkiness (we want to avoid sudden extension with increased speed)
            if (newSpeed < oldSpeed) {
                // Always safe case (down in speed, range change doesn't matter)
                this.debugLog("strokeEngineSetSimpleStroke:", "Safe case: Decreasing speed");
                applySpeed();
                applyDepth();
                applyStroke();
            } else if (newSpeed > oldSpeed && (newMin < oldMin || newMax > oldMax)) {
                /* Potentially risky case detected (fast + extended motion)
                 * To mitigate risk, we first apply depth/stroke changes at old speed, then increase speed.
                 */
                this.debugLog("strokeEngineSetSimpleStroke:", "Risky case: Increasing speed with extended range");
                applyDepth();
                applyStroke();
                applySpeed();
            } else {
                // Neutral case.
                this.debugLog("strokeEngineSetSimpleStroke:", "Neutral case");
                applyDepth();
                applyStroke();
                applySpeed();
            }
        });
    }
    //#endregion

    //#region Debugging tools
    debug: boolean = false;

    private debugLog(...args: any[]): void {
        if (this.debug)
            console.log(`[OssmBle ${this.device.id}]`, ...args);
    }

    private debugLogIf(condition: boolean, ...args: any[]): void {
        if (condition)
            this.debugLog(...args);
    }

    private debugLogTable(table: any): void {
        if (this.debug)
            console.table(table);
    }

    private debugLogTableIf(condition: boolean, table: any): void {
        if (condition)
            this.debugLogTable(table);
    }
    //#endregion
}
