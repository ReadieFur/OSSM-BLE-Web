// Reference: https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/services/communication/BLE_Protocol.md

//#region Imports
import type { ServicesDefinition, UpperSnakeToCamel } from "./helpers";
import { AsyncFunctionQueue, delay, DOMExceptionError, upperSnakeToCamel } from "./helpers";
import {
    OSSM_PAGE_NAVIGATION_GRAPH,
    OssmPage,
    OssmEventType,
    OssmStatus,
    type OssmEventCallback,
    type OssmState,
    type OssmPattern,
    KnownPattern,
} from "./ossmBleTypes";
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

        type JsonState = Omit<OssmState, "status"> & {
            state: OssmStatus;
        };
        const jsonStateObj = JSON.parse(TEXT_DECODER.decode((event.target as BluetoothRemoteGATTCharacteristic).value!)) as JsonState;
        const { state, ...rest } = jsonStateObj;
        const remappedStateObj: OssmState = { status: state, ...rest };
        
        if (this.cachedState && JSON.stringify(this.cachedState) === JSON.stringify(remappedStateObj)) {
            // No change in state, ignore.
            return;
        }

        this.debugLogTable({
            "New state": remappedStateObj,
            "Old state": this.cachedState
        });
        this.cachedState = remappedStateObj;

        this.dispatchEvent(OssmEventType.StateChanged, remappedStateObj);
    }

    private async sendCommand(value: string): Promise<void> {
        this.throwIfNotReady();

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

    private async sendPatternParameters(
        speed: number,
        stroke: number,
        depth: number,
        sensation: number,
        pattern: KnownPattern
    ): Promise<void> {
        const min = depth - stroke;

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

        // Check if we are on the correct pattern
        if (currentPattern !== pattern)
            await this.setPattern(pattern);

        // Queue in a specific order to try and reduce jerkiness (we want to avoid sudden extension with increased speed)
        if (speed < oldSpeed) {
            // Always safe case (down in speed, range change doesn't matter)
            this.debugLog("strokeEngineSetSimpleStroke:", "Safe case: Decreasing speed");
            await this.setSpeed(speed);
            await this.setDepth(depth);
            await this.setStroke(stroke);
            await this.setSensation(sensation);
        } else if (speed > oldSpeed && (min < oldMin || depth > oldMax)) {
            /* Potentially risky case detected (fast + extended motion)
             * To mitigate risk, we first apply depth/stroke changes at old speed, then increase speed.
             */
            this.debugLog("strokeEngineSetSimpleStroke:", "Risky case: Increasing speed with extended range");
            await this.setDepth(depth);
            await this.setStroke(stroke);
            await this.setSpeed(speed);
            await this.setSensation(sensation);
        } else {
            // Neutral case.
            this.debugLog("strokeEngineSetSimpleStroke:", "Neutral case");
            await this.setDepth(depth);
            await this.setStroke(stroke);
            await this.setSpeed(speed);
            await this.setSensation(sensation);
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

        if (this.cachedState?.speed === speed)
            return;

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

        if (this.cachedState?.stroke === stroke)
            return;

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

        if (this.cachedState?.depth === depth)
            return;

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

        if (this.cachedState?.sensation === sensation)
            return;

        // Same +1 quirk as stroke (see {@link setStroke})
        // Can't be 0 because the device always +1s it, documentation says it should be allowed to be 0 though, so not checking against at here
        if (sensation > 0 && sensation < 100)
            sensation -= 1;

        await this.sendCommand(`set:sensation:${sensation}`);
    }

    /**
     * Set stroke pattern (see {@link getPatternList} for available patterns)
     * @param patternId A {@link number} corresponding to a pattern ID (see {@link KnownPattern})
     */
    async setPattern(patternId: KnownPattern): Promise<void> {
        if (patternId < 0)
            throw new RangeError("Pattern ID must be a non-negative integer.");
        await this.sendCommand(`set:pattern:${patternId}`);
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
    //#endregion

    //#region State caching & helpers
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
    //#endregion
    //#endregion

    //#region Play wrappers
    /**
     * Acceleration, coasting, deceleration equally split
     * @param minDepth the minimum depth percentage (0-100)
     * @param maxDepth the maximum depth percentage (0-100)
     * @param speed the speed percentage (0-100)
     * @example
     * ```ts
     * // Set a simple stroke from 20% to 80% depth at 70% speed
     * await ossmBle.strokeEngineSetSimpleStroke(70, 20, 80);
     * ```
     */
    async patternSimpleStroke(
        minDepth: number,
        maxDepth: number,
        speed: number
    ): Promise<void> {
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

        // Validate settings
        if (minDepth < 0 || minDepth > 100)
            throw new RangeError("minDepthAbsolute must be between 0 and 100.");
        if (maxDepth < 0 || maxDepth > 100)
            throw new RangeError("maxDepthAbsolute must be between 0 and 100.");
        if (minDepth >= maxDepth)
            throw new RangeError("minDepthAbsolute must be less than maxDepthAbsolute.");
        if (speed < 0 || speed > 100)
            throw new RangeError("Speed must be between 0 and 100.");

        // Calculate command values
        const newDepth = maxDepth;
        const newStroke = maxDepth - minDepth;
        const newSpeed = speed;

        await this.sendPatternParameters(
            newSpeed,
            newStroke,
            newDepth,
            100, // Not used in this mode
            KnownPattern.SimpleStroke
        );
    }

    /**
     * A rhythmic back-and-forth motion with asymmetric timing. The actuator moves steadily in one direction and quickly in the other
     * @param minDepth the minimum depth percentage (0-100)
     * @param maxDepth the maximum depth percentage (0-100)
     * @param speed the speed percentage (0-100)
     * @param intensity how pronounced the teasing/pounding effect is (0-100)
     * @param fastOnRetract when `true`, the actuator retracts quickly and extends slowly; default is `false`
     */
    async patternTeasingPounding(
        minDepth: number,
        maxDepth: number,
        speed: number,
        intensity: number,
        fastOnRetract: boolean = false
    ): Promise<void> {
        /* StrokeEngine.TeasingPounding command format:
         *
         * - minDepth / maxDepth:
         *   Define the absolute motion range.
         *   Internally mapped to Depth (maxDepth) and Stroke (maxDepth - minDepth).
         *
         * - Speed:
         *   Controls oscillation frequency.
         *
         * - Intensity:
         *   Controls strength of directional speed asymmetry.
         *
         * - fastOnRetract:
         *   true  -> fast retract, slow extend
         *   false -> fast extend, slow retract
         *
         * Notes:
         * - Motion limits behave identically to SimpleStroke.
         * - Sensation affects timing only, not motion range.
         */

        // Validate settings
        if (minDepth < 0 || minDepth > 100)
            throw new RangeError("minDepthAbsolute must be between 0 and 100.");
        if (maxDepth < 0 || maxDepth > 100)
            throw new RangeError("maxDepthAbsolute must be between 0 and 100.");
        if (minDepth >= maxDepth)
            throw new RangeError("minDepthAbsolute must be less than maxDepthAbsolute.");
        if (speed < 0 || speed > 100)
            throw new RangeError("Speed must be between 0 and 100.");
        if (intensity < 0 || intensity > 100)
            throw new RangeError("Intensity must be between 0 and 100.");

        // Calculate command values
        const newDepth = maxDepth;
        const newStroke = maxDepth - minDepth;
        const newSpeed = speed;
        // Divide by 2 here since we don't want the added granularity from converting a 0-100 scale to 0-50/50-100 scale
        const sensation = fastOnRetract
            ? 50 - Math.round(intensity / 2)
            : 50 + Math.round(intensity / 2);

        await this.sendPatternParameters(
            newSpeed,
            newStroke,
            newDepth,
            sensation,
            KnownPattern.TeasingPounding
        );
    }

    /**
     * A continuous stroking motion
     * @param minDepth the minimum depth percentage (0-100)
     * @param maxDepth the maximum depth percentage (0-100)
     * @param speed the speed percentage (0-100)
     * @param smoothness how smooth or abrupt the motion is (0-100)
     */
    async patternRoboStroke(
        minDepth: number,
        maxDepth: number,
        speed: number,
        smoothness: number
    ): Promise<void> {
        /* StrokeEngine.RoboStroke command format:
         * Similar to SimpleStroke but with adjustable motion profile.
         *
         * - Smoothness:
         *   Controls the motion curve:
         *     0   → linear, robotic motion
         *     100 → smooth, gradual acceleration and deceleration
         */

        // Validate settings
        if (minDepth < 0 || minDepth > 100)
            throw new RangeError("minDepthAbsolute must be between 0 and 100.");
        if (maxDepth < 0 || maxDepth > 100)
            throw new RangeError("maxDepthAbsolute must be between 0 and 100.");
        if (minDepth >= maxDepth)
            throw new RangeError("minDepthAbsolute must be less than maxDepthAbsolute.");
        if (speed < 0 || speed > 100)
            throw new RangeError("Speed must be between 0 and 100.");
        if (smoothness < 0 || smoothness > 100)
            throw new RangeError("Smoothness must be between 0 and 100.");

        // Calculate command values
        const newDepth = maxDepth;
        const newStroke = maxDepth - minDepth;
        const newSpeed = speed;
        const newSensation = smoothness;

        await this.sendPatternParameters(
            newSpeed,
            newStroke,
            newDepth,
            newSensation,
            KnownPattern.RoboStroke
        );
    }

    /**
     * Full and half depth strokes alternate.
     * @param minDepth the minimum depth percentage (0-100)
     * @param maxDepth the maximum depth percentage (0-100)
     * @param speed the speed percentage (0-100)
     * @param intensity how pronounced the half/full depth effect is (0-100)
     */
    async patternHalfNHalf(
        minDepth: number,
        maxDepth: number,
        speed: number,
        intensity: number,
        fastOnRetract: boolean = false
    ): Promise<void> {
        // Validate settings
        if (minDepth < 0 || minDepth > 100)
            throw new RangeError("minDepthAbsolute must be between 0 and 100.");
        if (maxDepth < 0 || maxDepth > 100)
            throw new RangeError("maxDepthAbsolute must be between 0 and 100.");
        if (minDepth >= maxDepth)
            throw new RangeError("minDepthAbsolute must be less than maxDepthAbsolute.");
        if (speed < 0 || speed > 100)
            throw new RangeError("Speed must be between 0 and 100.");
        if (intensity < 0 || intensity > 100)
            throw new RangeError("Intensity must be between 0 and 100.");

        // Calculate command values
        const newDepth = maxDepth;
        const newStroke = maxDepth - minDepth;
        const newSpeed = speed;
        // Divide by 2 here since we don't want the added granularity from converting a 0-100 scale to 0-50/50-100 scale
        const sensation = fastOnRetract
            ? 50 - Math.round(intensity / 2)
            : 50 + Math.round(intensity / 2);

        await this.sendPatternParameters(
            newSpeed,
            newStroke,
            newDepth,
            sensation,
            KnownPattern.HalfNHalf
        );
    }

    /**
     * Gradually deepens the stroke over a set number of cycles
     * @param minDepth the minimum depth percentage (0-100)
     * @param maxDepth the maximum depth percentage (0-100)
     * @param speed the speed percentage (0-100)
     * @param cycleMultiplier number of cycles to deepen over (0-100)
     */
    async patternDeeper(
        minDepth: number,
        maxDepth: number,
        speed: number,
        cycleMultiplier: number
    ): Promise<void> {
        /* StrokeEngine.RoboStroke command format:
         * Similar to SimpleStroke but with adjustable motion profile.
         *
         * - Cycle multiplier:
         *   Controls how many times the stroke deepens before resetting.
         */

        // Validate settings
        if (minDepth < 0 || minDepth > 100)
            throw new RangeError("minDepthAbsolute must be between 0 and 100.");
        if (maxDepth < 0 || maxDepth > 100)
            throw new RangeError("maxDepthAbsolute must be between 0 and 100.");
        if (minDepth >= maxDepth)
            throw new RangeError("minDepthAbsolute must be less than maxDepthAbsolute.");
        if (speed < 0 || speed > 100)
            throw new RangeError("Speed must be between 0 and 100.");
        if (cycleMultiplier < 0 || cycleMultiplier > 100)
            throw new RangeError("Cycle count must be between 0 and 100.");

        // Calculate command values
        const newDepth = maxDepth;
        const newStroke = maxDepth - minDepth;
        const newSpeed = speed;
        const newSensation = cycleMultiplier;

        await this.sendPatternParameters(
            newSpeed,
            newStroke,
            newDepth,
            newSensation,
            KnownPattern.Deeper
        );
    }

    /**
     * Pauses between strokes
     * @param minDepth the minimum depth percentage (0-100)
     * @param maxDepth the maximum depth percentage (0-100)
     * @param speed the speed percentage (0-100)
     * @param pauseDurationMultiplier number of cycles to pause over (0-100)
     */
    async patternStopNGo(
        minDepth: number,
        maxDepth: number,
        speed: number,
        pauseDurationMultiplier: number
    ): Promise<void> {
        /* StrokeEngine.RoboStroke command format:
         * Similar to SimpleStroke but with adjustable motion profile.
         *
         * - Pause duration multiplier:
         *   Controls how long the device pauses between strokes.
         */

        // Validate settings
        if (minDepth < 0 || minDepth > 100)
            throw new RangeError("minDepthAbsolute must be between 0 and 100.");
        if (maxDepth < 0 || maxDepth > 100)
            throw new RangeError("maxDepthAbsolute must be between 0 and 100.");
        if (minDepth >= maxDepth)
            throw new RangeError("minDepthAbsolute must be less than maxDepthAbsolute.");
        if (speed < 0 || speed > 100)
            throw new RangeError("Speed must be between 0 and 100.");
        if (pauseDurationMultiplier < 0 || pauseDurationMultiplier > 100)
            throw new RangeError("Cycle count must be between 0 and 100.");

        // Calculate command values
        const newDepth = maxDepth;
        const newStroke = maxDepth - minDepth;
        const newSpeed = speed;
        const newSensation = pauseDurationMultiplier;

        await this.sendPatternParameters(
            newSpeed,
            newStroke,
            newDepth,
            newSensation,
            KnownPattern.StopNGo
        );
    }

    async patternInsist(
        speed: number,
        position: number
    ): Promise<void> {
        // Validate settings
        if (speed < 0 || speed > 100)
            throw new RangeError("Speed must be between 0 and 100.");
        if (position < 0 || position > 100)
            throw new RangeError("Position must be between 0 and 100.");

        await this.sendPatternParameters(
            speed,
            100,
            position,
            100,
            KnownPattern.Insist
        );
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
    KnownPattern as KnownPatterns,
    type OssmEventCallback,
    type OssmState,
    type OssmPattern,
} from "./ossmBleTypes";
//#endregion
