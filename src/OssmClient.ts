import { BleConnectionHandler, DiscoveredGattService, GattServiceDefinition } from "./BleConnectionHandler";
import { OssmPattern, OssmStateCharacteristicResponse } from "./Types";

// #region GATT schema definition
const OSSM_DEVICE_NAME = "OSSM";
const OSSM_PRIMARY_SERVICE = {
    uuid: '522b443a-4f53-534d-0001-420badbabe69',
    characteristics: {
        command: '522b443a-4f53-534d-1000-420badbabe69',
        speedKnobConfiguration: '522b443a-4f53-534d-1010-420badbabe69',
        latencyCompensationConfiguration: '522b443a-4f53-534d-1030-420badbabe69',
        wifi: '522b443a-4f53-534d-1020-420badbabe69',
        currentState: '522b443a-4f53-534d-2000-420badbabe69',
        patternList: '522b443a-4f53-534d-3000-420badbabe69',
        patternDescription: '522b443a-4f53-534d-3010-420badbabe69',
        gpioControl: '522b443a-4f53-534d-4000-420badbabe69'
    }
} as const satisfies GattServiceDefinition;
// #endregion

export class OssmClient extends BleConnectionHandler {
    /**
     * Prompts the user via the browser to pair with an OSSM BLE device
     * @requires that the page is served over HTTPS or from localhost AND is called by a user gesture
     * @returns BluetoothDevice on successful pairing
     * @throws DOMException if pairing is cancelled or fails
     */
    static async pairDevice(): Promise<OssmClient> {
        const bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: OSSM_DEVICE_NAME }],
            optionalServices: [OSSM_PRIMARY_SERVICE.uuid]
        });
        return new OssmClient(bleDevice);
    }

    readonly #textEncoder = new TextEncoder();
    readonly #textDecoder = new TextDecoder();
    readonly #invalidStateError = () => new DOMException("Invalid operation exception", "NotAllowedError");
    #ossmPrimaryService: DiscoveredGattService<typeof OSSM_PRIMARY_SERVICE> | null = null;
    
    constructor(device: BluetoothDevice) {
        super(device);
        this.debugLog(this);
    }

    /**
     * Sets up the GATT services and characteristics for the OSSM device
     */
    protected async setupServicesAndCharacteristics(gatt: BluetoothRemoteGATTServer): Promise<void> {
        this.#ossmPrimaryService = await BleConnectionHandler.discoverGattService(gatt, OSSM_PRIMARY_SERVICE);
        this.#ossmPrimaryService.characteristics.currentState.addEventListener("characteristicvaluechanged", this.handleCurrentStateChanged.bind(this));
    }

    /**
     * Handles changes to the current state characteristic when the OSSM device notifies of a state change
     */
    private handleCurrentStateChanged(event: Event): void {
        let state: OssmStateCharacteristicResponse;
        try { state = JSON.parse(this.#textDecoder.decode((event.target as BluetoothRemoteGATTCharacteristic).value)); }
        catch (error) {
            console.error("Error handling current state change:", error);
            return;
        }

        if (this.debug) {
            console.log('Current state changed:', state);
            // console.table(state);
        }
    }

    /**
     * Emergency stops the OSSM device discarding any queued actions
     */
    async stop(): Promise<void> {
        if (!this.#ossmPrimaryService) throw this.#invalidStateError();
        this.clearBleTaskQueue("Emergency stop invoked.");
        // This one we do manually, because we want to ensure it is sent immediately and not queued behind other tasks
        await this.prependBleTask(async () => {
            await this.#ossmPrimaryService?.characteristics.command.writeValue(this.#textEncoder.encode("set:speed:0"));
            // Possibly check return value?
        });
    }

    /**
     * Clears any pending commands in the bluetooth queue
     */
    async clearCommandQueue(): Promise<void> {
        if (!this.#ossmPrimaryService) throw this.#invalidStateError();
        this.clearBleTaskQueue();
    }

    /**
     * Fetches the current state of the OSSM device
     * @note This method triggers the onStateChanged event
     */
    // Keeping async keyword here even though there is no await allows for use of .catch() on this method (needed for the throw to be caught)
    async fetchState(): Promise<OssmStateCharacteristicResponse> {
        if (!this.#ossmPrimaryService) throw this.#invalidStateError();
        return this.readCharacteristic(this.#ossmPrimaryService.characteristics.currentState, 'json');
    }

    /**
     * Fetches the available patterns from the OSSM device
     * @returns A list of {@link OssmPattern} objects
     */
    async getPatterns(): Promise<OssmPattern[]> {
        if (!this.#ossmPrimaryService) throw this.#invalidStateError();

        let patterns: OssmPattern[] = [];

        const remotePatterns = await this.readCharacteristic<{name: string, idx: number}[]>(this.#ossmPrimaryService.characteristics.patternList, 'json');

        for (const pattern of remotePatterns) {
            const description = await this.enqueueBleTask(async () => {
                await this.#ossmPrimaryService!.characteristics.patternDescription.writeValue(this.#textEncoder.encode(pattern.idx.toString()));
                // No delay needed since the device writes the descriptor before responding to the write request
                return await this.#textDecoder.decode((await this.#ossmPrimaryService!.characteristics.patternDescription.readValue()).buffer).trim();
            });

            patterns.push({
                idx: pattern.idx,
                name: pattern.name,
                description
            });
        }

        return patterns;
    }

    /**
     * Set stroke speed percentage
     * @param speed A {@link number} between 0 and 100
     */
    async setSpeed(speed: number): Promise<void> {
        if (!this.#ossmPrimaryService) throw this.#invalidStateError();
        await this.writeCharacteristic(this.#ossmPrimaryService.characteristics.command, `set:speed:${this.commonClamp(speed)}`, true);
    }

    /**
     * Set stroke length percentage
     * @param stroke A {@link number} between 0 and 100
     */
    async setStroke(stroke: number): Promise<void> {
        if (!this.#ossmPrimaryService) throw this.#invalidStateError();
        await this.writeCharacteristic(this.#ossmPrimaryService.characteristics.command, `set:stroke:${this.commonClamp(stroke)}`, true);
    }

    /**
     * Set sensation intensity percentage
     * @param sensation A {@link number} between 0 and 100
     */    
    async setSensation(sensation: number): Promise<void> {
        if (!this.#ossmPrimaryService) throw this.#invalidStateError();
        await this.writeCharacteristic(this.#ossmPrimaryService.characteristics.command, `set:sensation:${this.commonClamp(sensation)}`, true);
    }

    /**
     * Set depth percentage
     * @param depth A {@link number} between 0 and 100
     */
    async setDepth(depth: number): Promise<void> {
        if (!this.#ossmPrimaryService) throw this.#invalidStateError();
        await this.writeCharacteristic(this.#ossmPrimaryService.characteristics.command, `set:depth:${this.commonClamp(depth)}`, true);
    }

    /**
     * Set stroke pattern (see {@link getPatternList} for available patterns)
     * @param patternId A {@link number} corresponding to a pattern ID (see {@link KnownPattern})
     */
    async setPattern(patternIdx: number): Promise<void> {
        if (!this.#ossmPrimaryService) throw this.#invalidStateError();
        if (Number.isNaN(patternIdx) || !Number.isInteger(patternIdx) || patternIdx < 0) throw new RangeError(`Invalid pattern index: ${patternIdx}. Must be a non-negative integer.`);
        await this.writeCharacteristic(this.#ossmPrimaryService.characteristics.command, `set:pattern:${patternIdx}`, true);
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
        if (!this.#ossmPrimaryService) throw this.#invalidStateError();
        await this.writeCharacteristic(this.#ossmPrimaryService.characteristics.speedKnobConfiguration, knobAsLimit, true);
    }

    /**
     * Gets whether speed knob acts as upper limit for BLE speed commands
     * @returns `true` if speed knob is configured as upper limit, `false` otherwise
     */
    async getSpeedKnobConfig(): Promise<boolean> {
        if (!this.#ossmPrimaryService) throw this.#invalidStateError();
        return this.readCharacteristic(this.#ossmPrimaryService.characteristics.speedKnobConfiguration, 'bool');
    }

    /**
     * Set WiFi credentials
     * @param ssid The SSID of the WiFi network
     * @param password The password of the WiFi network
     * @note This is sent as plain text over BLE, security not guaranteed
     */
    async setWiFiCredentials(ssid: string, password: string): Promise<void> {
        if (!this.#ossmPrimaryService) throw this.#invalidStateError();
        await this.writeCharacteristic(this.#ossmPrimaryService.characteristics.command, `set:wifi:${ssid}|${password}`, (res: string) => res.startsWith("ok:wifi:"));
    }

    // #region Characteristic operations & helpers
    private async readCharacteristic(
        characteristic: BluetoothRemoteGATTCharacteristic,
        type: 'string'
    ): Promise<string>;
    private async readCharacteristic(
        characteristic: BluetoothRemoteGATTCharacteristic,
        type: 'int'
    ): Promise<number>;
    private async readCharacteristic(
        characteristic: BluetoothRemoteGATTCharacteristic,
        type: 'bool'
    ): Promise<boolean>;
    private async readCharacteristic<T>(
        characteristic: BluetoothRemoteGATTCharacteristic,
        type: 'json'
    ): Promise<T>;
    private async readCharacteristic<T>(
        characteristic: BluetoothRemoteGATTCharacteristic,
        parser: (text: string, dataView: DataView) => T
    ): Promise<T>;
    private async readCharacteristic<T>(
        characteristic: BluetoothRemoteGATTCharacteristic,
        typeOrParser: 'string' | 'int' | 'bool' | 'json' | ((text: string, dataView: DataView) => T) = 'string'
    ): Promise<any> {
        const dataView = await this.enqueueBleTask(() => characteristic.readValue());
        const rawText = this.#textDecoder.decode(dataView.buffer).trim();

        // Handle custom parser function
        if (typeof typeOrParser === 'function')
            return typeOrParser(rawText, dataView);

        switch (typeOrParser) {
            case 'string':
                return rawText;

            case 'int': {
                const parsed = parseInt(rawText, 10);
                if (Number.isNaN(parsed))
                    throw new DOMException(`Failed to parse integer from characteristic value: "${rawText}"`, "DataError");
                return parsed;
            }

            case 'bool': {
                const normalized = rawText.toLowerCase();
                return normalized === 'true' || normalized === '1';
            }

            case 'json':
                try { return JSON.parse(rawText) as T; }
                catch (err) { throw new DOMException(`Failed to parse JSON from characteristic value: "${rawText}"`, "DataError"); }

            default:
                throw new Error(`Unsupported characteristic parse type: ${typeOrParser}`);
        }
    }

    /**
     * Writes a value to a characteristic and optionally checks the result for success
     * @param characteristic The characteristic to write to
     * @param value The value to be written
     * @param checkResult Optional. If true, checks the result for success using common heuristics. If a function is provided, it will be used to validate the result.
     */
    private async writeCharacteristic(
        characteristic: BluetoothRemoteGATTCharacteristic,
        value: string | number | boolean | object,
        checkResult?: true | ((response: string) => boolean)
    ): Promise<void> {
        let commandStr: string;
        switch (typeof value) {
            case 'string':
                commandStr = value;
                break;
            case 'number':
                commandStr = value.toString();
                break;
            case 'boolean':
                commandStr = value ? 'true' : 'false';
                break;
            case 'object':
            default:
                commandStr = JSON.stringify(value);
                break;
        }
        let buf = this.#textEncoder.encode(commandStr);

        const result = await this.enqueueBleTask(async () => {
            await characteristic.writeValue(buf);
            return checkResult ? this.#textDecoder.decode((await characteristic.readValue()).buffer).trim() : null;
        });

        if (!checkResult) return;
        if (result === null) throw new DOMException("Invalid operation exception: checkResult is true but no result was returned from the characteristic.", "NotAllowedError");

        if (typeof checkResult === 'function') {
            if (!checkResult(result))
                throw new DOMException(`Characteristic write validation failed. Validation predicate returned false for result: ${result}`, "OperationError");
        } else {
            // Basic error check
            if (result.startsWith("error:") || result.startsWith("fail:"))
                throw new DOMException(`Characteristic write failed: ${result}`, "OperationError");

            // Set value check
            switch (typeof value) {
                case 'string':
                    // Standard string commands with a valid response start with "ok:" and are followed by the original command string
                    // The docs say it should be prefixed but the official docs are shit as per usual and this is not always the case, so we check both
                    const actualResult = result.startsWith('ok:') ? result.slice(3).trim() : result.trim();
                    if (actualResult !== commandStr)
                        throw new DOMException(`Characteristic write validation failed. Expected: "${commandStr}", Actual: "${actualResult}"`, "OperationError");
                    break;
                // Number and boolean commands return a stringified version of the set value
                case 'number':
                    if (result !== commandStr)
                        throw new DOMException(`Characteristic write validation failed. Expected: "${commandStr}", Actual: "${result}"`, "OperationError");
                    break;
                case 'boolean':
                    const truthyValues = ['true', '1', 't'];
                    const falsyValues = ['false', '0', 'f'];
                    const normalizedResult = result.toLowerCase();
                    if ((value && !truthyValues.includes(normalizedResult)) || (!value && !falsyValues.includes(normalizedResult)))
                        throw new DOMException(`Characteristic write validation failed. Expected: "${commandStr}", Actual: "${result}"`, "OperationError");
                    break;
                case 'object':
                default:
                    break;
            }
        }
    }

    private commonClamp(value: number): number {
        if (Number.isNaN(value) || !Number.isFinite(value)) throw new RangeError(`Invalid value: ${value}. Must be a finite number between 0 and 100.`);
        return Math.max(0, Math.min(100, value));
    }
    // #endregion
}
