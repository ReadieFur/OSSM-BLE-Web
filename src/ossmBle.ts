// Reference: https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/services/communication/BLE_Protocol.md

//#region Imports
import {
    AsyncFunctionQueue,
    delay,
    DOMExceptionError,
    upperSnakeToCamel,
    type ServicesDefinition,
    type UpperSnakeToCamel,
} from "./helpers";
import {
    OSSM_PAGE_NAVIGATION_GRAPH,
    OssmPage,
    OssmEventType,
    OssmStatus,
    type OssmEventCallback,
    type OssmState,
    type OssmPattern,
    type OssmPlayData,
    type OssmEventCallbackParameters,
} from "./ossmBleTypes";
import {
    KnownPattern
} from "./patterns";
//#endregion

//#region Constants
const OSSM_DEVICE_NAME = "OSSM";
const BASE_COMMAND_PROCESS_DELAY_MS = 50;
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
     * Checks if the current browser supports all the required Web APIs for this library
     * @returns `true` if supported, `false` otherwise
     */
    static isClientSupported(): boolean {
        return !(!navigator.bluetooth || !navigator.bluetooth.requestDevice);
    }

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
    private pendingStateTarget: Partial<OssmState> = {};
    private cachedPatternList: OssmPattern[] | null = null;
    private lastFixedPosition: number | null = null;
    commandProcessDelayMs: number = BASE_COMMAND_PROCESS_DELAY_MS;

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
    private async dispatchEvent(data: OssmEventCallbackParameters): Promise<void> {
        const callbacks = this.eventCallbacks.get(data.event);
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

        this.dispatchEvent({ event: OssmEventType.Connected });
    }

    private throwIfNotReady(): void {
        if (!this.isReady)
            throw new DOMException("ossmBle not ready", DOMExceptionError.InvalidState);
    }

    private async onDisconnected(): Promise<void> {
        this.isReady = false;
        this.debugLog("Disconnected");

        this.dispatchEvent({ event: OssmEventType.Disconnected });

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

    private isIntermediateValue(key: keyof OssmState, incoming: any, expected: any): boolean {
        // TODO: Expand this to allow checking on other data types.
        if (typeof incoming !== "number" || typeof expected !== "number")
            return false;
        return incoming === expected - 1;
    }

    private waitForPendingTargetsToSettle(timeout: number = Number.POSITIVE_INFINITY): Promise<void> {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            const checkInterval = setInterval(() => {
                if (Object.keys(this.pendingStateTarget).length === 0) {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 50);
            setTimeout(() => {
                clearInterval(checkInterval);
                reject(new Error("Timeout waiting for pending targets to settle"));
            }, timeout);
        });
    }

    private onCurrentStateChanged(event: Event): void {
        this.lastPoll = Date.now();

        const oldState = this.cachedState;

        // Get new state
        type JsonState = Omit<OssmState, "status"> & {
            state: OssmStatus;
        };
        const jsonStateObj = JSON.parse(TEXT_DECODER.decode((event.target as BluetoothRemoteGATTCharacteristic).value!)) as JsonState;
        const { state, ...rest } = jsonStateObj;
        const remappedStateObj: OssmState = { status: state, ...rest };
        
        // Check if anything has changed (since this event will fire every second even if nothing changes)
        const whatsChanged: Partial<OssmState> = {};
        for (const k in remappedStateObj) {
            const key = k as keyof OssmState;
            if (remappedStateObj[key] !== oldState?.[key]) {
                whatsChanged[key] = remappedStateObj[key] as any;
            }
        }
        if (Object.keys(whatsChanged).length === 0)
            return; // No changes

        // Check if we should ignore this update due to pending target states
        for (const k in this.pendingStateTarget) {
            const key = k as keyof OssmState;
            const pendingTarget = this.pendingStateTarget[key];
            const changedValue = whatsChanged[key];

            if (pendingTarget === undefined || changedValue === undefined)
                continue;

            if (changedValue === pendingTarget) {
                // Target reached, clear pending target
                delete this.pendingStateTarget[key];
                this.debugLog(`Pending target for ${key} reached: ${changedValue}`);
                continue;
            }

            if (this.isIntermediateValue(key, changedValue, pendingTarget)) {
                // Intermediate value detected, wait for next update
                this.debugLog(`Pending target for ${key} not yet reached (intermediate value): ${changedValue} (target: ${pendingTarget})`);
                return;
            }

            // Value changed externally, clear pending target
            this.debugLog(`Pending target for ${key} cleared due to external change: ${changedValue} (target was: ${pendingTarget})`);
            delete this.pendingStateTarget[key];
        }

        if (Object.keys(this.pendingStateTarget).length > 0) {
            this.debugLog("Pending targets remain, waiting for next update.");
            return;
        }

        /* Only emit the event if:
         * No pending targets are set
         * Or an external change was detected
         * Or all pending targets have been settled
         */

        // Update state and fire event callbacks
        this.cachedState = remappedStateObj;

        this.debugLogTable({
            "New state": remappedStateObj,
            // "Old state": this.cachedState
        });

        this.dispatchEvent({
            event: OssmEventType.StateChanged,
            [OssmEventType.StateChanged]: {
                newState: remappedStateObj,
                // oldState: oldState
            }
        });
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
        const doDisconnect = () => {
            if (this.device.gatt?.connected)
                this.device.gatt.disconnect();
        };
        if (this.isReady)
            this.stop().finally(doDisconnect);
        else
            doDisconnect();
    }

    /**
     * Send a raw command to the OSSM device
     * @param value The command string to send
     * @param speedup When `true`, the command is sent without waiting for and validating the response
     */
    async sendCommand(value: string, speedup: boolean = false): Promise<void> {
        this.throwIfNotReady();

        if (speedup) {
            await this.ossmServices!.primary.characteristics.command.writeValue(TEXT_ENCODER.encode(value));
            return;
        }

        const returnedValue = await this.bleTaskQueue.enqueue(async () => {
            await this.ossmServices!.primary.characteristics.command.writeValue(TEXT_ENCODER.encode(value));
            await delay(this.commandProcessDelayMs); // Give OSSM time to process the command.
            return TEXT_DECODER.decode((await this.ossmServices!.primary.characteristics.command.readValue()).buffer) as string;
        });

        if (returnedValue === `fail:${value}`) {
            throw new DOMException(`OSSM failed to process command: ${value}`, DOMExceptionError.OperationError);
        } else if (returnedValue !== `${value}`) {
            throw new DOMException(`OSSM returned unexpected response for command "${value}": ${returnedValue}`, DOMExceptionError.DataError);
        }
    }

    /**
     * Checks whether automatic reconnection will occur upon disconnection
     * @returns `true` if auto-reconnect is enabled, `false` otherwise
     */
    willAutoReconnect(): boolean {
        return this.autoReconnect;
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
     * Set stroke speed percentage
     * @param speed A {@link number} between 0 and 100
     * @throws RangeError if speed is out of range
     * @throws DOMException if the command fails
     */
    async setSpeed(speed: number): Promise<void> {
        if (speed < 0 || speed > 100 || !Number.isInteger(speed))
            throw new RangeError("Speed must be an integer between 0 and 100.");

        if (this.cachedState?.speed === speed)
            return;
        
        this.debugLog(`Setting speed to ${speed}`);

        this.pendingStateTarget.speed = speed;

        try {
            await this.sendCommand(`set:speed:${speed}`);
        } finally {
            // If the command fails, we still want to clear the pending target to avoid blocking further commands.
            delete this.pendingStateTarget.speed;
        }
    }

    /**
     * Set stroke length percentage
     * @param stroke A {@link number} between 0 and 100
     * @throws RangeError if stroke is out of range
     * @throws DOMException if the command fails
     */
    async setStroke(stroke: number): Promise<void> {
        if (stroke < 0 || stroke > 100 || !Number.isInteger(stroke))
            throw new RangeError("Stroke must be an integer between 0 and 100.");
        
        if (this.cachedState?.stroke === stroke)
            return;

        this.debugLog(`Setting stroke to ${stroke}`);

        // For some reason the device will +1 whatever value is set here so we subtract 1 to compensate.
        this.pendingStateTarget.stroke = stroke;

        const apiValue = stroke > 0 && stroke < 100 ? stroke - 1 : stroke;

        try {
            await this.sendCommand(`set:stroke:${apiValue}`);
        } finally {
            delete this.pendingStateTarget.stroke;
        }
    }

    /**
     * Set penetration depth percentage
     * @param depth A {@link number} between 0 and 100
     * @throws RangeError if depth is out of range
     * @throws DOMException if the command fails
     */
    async setDepth(depth: number): Promise<void> {
        if (depth < 0 || depth > 100 || !Number.isInteger(depth))
            throw new RangeError("Depth must be an integer between 0 and 100.");

        if (this.cachedState?.depth === depth)
            return;

        this.debugLog(`Setting depth to ${depth}`);

        // Same +1 quirk as stroke (see {@link setStroke})
        this.pendingStateTarget.depth = depth;

        const apiValue = depth > 0 && depth < 100 ? depth - 1 : depth;

        try {
            await this.sendCommand(`set:depth:${apiValue}`);
        } finally {
            delete this.pendingStateTarget.depth;
        }
    }

    /**
     * Set sensation intensity percentage
     * @param sensation A {@link number} between 0 and 100
     * @throws RangeError if sensation is out of range
     * @throws DOMException if the command fails
     */
    async setSensation(sensation: number): Promise<void> {
        if (sensation < 0 || sensation > 100 || !Number.isInteger(sensation))
            throw new RangeError("Sensation must be an integer between 0 and 100.");

        if (this.cachedState?.sensation === sensation)
            return;

        this.debugLog(`Setting sensation to ${sensation}`);

        // Same +1 quirk as stroke (see {@link setStroke})
        // Can't be 0 because the device always +1s it, documentation says it should be allowed to be 0 though, so not checking against at here
        this.pendingStateTarget.sensation = sensation;

        const apiValue = sensation > 0 && sensation < 100 ? sensation - 1 : sensation;

        try {
            await this.sendCommand(`set:sensation:${apiValue}`);
        } finally {
            delete this.pendingStateTarget.sensation;
        }
    }

    /**
     * Set stroke pattern (see {@link getPatternList} for available patterns)
     * @param patternId A {@link number} corresponding to a pattern ID (see {@link KnownPattern})
     * @throws RangeError if patternId is negative or not within the range of patterns (see {@link getPatternList()})
     */
    async setPattern(patternId: number): Promise<void> {
        if (patternId < 0 || !Number.isInteger(patternId))
            throw new RangeError("Pattern ID must be a non-negative integer.");

        if (this.cachedPatternList === null)
            await this.getPatternList();
        if (this.cachedPatternList && !this.cachedPatternList.find(p => p.idx === patternId))
            throw new RangeError(`Pattern ID ${patternId} is not in the available pattern list.`);

        if (this.cachedState?.pattern === patternId)
            return;

        this.debugLog(`Setting pattern to ID ${patternId}`);

        this.pendingStateTarget.pattern = patternId;

        try {
            await this.sendCommand(`set:pattern:${patternId}`);
        } finally {
            delete this.pendingStateTarget.pattern;
        }
    }

    /**
     * Navigate to a specific menu page
     * @param page One of the {@link OssmPage} enum values
     */
    async navigateTo(page: OssmPage): Promise<void> {
        let currentPage = this.getCurrentPage();

        // Already on desired page
        if (currentPage === page)
            return;

        // Direct navigation
        if (OSSM_PAGE_NAVIGATION_GRAPH[currentPage].includes(page)) {
            await this.sendCommand(`go:${page}`);
            return;
        }

        // Indirect navigation
        const visited = new Set<OssmPage>([currentPage]);
        const queue: OssmPage[][] = [[currentPage]];
        while (queue.length) {
            const path = queue.shift()!;
            const node = path[path.length - 1];

            for (const next of OSSM_PAGE_NAVIGATION_GRAPH[node]) {
                if (visited.has(next))
                    continue;

                const newPath = [...path, next];
                if (next === page) {
                    for (let i = 1; i < newPath.length; i++)
                        await this.sendCommand(`go:${newPath[i]}`);
                    return;
                }

                visited.add(next);
                queue.push(newPath);
            }
        }

        throw new DOMException(`Cannot navigate to page ${page} from current page ${currentPage}.`, DOMExceptionError.InvalidState);
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
        await delay(this.commandProcessDelayMs); // Give OSSM time to process the command.
        if (await this.getSpeedKnobConfig() !== knobAsLimit)
            throw new DOMException("Failed to set speed knob configuration.", DOMExceptionError.DataError);
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
                await delay(this.commandProcessDelayMs);
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
        this.debugLogTable(patterns);

        this.cachedPatternList = patterns;
        return patterns;
    }

    /**
     * Emergency stops the OSSM device  
     * @remarks This should not be used to stop normal operations, use {@link setSpeed(setSpeed(0))} instead
     */
    async stop(): Promise<void> {
        // Manually process here as this should be used to emergency stop the device, taking priority over any other tasks.
        if (!this.isReady)
            return;
        this.bleTaskQueue.clearQueue();
        await this.bleTaskQueue.enqueue(async () => {
            await this.ossmServices!.primary.characteristics.command.writeValue(TEXT_ENCODER.encode("set:speed:0"));
            // Possibly check return value?
        });
    }

    /**
     * Gets whether the OSSM device is ready
     * @returns `true` if ready, `false` if not ready
     */
    getIsReady(): boolean {
        return this.isReady;
    }

    /**
     * Waits until the OssmBle instance is ready for commands
     * @param timeout Maximum time to wait in milliseconds. Defaults to infinity.
     */
    async waitForReady(timeout: number = Number.POSITIVE_INFINITY): Promise<void> {
        const startTime = Date.now();
        while (!this.isReady) {
            if (Date.now() - startTime > timeout)
                throw new DOMException("Timeout waiting for ossmBle to be ready.", DOMExceptionError.Timeout);
            await delay(100);
        }
    }

    /**
     * Gets the OSSM state
     * @param timeout Maximum time to wait for a state update in milliseconds. Defaults to infinity.
     */
    async getState(timeout: number = Number.POSITIVE_INFINITY): Promise<OssmState> {
        const startTime = Date.now();
        while (!this.isReady || !this.cachedState) {
            if (Date.now() - startTime > timeout)
                throw new DOMException("Timeout waiting for OSSM state.", DOMExceptionError.Timeout);
            await delay(100);
        }
        return this.cachedState;
    }

    /**
     * Gets the last cached pattern list
     * @returns An array of {@link OssmPattern} objects or `null` if no pattern list has been cached yet
     */
    getCachedPatternList(): OssmPattern[] | null {
        return this.cachedPatternList;
    }

    /**
     * Gets the current OSSM page
     * @param state Optional {@link OssmState} object to use instead of the cached state
     * @returns One of the {@link OssmPage} enum values
     * @throws DOMException if no state is available or the state is invalid (e.g. busy doing homing task)
     */
    getCurrentPage(state: OssmState | null = null): OssmPage {
        if (!state)
            state = this.cachedState;
        if (!state)
            throw new DOMException("No state available to determine current page.", DOMExceptionError.InvalidState);
        const currentPage = state.status.indexOf('.') !== -1 ? state.status.split('.')[0] : state.status;
        // Sanity check
        if (!Object.values(OssmPage).includes(currentPage as OssmPage))
            throw new DOMException(`Unknown OSSM page: ${currentPage}`, DOMExceptionError.DataError);
        return currentPage as OssmPage;
    }

    /**
     * Waits until the OSSM device reaches the specified status
     * @param status The desired {@link OssmStatus}
     * @param timeout Maximum time to wait in milliseconds. Defaults to infinity.
     * @throws DOMException if timeout is reached before the status is achieved
     */
    async waitForStatus(status: OssmStatus | OssmStatus[], timeout: number = Number.POSITIVE_INFINITY): Promise<void> {
        const startTime = Date.now();
        while (true) {
            const currentState = await this.getState(timeout);
            if (currentState && (Array.isArray(status) ? status.includes(currentState.status) : currentState.status === status))
                return;
            if (Date.now() - startTime > timeout)
                throw new DOMException(`Timeout waiting for OSSM to reach status ${status}.`, DOMExceptionError.Timeout);
            await delay(100);
        }
    }

    /**
     * Apply & run a stroke engine pattern by setting speed, stroke, depth, sensation, and pattern in an order designed to reduce jerkiness
     * @param data An {@link OssmPlayData} object containing the desired settings
     * @requires being on the Stroke Engine page
     */
    async runStrokeEnginePattern(data: OssmPlayData): Promise<void> {
        const min = data.depth - data.stroke;

        // Get current states
        const capturedState = await this.getState();
        const currentPage = this.getCurrentPage(capturedState)!;
        const currentPattern = capturedState.pattern;
        const oldDepth = capturedState.depth;
        const oldStroke = capturedState.stroke;
        const oldMin = oldDepth - oldStroke;
        const oldMax = oldDepth;
        const oldSpeed = capturedState.speed;

        // We must be on the stoke engine page for this to work
        if (currentPage !== OssmPage.StrokeEngine) {
            throw new DOMException("Must be on Stroke Engine page to set simple stroke.", DOMExceptionError.InvalidState);
            // this.navigateTo(OssmPage.StrokeEngine);
            // await this.waitForStatus(OssmStatus.StrokeEngineIdle, 5000);
        }

        // We need to check and set the pending states ahead of time here since we are applying multiple commands in sequence which may throw off external event callbacks.
        if (capturedState.pattern !== data.pattern)
            this.pendingStateTarget.pattern = data.pattern;
        if (capturedState.speed !== data.speed)
            this.pendingStateTarget.speed = data.speed;
        if (capturedState.stroke !== data.stroke)
            this.pendingStateTarget.stroke = data.stroke;
        if (capturedState.depth !== data.depth)
            this.pendingStateTarget.depth = data.depth;
        if (capturedState.sensation !== data.sensation)
            this.pendingStateTarget.sensation = data.sensation;

        try {
            // Check if we are on the correct pattern
            if (currentPattern !== data.pattern)
                await this.setPattern(data.pattern);

            // Queue in a specific order to try and reduce jerkiness (we want to avoid sudden extension with increased speed)
            if (data.speed < oldSpeed) {
                // Always safe case (down in speed, range change doesn't matter)
                this.debugLog("runStrokeEnginePattern:", "Safe case: Decreasing speed");
                await this.setSpeed(data.speed);
                await this.setDepth(data.depth);
                await this.setStroke(data.stroke);
                await this.setSensation(data.sensation);
            } else if (data.speed > oldSpeed && (min < oldMin || data.depth > oldMax)) {
                /* Potentially risky case detected (fast + extended motion)
                * To mitigate risk, we first apply depth/stroke changes at old speed, then increase speed.
                */
                this.debugLog("runStrokeEnginePattern:", "Risky case: Increasing speed with extended range");
                await this.setDepth(data.depth);
                await this.setStroke(data.stroke);
                await this.setSpeed(data.speed);
                await this.setSensation(data.sensation);
            } else {
                // Neutral case.
                this.debugLog("runStrokeEnginePattern:", "Neutral case");
                await this.setDepth(data.depth);
                await this.setStroke(data.stroke);
                await this.setSpeed(data.speed);
                await this.setSensation(data.sensation);
            }
        } finally {
            // Clear pending targets
            delete this.pendingStateTarget.pattern;
            delete this.pendingStateTarget.speed;
            delete this.pendingStateTarget.stroke;
            delete this.pendingStateTarget.depth;
            delete this.pendingStateTarget.sensation;
        }
    }

    /**
     * Moves the rod to a specific position percentage
     * @param position A {@link number} between 0 and 100
     * @throws RangeError if position is out of range
     * @requires being on the Stroke Engine page
     */
    async moveToPosition(position: number, speed: number): Promise<void> {
        // Through testing I found a hacky way that I can set the rod to a specific position by using the Insist pattern.
        
        const currentState = await this.getState();
        if (this.getCurrentPage(currentState) !== OssmPage.StrokeEngine)
            throw new DOMException("Must be on Stroke Engine page to set simple stroke.", DOMExceptionError.InvalidState);

        // Apply settings in a specific order to reduce jerkiness
        if (currentState.pattern !== KnownPattern.Insist ||
            currentState.sensation !== 100 ||
            currentState.stroke !== 100
        ) {
            // Case: State is not currently configured for this mode, do slower but safer application of settings
            this.debugLog("setPosition:", "Not pre-configured (slowest)");

            try {
                this.pendingStateTarget.speed = 0;
                this.pendingStateTarget.pattern = KnownPattern.Insist;

                // Pause before switching and applying new pattern to try and reduce jerkiness
                await this.setSpeed(0);
                await this.setPattern(KnownPattern.Insist);
            } finally {
                delete this.pendingStateTarget.speed;
                delete this.pendingStateTarget.pattern;
            }

            try {
                this.pendingStateTarget.sensation = 100;
                this.pendingStateTarget.stroke = 100;
                this.pendingStateTarget.depth = position;
                this.pendingStateTarget.speed = speed;

                await this.setSensation(100);
                await this.setStroke(100);
                await this.setDepth(position);
                await this.setSpeed(speed);
            } finally {
                delete this.pendingStateTarget.sensation;
                delete this.pendingStateTarget.stroke;
                delete this.pendingStateTarget.depth;
                delete this.pendingStateTarget.speed;
            }
        } else if (this.lastFixedPosition === currentState.depth) {
            // Case: State is configured for this mode, the current position is still the same as the last, apply settings directly
            this.debugLog("setPosition:", "Pre-configured (faster)");

            try {
                this.pendingStateTarget.speed = speed;
                this.pendingStateTarget.depth = position;

                await this.setSpeed(speed);
                await this.setDepth(position);
            } finally {
                delete this.pendingStateTarget.speed;
                delete this.pendingStateTarget.depth;
            }
        } else {
            /* Case: Configured for this mode but the current position has changed from the last time this was called
             * In this case it is not safe to set speed first as it could jerk in the wrong direction.
             * (Always safe, but slower)
             */
            this.debugLog("setPosition:", "Pre-configured (slower)");

            try {
                this.pendingStateTarget.speed = 0;
                await this.setSpeed(0);
            } finally {
                delete this.pendingStateTarget.speed;
            }

            try {
                this.pendingStateTarget.depth = position;
                this.pendingStateTarget.speed = speed;

                await this.setDepth(position);
                await this.setSpeed(speed);
            } finally {
                delete this.pendingStateTarget.depth;
                delete this.pendingStateTarget.speed;
            }
        }

        this.lastFixedPosition = position;

        /* TODO: Find a way to detect what the current position of the device is,
         * wait until it reaches the desired position,
         * then set speed to 0 to hold it there.
         * (Safer than leaving it running in-case of value change or firmware bug)
         * Additionally with this pattern if a new depth is set while it is still moving it will wait until it reaches the previous target before moving to the new one,
         * by setting the speed to 0 first this can be avoided, but that depends on being able to detect the current position.
         */
    }

    /**
     * Batch set multiple OssmPlayData settings in one go.  
     * *Note:* It is advised you use runStrokeEnginePattern where possible instead of this method to apply settings in a safe order.
     * @param data An array of tuples containing the key and value to set
     * @throws Error if the same key is set multiple times in the batch
     */
    async batchSet(data: Array<[keyof OssmPlayData, number]>): Promise<void> {
        let speed: number | undefined;
        let stroke: number | undefined;
        let sensation: number | undefined;
        let depth: number | undefined;
        let pattern: number | undefined;

        for (const [key, value] of data) {
            switch (key) {
                case "speed":
                    if (speed !== undefined) throw new Error("Speed has already been set in this batch.");
                    speed = value;
                    break;
                case "stroke":
                    if (stroke !== undefined) throw new Error("Stroke has already been set in this batch.");
                    stroke = value;
                    break;
                case "sensation":
                    if (sensation !== undefined) throw new Error("Sensation has already been set in this batch.");
                    sensation = value;
                    break;
                case "depth":
                    if (depth !== undefined) throw new Error("Depth has already been set in this batch.");
                    depth = value;
                    break;
                case "pattern":
                    if (pattern !== undefined) throw new Error("Pattern has already been set in this batch.");
                    pattern = value;
                    break;
            }
        }

        const capturedState = await this.getState();

        if (speed !== undefined && capturedState.speed !== speed)
            this.pendingStateTarget.speed = speed;
        if (stroke !== undefined && capturedState.stroke !== stroke)
            this.pendingStateTarget.stroke = stroke;
        if (sensation !== undefined && capturedState.sensation !== sensation)
            this.pendingStateTarget.sensation = sensation;
        if (depth !== undefined && capturedState.depth !== depth)
            this.pendingStateTarget.depth = depth;
        if (pattern !== undefined && capturedState.pattern !== pattern)
            this.pendingStateTarget.pattern = pattern;

        try {
            // Apply in supplied order
            for (const [key, value] of data) {
                switch (key) {
                    case "speed":
                        await this.setSpeed(value);
                        break;
                    case "stroke":
                        await this.setStroke(value);
                        break;
                    case "sensation":
                        await this.setSensation(value);
                        break;
                    case "depth":
                        await this.setDepth(value);
                        break;
                    case "pattern":
                        await this.setPattern(value);
                        break;
                }
            }
        } finally {
            delete this.pendingStateTarget.speed;
            delete this.pendingStateTarget.stroke;
            delete this.pendingStateTarget.sensation;
            delete this.pendingStateTarget.depth;
            delete this.pendingStateTarget.pattern;
        }
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

//#region Additional exports (for bundled output)
// export { OssmBle };
export {
    OssmPage,
    OssmEventType,
    OssmStatus,
    type OssmEventCallback,
    type OssmEventCallbackParameters,
    type OssmState,
    type OssmPattern,
} from "./ossmBleTypes";
export {
    KnownPattern,
    PatternHelper
} from "./patterns";
export {
    mapRational
} from "./helpers";
//#endregion
