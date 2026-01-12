// Reference: https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/services/communication/BLE_Protocol.md

import type { ServicesDefinition, UpperSnakeToCamel } from "./helpers";
import { delay, DOMExceptionError, upperSnakeToCamel } from "./helpers";

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
    }
} as const satisfies ServicesDefinition;

const OSSM_DEVICE_NAME = "OSSM";
const COMMAND_PROCESS_DELAY_MS = 50;

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();
//#endregion

//#region Types & Interfaces
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

    private ossmServices: OSSMServices | null = null;

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
        this.ossmServices!.primary.characteristics.speedKnobConfiguration.writeValue(TEXT_ENCODER.encode(knobAsLimit ? "true" : "false"));
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
