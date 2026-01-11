// Reference: https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/services/communication/BLE_Protocol.md

import type { ServicesDefinition } from "./helpers";
import { delay, DOMExceptionError } from "./helpers.js";

//#region Constants
const OSSM_GATT_SERVICES = {
    PRIMARY: {
        uuid: '522b443a-4f53-534d-0001-420badbabe69',
        characteristics: {
            SPEED_KNOB_CONFIGURATION: '522b443a-4f53-534d-1010-420badbabe69',
            CURRENT_STATE: '522b443a-4f53-534d-2000-420badbabe69',
            PATTERN_LIST: '522b443a-4f53-534d-3000-420badbabe69',
            PATTERN_DESCRIPTION: '522b443a-4f53-534d-3010-420badbabe69',
        }
    },
    DEVICE_INFORMATION: {
        uuid: '180a',
        characteristics: {
            MANUFACTURER_NAME: '2a29',
            SYSTEM_ID: '2a23',
        }
    }
} as const satisfies ServicesDefinition;

const OSSM_DEVICE_NAME = "OSSM";
const COMMAND_PROCESS_DELAY_MS = 50;

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();
//#endregion

export class OssmBle implements Disposable {
    //#region Static

    /**
     * Prompts the user via the browser to pair with an OSSM BLE device.
     * @requires that the page is served over HTTPS or from localhost & is called by a user gesture.
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
    private autoReconnect: boolean = true;
    private isReady: boolean = false;

    private primaryService: BluetoothRemoteGATTService | null = null;
    private speedKnobConfigCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
    private currentStateCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
    private patternListCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
    private patternDescriptionCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;

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
    private async connect(): Promise<void> {
        if (this.device.gatt?.connected)
            return;

        const gattSnapshot = await this.device.gatt!.connect();

        await delay(100); // Short delay to try and help mitigate the error noted below.

        /** An error can occur here where the device randomly and suddenly disconnects during service/characteristic discovery.
         * I'm not sure what causes this, but my auto-reconnect logic should be able to handle it.
         * Apparently this is a known issue with web bluetooth.
         */
        this.primaryService = await gattSnapshot.getPrimaryService(OSSM_GATT_SERVICES.PRIMARY.uuid);
        this.speedKnobConfigCharacteristic = await this.primaryService.getCharacteristic(OSSM_GATT_SERVICES.PRIMARY.characteristics.SPEED_KNOB_CONFIGURATION);
        this.currentStateCharacteristic = await this.primaryService.getCharacteristic(OSSM_GATT_SERVICES.PRIMARY.characteristics.CURRENT_STATE);
        this.patternListCharacteristic = await this.primaryService.getCharacteristic(OSSM_GATT_SERVICES.PRIMARY.characteristics.PATTERN_LIST);
        this.patternDescriptionCharacteristic = await this.primaryService.getCharacteristic(OSSM_GATT_SERVICES.PRIMARY.characteristics.PATTERN_DESCRIPTION);
        this.currentStateCharacteristic.addEventListener("characteristicvaluechanged", this.onCurrentStateChanged.bind(this));
        await this.currentStateCharacteristic.startNotifications();

        this.debugLog("Connected");
        this.isReady = true;
    }

    private throwIfNotReady(): void {
        if (!this.isReady)
            throw new DOMException("ossmBle not ready", DOMExceptionError.InvalidState);
    }

    private async onDisconnected(): Promise<void> {
        this.isReady = false;
        this.debugLog("Disconnected");

        // TODO: Set all (internal) functions to paused state, even once reconnected (for safety reasons).

        this.debugLogIf(this.autoReconnect, "Reconnecting...");
        while (this.autoReconnect)
        {
            let i = 0;
            try {
                await this.connect();
                // TODO: Set all (external) functions to paused state, even once reconnected (for safety reasons).
                break;
            } catch (error) {
                this.debugLog(`Reconnection attempt ${i} failed:`, error);
                await new Promise(resolve => setTimeout(resolve, 250)); // Attempt to reconnect as fast as possible for safety reasons, but with some backoff.
                i++;
            }
        }
    }

    private onCurrentStateChanged(event: Event): void {
        const state = JSON.parse(TEXT_DECODER.decode((event.target as BluetoothRemoteGATTCharacteristic).value!));
        this.debugLog("onCurrentStateChanged:", state);
    }

    private async throwIfCharacteristicIsError(characteristic: BluetoothRemoteGATTCharacteristic | null): Promise<void> {
        if (!characteristic)
            throw new Error("Characteristic is null.");

        const value = TEXT_DECODER.decode((await characteristic.readValue()).buffer);
        if (value.startsWith("error:"))
            throw new Error(`OSSM returned error: ${value}`);
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
     * Configure whether speed knob acts as upper limit for BLE speed commands
     * @param knobAsLimit
     * **When** `true`: BLE speed commands (0-100) are treated as a percentage of the current physical knob value  
     * Example: Knob at 50%, BLE command `set:speed:80` → Effective speed = 40%  
     * **When** `false`: BLE speed commands (0-100) are used directly as the speed value  
     * Example: BLE command `set:speed:80` → Effective speed = 80%
     */
    async setSpeedKnobConfig(knobAsLimit: boolean): Promise<void> {
        this.throwIfNotReady();
        await this.speedKnobConfigCharacteristic?.writeValue(TEXT_ENCODER.encode(knobAsLimit ? "true" : "false"));
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
        const value = TEXT_DECODER.decode((await this.speedKnobConfigCharacteristic!.readValue()).buffer);
        return value === "true";
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
