// Reference: https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/services/communication/BLE_Protocol.md

import type { ServicesDefinition, UpperSnakeToCamel } from "./helpers";
import { AsyncFunctionQueue, delay, DOMExceptionError, upperSnakeToCamel } from "./helpers";
import { OssmMenu, OssmEventType, type OssmEventCallback, type OssmState, type OssmPattern } from "./ossmBleTypes";
export { OssmMenu, OssmEventType, type OssmEventCallback, type OssmState, type OssmPattern } from "./ossmBleTypes"; // Include specific types in bundled export.

//#region Constants
const OSSM_DEVICE_NAME = "OSSM";
const COMMAND_PROCESS_DELAY_MS = 25;
const OSSM_GATT_SERVICES = {
    PRIMARY: {
        uuid: '522b443a-4f53-534d-0001-420badbabe69',
        characteristics: {
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
    private async dispatchEvent(eventType: OssmEventType, data: null): Promise<void> {
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

            /** An error can occur here where the device randomly and suddenly disconnects during service/characteristic discovery.
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
        while (this.autoReconnect)
        {
            let i = 0;
            try {
                await this.connect();
                break;
            } catch (error) {
                this.debugLog(`Reconnection attempt ${i} failed:`, error);
                await new Promise(resolve => setTimeout(resolve, 250)); // Attempt to reconnect as fast as possible for safety reasons, but with some backoff.
                i++;
            }
        }

        // Because we disconnected we should immediately set to paused state for safety reasons.
        try { this.setSpeed(0); }
        catch {}
    }

    private onCurrentStateChanged(event: Event): void {
        const state = JSON.parse(TEXT_DECODER.decode((event.target as BluetoothRemoteGATTCharacteristic).value!)) as OssmState;
        this.debugLog("onCurrentStateChanged:", state);
        this.cachedState = state;
        this.dispatchEvent(OssmEventType.StateChanged, null);
    }

    private async sendCommand(characteristic: BluetoothRemoteGATTCharacteristic, value: string): Promise<void> {
        this.throwIfNotReady();

        const returnedValue = await this.bleTaskQueue.enqueue(async () => {
            await characteristic.writeValue(TEXT_ENCODER.encode(value));
            await delay(COMMAND_PROCESS_DELAY_MS); // Give OSSM time to process the command.
            return TEXT_DECODER.decode((await this.ossmServices!.primary.characteristics.speedKnobConfiguration.readValue()).buffer) as string;
        });

        if (returnedValue === `fail:${value}`) {
            throw new DOMException(`OSSM failed to process command: ${value}`, DOMExceptionError.OperationError);
        } else if (returnedValue !== `ok:${value}`) {
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
     * Set stroke speed percentage
     * @param speed A {@link number} between 0 and 100
     * @throws RangeError if speed is out of range
     * @throws DOMException if the command fails
     */
    async setSpeed(speed: number): Promise<void> {
        if (speed < 0 || speed > 100)
            throw new RangeError("Speed must be between 0 and 100.");
        this.sendCommand(this.ossmServices!.primary.characteristics.currentState, `set:speed:${speed}`);
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
        this.sendCommand(this.ossmServices!.primary.characteristics.currentState, `set:stroke:${stroke}`);
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
        this.sendCommand(this.ossmServices!.primary.characteristics.currentState, `set:depth:${depth}`);
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
        this.sendCommand(this.ossmServices!.primary.characteristics.currentState, `set:sensation:${sensation}`);
    }

    /**
     * Set stroke pattern (see {@link getPatternList} for available patterns)
     * @param patternId A {@link number} corresponding to a pattern ID
     */
    async setPattern(patternId: number): Promise<void> {
        this.sendCommand(this.ossmServices!.primary.characteristics.currentState, `set:pattern:${patternId}`);
    }

    /**
     * Navigate to a specific menu page
     * @param page One of the {@link OssmMenu} enum values
     */
    async navigateTo(page: OssmMenu): Promise<void> {
        this.sendCommand(this.ossmServices!.primary.characteristics.currentState, `go:${page}`);
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
        return patterns;
    }

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
    //#endregion
}
