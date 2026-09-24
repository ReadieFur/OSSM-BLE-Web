import { RadBleApi } from "./RadBleApi";
import * as Schema from "./OssmProtocolSchema";

// GATT schema definition
const OSSM_SERVICE_UUID = "522b443a-4f53-534d-0001-420badbabe69";

export class OssmBleClient extends RadBleApi {
    /**
     * Prompts the user via the browser to pair with an OSSM BLE device
     * @requires That the page is served over HTTPS or from localhost AND is called by a user gesture
     * @returns A new {@link OssmClient} on successful pairing
     * @throws DOMException if pairing is cancelled or fails
     */
    static async pairDevice(): Promise<OssmBleClient> {
        const bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: "OSSM" }],
            optionalServices: [OSSM_SERVICE_UUID]
        });
        return new OssmBleClient(bleDevice);
    }

    constructor(device: BluetoothDevice) {
        super(OSSM_SERVICE_UUID, device);
    }

    /**
     * Method calls based on:
     * {@link RadBleApi.getCatalog}
     * https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L213
     * https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L570
     */

    // #region sensor.read
    // https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L241

    /**
     * Gets the current position of the speed knob
     * @param raw If true, returns the raw sensor value (0-4096), otherwise returns a percentage (0-100)
     */
    async getSpeedKnob(raw: boolean = false): Promise<number> {
        /* https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L245
         * https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/board.cpp#L22
         * The OSSM firmware returns the raw sensor value via analogRead and uses a resolution of 12 (0-4096)
         * A percentage value between 0 and 100 is returned if the percent property is requested instead
         */
        return (await this.readSensor<Schema.OssmReadResult<number>>(
            raw ? "analog.speedKnob" : "analog.speedKnobPercent"
        )).value;
    }

    /**
     * @param unfiltered If true, returns the unfiltered sensor value, otherwise returns the calibrated sensor value
     * @returns The current motor current as a raw value (0-4096)
     */
    async getMotorCurrent(unfiltered: boolean = false): Promise<number> {
        return (await this.readSensor<Schema.OssmReadResult<number>>(
            unfiltered ? "analog.motorCurrent" : "analog.motorCurrentFiltered"
        )).value;
    }

    async isHomed(): Promise<boolean> {
        return (await this.readSensor<Schema.OssmReadResult<boolean>>("motion.homed")).value;
    }

    /**
     * @returns The current position millimeters
     */
    async getPosition(): Promise<number> {
        return (await this.readSensor<Schema.OssmReadResult<number>>("motion.position")).value;
    }

    async getMotorCurrentOffset(): Promise<number> {
        return (await this.readSensor<Schema.OssmReadResult<number>>("analog.currentOffset")).value;
    }

    /**
     * @returns The measured stroke length in millimeters
     */
    async getMeasuredStroke(): Promise<number> {
        return (await this.readSensor<Schema.OssmReadResult<number>>("motion.measuredStroke")).value;
    }

    /**
     * @returns The target position in millimeters
     */
    async getTargetPosition(): Promise<number> {
        return (await this.readSensor<Schema.OssmReadResult<number>>("motion.targetPosition")).value;
    }

    async getTargetTime(): Promise<number> {
        return (await this.readSensor<Schema.OssmReadResult<number>>("motion.targetTime")).value;
    }

    async getStrokeCount(): Promise<number> {
        return (await this.readSensor<Schema.OssmReadResult<number>>("session.strokeCount")).value;
    }

    /**
     * @returns The total distance traveled in meters for the current session
     */
    async getDistance(): Promise<number> {
        return (await this.readSensor<Schema.OssmReadResult<number>>("session.distance")).value;
    }

    async isEmergencyStopEngaged(): Promise<boolean> {
        return (await this.readSensor<Schema.OssmReadResult<boolean>>("button.emergencyStop")).value;
    }

    async isLimitSwitchEngaged(): Promise<boolean> {
        return (await this.readSensor<Schema.OssmReadResult<boolean>>("switch.limit")).value;
    }

    /**
     * Reads the state of a GPIO pin
     * @param pin The GPIO pin number to read (0-4)
     * @returns The analogRead value of the pin (0-4096)
     */
    async readGpioPin(pin: number): Promise<boolean> {
        return (await this.readSensor<Schema.OssmReadResult<boolean>>(`analog.expansion${pin}`)).value;
    }

    async isEnterButtonPressed(): Promise<boolean> {
        return (await this.readSensor<Schema.OssmReadResult<boolean>>("button.enter")).value;
    }

    /**
     * @returns The position of the motors rotary encoder
     */
    async getEncoderPosition(): Promise<number> {
        return (await this.readSensor<Schema.OssmReadResult<number>>("encoder.position")).value;
    }

    async getBleConnectionCount(): Promise<number> {
        return (await this.readSensor<Schema.OssmReadResult<number>>("connectivity.bleConnections")).value;
    }

    async getWifiStatus(): Promise<Schema.OssmWifiStatus> {
        const readResult = await this.readSensor<{ path: string } & Schema.OssmWifiStatus>("connectivity.wifi");
        // Remove the path property from the result before returning
        const { path, ...wifiStatus } = readResult;
        return wifiStatus;
    }
    // #endregion

    /**
     * Set the OSSM LED indicator to a specific color
     * @param r The red component of the color (0-255)
     * @param g The green component of the color (0-255)
     * @param b The blue component of the color (0-255)
     * @note The firmware seems to reset this value after a couple hundred milliseconds
     */
    async setLed(r: number, g: number, b: number): Promise<void> {
        // Range validation will be left to the firmware
        await this.send({ op: "indicator.set", path: "indicator.status", args: { r, g, b } }, this.lease!);
    }
}
