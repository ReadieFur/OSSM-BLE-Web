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

    // Shadow the base class getStateSnapshot to return the OSSM-specific StateSnapshot type
    override async getStateSnapshot(): Promise<Schema.OssmStateSnapshot> {
        return super.getStateSnapshot();
    }

    override async getEssentialSnapshot(): Promise<Schema.OssmEssentialSnapshot> {
        return super.getEssentialSnapshot() as any as Schema.OssmEssentialSnapshot;
    }

    override async getConnectivitySnapshot(): Promise<Schema.OssmConnectivitySnapshot> {
        return super.getConnectivitySnapshot() as any as Schema.OssmConnectivitySnapshot;
    }

    // #region setting.read
    // https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L239

    async getSpeed(): Promise<number> {
        return (await this.readSetting<Schema.OssmReadResult<number>>("motion.speed")).value;
    }

    async getStroke(): Promise<number> {
        return (await this.readSetting<Schema.OssmReadResult<number>>("motion.stroke")).value;
    }

    async getDepth(): Promise<number> {
        return (await this.readSetting<Schema.OssmReadResult<number>>("motion.depth")).value;
    }

    /**
     * Gets the 'sensation' setting which is often used as an arbitrary parameter value for the set StrokeEngine pattern
     */
    async getSensation(): Promise<number> {
        return (await this.readSetting<Schema.OssmReadResult<number>>("motion.sensation")).value;
    }

    async getBuffer(): Promise<number> {
        return (await this.readSetting<Schema.OssmReadResult<number>>("motion.buffer")).value;
    }

    /**
     * Gets the current active pattern idx for the StrokeEngine
     */
    async getActivePatternIndex(): Promise<number> {
        return (await this.readSetting<Schema.OssmReadResult<number>>("motion.pattern")).value;
    }

    async getSpeedBle(): Promise<number> {
        // I believe this gets the 'simulated' ble speed for when the speed knob limit is enabled?
        return (await this.readSetting<Schema.OssmReadResult<number>>("motion.speedBle")).value;
    }

    async isSpeedKnobAsLimit(): Promise<boolean> {
        return (await this.readSetting<Schema.OssmReadResult<boolean>>("setting.speedKnobAsLimit")).value;
    }

    async getLatencyCompensation(): Promise<number> {
        return (await this.readSetting<Schema.OssmReadResult<number>>("setting.latencyCompensation")).value;
    }

    async getDisplayMetric(): Promise<string> {
        return (await this.readSetting<Schema.OssmReadResult<string>>("setting.displayMetric")).value;
    }

    async getAfterHomingPosition(): Promise<number> {
        return (await this.readSetting<Schema.OssmReadResult<number>>("setting.afterHomingPosition")).value;
    }

    async getMqttPublishFrequency(): Promise<number> {
        return (await this.readSetting<Schema.OssmReadResult<number>>("setting.mqttPublishFrequency")).value;
    }

    override async getDeviceName(): Promise<string> {
        return (await this.readSetting<Schema.OssmReadResult<string>>("setting.deviceName")).value;
    }

    async getFirmwareProvenance() {
        const result = await this.readSetting<{ path: string } & Schema.OssmFirmwareProvenance>("device.firmwareProvenance");
        const { path, ...provenance } = result;
        return provenance;
    }
    // #endregion

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

    // #region setting.write
    // https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L309

    /** Sets the pin to output mode and writes the given value */
    async setGpioPin(pin: number, value: number): Promise<void>;
    /** Sets a pin to input mode */
    async setGpioPin(pin: number, mode: Extract<Schema.OssmGpioPinMode, "input" | "inputPullup">): Promise<void>;
    /** @deprecated Use the overloaded methods instead */
    async setGpioPin(pin: number, modeOrValue: Schema.OssmGpioPinMode | number): Promise<void> {
        let finalMode: Schema.OssmGpioPinMode;
        let finalValue: number | undefined;

        if (typeof modeOrValue === "number") {
            finalMode = Schema.OssmGpioPinMode.Output;
            finalValue = modeOrValue;
        } else {
            finalMode = modeOrValue;
            finalValue = undefined;
        }

        await this.writeSetting(`analog.expansion${pin}`, {
            mode: finalMode,
            value: finalValue
        });
    }

    /**
     * Configure whether speed knob acts as upper limit for BLE speed commands
     * @param value
     * **When** `true`: BLE speed commands (0-100) are treated as a percentage of the current physical knob value  
     * Example: Knob at 50%, BLE command `set:speed:80` → Effective speed = 40%  
     * **When** `false`: BLE speed commands (0-100) are used directly as the speed value  
     * Example: BLE command `set:speed:80` → Effective speed = 80%
     */
    async setSpeedKnobAsLimit(value: boolean): Promise<void> {
        await this.writeSetting("setting.speedKnobAsLimit", { value });
    }

    async setLatencyCompensation(value: boolean): Promise<void> {
        await this.writeSetting("setting.latencyCompensation", { value });
    }

    async setDisplayMetric(value: boolean): Promise<void> {
        await this.writeSetting("setting.displayMetric", { value });
    }

    async setAfterHomingPosition(value: number): Promise<void> {
        await this.writeSetting("setting.afterHomingPosition", { value });
    }

    async setMqttPublishFrequency(value: number): Promise<void> {
        await this.writeSetting("setting.mqttPublishFrequency", { value });
    }

    async setSpeedBle(value: number): Promise<void> {
        await this.writeSetting("motion.speedBle", { value });
    }

    // override async setDeviceName(name: string): Promise<void> {
    //     await this.writeSetting("setting.deviceName", { value: name });
    // }

    /**
     * Sets the active pattern for the StrokeEngine
     * @param patternIdx The index of the pattern to set. See {@link}
     */
    async setPattern(patternIdx: number): Promise<void> {
        await this.writeSetting("motion.pattern", { value: patternIdx });
    }

    /** @param value The speed value between 0 and 100 */
    async setSpeed(value: number): Promise<void> {
        await this.writeSetting("motion.speed", { value });
    }

    /** @param value The stroke length value between 0 and 100 */
    async setStroke(value: number): Promise<void> {
        await this.writeSetting("motion.stroke", { value });
    }

    /** @param value The depth value between 0 and 100 */
    async setDepth(value: number): Promise<void> {
        await this.writeSetting("motion.depth", { value });
    }

    /** @param value The sensation value between 0 and 100 */
    async setSensation(value: number): Promise<void> {
        await this.writeSetting("motion.sensation", { value });
    }

    /** @param value The buffer value between 0 and 100 */
    async setBuffer(value: number): Promise<void> {
        await this.writeSetting("motion.buffer", { value });
    }
    // #endregion

    // #region [input|event].emit
    // https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L431

    private async emitEvent(path: string, args?: Record<string, unknown>): Promise<void> {
        this.requireLease();
        await this.send({ op: "event.emit", path, args }, this.lease!);
    }

    async emitButtonEvent(clickType: Schema.OssmButtonClickType): Promise<void> {
        await this.emitEvent("button.enter", { event: clickType });
    }

    async emitReturnToMenuEvent(): Promise<void> {
        await this.emitEvent("event.returnToMenu");
    }

    async emitDoneEvent(): Promise<void> {
        await this.emitEvent("event.done");
    }

    async emitErrorEvent(): Promise<void> {
        await this.emitEvent("event.error");
    }

    async emitGoHomeEvent(): Promise<void> {
        await this.emitEvent("event.home");
    }

    async emitEmergencyStopEvent(): Promise<void> {
        await this.emitEvent("event.emergencyStop");
    }

    async emitUpdateUnavailableEvent(): Promise<void> {
        await this.emitEvent("event.updateUnavailable");
    }
    // #endregion

    // #region target.set
    // https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L465

    async navigateTo(menu: Schema.OssmMenu): Promise<void> {
        this.requireLease();
        const result = await this.send<{ deferred?: true }>({ op: "target.set", path: `target.${menu}` }, this.lease!);
        // TODO: If the task is deferred figure out how to wait for it to complete
    }

    /** Runs the calibration task on the machine */
    async homeRail(): Promise<void> {
        this.requireLease();
        this.send({ op: "target.set", path: "target.home" }, this.lease!);
    }

    /** Emergency stops the device */
    async emergencyStop(): Promise<void> {
        this.requireLease();
        this.send({ op: "target.set", path: "target.emergencyStop" }, this.lease!);
    }

    /**
     * @param position The new target position to move to
     * @param durationMs The time in milliseconds it takes to transition to the new position
     * @note Requires the device to be in {@link Schema.OssmMenu.Streaming} mode
     */
    async streamPosition(position: number, durationMs: number): Promise<void> {
        this.requireLease();
        this.send({
            op: "target.set",
            path: "motion.position",
            args: {
                value: position,
                durationMs
            }
        }, this.lease!);
    }
    // #endregion

    // #region encoder.[set|delta]
    // https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L530

    /**
     * Writes a value to the encoder
     * @param value The value to write to the encoder
     * @param isAbsolute When 'true' the value is written as-is to the encoder. When 'false' the value is added to the current encoder value
     */
    async encoderWrite(value: number, isAbsolute: boolean) {
        this.requireLease();
        await this.send({
            op: isAbsolute ? "encoder.set" : "encoder.delta",
            path: "encoder.main",
            args: isAbsolute ? { value } : { delta: value }
        });
    }
    // #endregion

    // #region indicator.set
    // https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L547

    /**
     * Set the OSSM LED indicator to a specific color
     * @param r The red component of the color (0-255)
     * @param g The green component of the color (0-255)
     * @param b The blue component of the color (0-255)
     * @note The firmware seems to reset this value after a couple hundred milliseconds
     */
    async setLed(r: number, g: number, b: number): Promise<void> {
        this.requireLease();
        // Range validation will be left to the firmware
        await this.send({ op: "indicator.set", path: "indicator.status", args: { r, g, b } }, this.lease!);
    }
    // #endregion
}
