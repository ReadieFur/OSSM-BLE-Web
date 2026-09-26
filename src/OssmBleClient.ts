import { RadBleApi, RadTelemetry } from "./RadBleApi";
import * as OssmSchema from "./OssmProtocolSchema";
import * as RadSchema from "./RadProtocolSchema";
import { SingleEvent, SingleEventSource } from "./SingleEvent";

const OSSM_SERVICE_UUID = "522b443a-4f53-534d-0001-420badbabe69";

const OSSM_SURFACE_STREAM_MAP = {
    [RadSchema.RadSurface.Essential]: "essential.live",
    [RadSchema.RadSurface.Encoder]: "encoder.main",
    [RadSchema.RadSurface.Connectivity]: "connectivity.wifi",
    [RadSchema.RadSurface.Analog]: "analog.motorCurrent",
    [RadSchema.RadSurface.Button]: "button.emergencyStop",
    [RadSchema.RadSurface.Motion]: "motion.speed"
} as const satisfies Record<OssmSchema.OssmSurface, string>;

type OssmSurfaceEvents<OWNED extends boolean = false> = {
    [K in keyof OssmSchema.OssmSurfacePayloadMap]: OWNED extends true
        ? SingleEventSource<[OssmSchema.OssmSurfacePayloadMap[K]]>
        : SingleEvent<[OssmSchema.OssmSurfacePayloadMap[K]]>;
};

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

    readonly #onStreamSignature = this.#onStream.bind(this);
    readonly #onSurface: Readonly<OssmSurfaceEvents<true>>;

    get onSurface(): Readonly<OssmSurfaceEvents<false>> { return this.#onSurface; }

    constructor(device: BluetoothDevice) {
        super(OSSM_SERVICE_UUID, device);

        const surfaceEventDispatchers = {} as OssmSurfaceEvents<true>;
        for (const surfaceKey of Object.keys(OSSM_SURFACE_STREAM_MAP) as (keyof OssmSchema.OssmSurfacePayloadMap)[])
            surfaceEventDispatchers[surfaceKey] = new SingleEventSource() as any;
        this.#onSurface = surfaceEventDispatchers;

        super.onRadTelemetry["sensorStream"].subscribe(this.#onStreamSignature);
    }

    /**
     * Method calls based on:
     * {@link RadBleApi.getCatalog}
     * https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L213
     * https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L570
     */

    // #region Snapshots
    // Shadow the base class getStateSnapshot to return the OSSM-specific StateSnapshot type
    override async getStateSnapshot(timeoutMs?: number): Promise<OssmSchema.OssmStateSnapshot> {
        const snapshot = await super.getStateSnapshot(timeoutMs);
        // this.#onSurface[RadSchema.RadSurface.State].dispatch(snapshot);
        return snapshot;
    }

    override async getEssentialSnapshot(timeoutMs?: number): Promise<OssmSchema.OssmEssentialSnapshot> {
        const snapshot = await super.getEssentialSnapshot(timeoutMs) as any as OssmSchema.OssmEssentialSnapshot;
        this.#onSurface[RadSchema.RadSurface.Essential].dispatch(snapshot);
        return snapshot;
    }

    override async getConnectivitySnapshot(timeoutMs?: number): Promise<OssmSchema.OssmConnectivitySnapshot> {
        const snapshot = await super.getConnectivitySnapshot(timeoutMs) as any as OssmSchema.OssmConnectivitySnapshot;
        this.#onSurface[RadSchema.RadSurface.Connectivity].dispatch(snapshot);
        return snapshot;
    }

    async getButtonSnapshot(timeoutMs?: number): Promise<OssmSchema.OssmButtonSnapshot> {
        const snapshot = await this.getSnapshot<OssmSchema.OssmButtonSnapshot>(OSSM_SURFACE_STREAM_MAP[RadSchema.RadSurface.Button], timeoutMs);
        this.#onSurface[RadSchema.RadSurface.Button].dispatch(snapshot);
        return snapshot;
    }

    async getEncoderSnapshot(timeoutMs?: number): Promise<OssmSchema.OssmEncoderSnapshot> {
        const snapshot = await this.getSnapshot<OssmSchema.OssmEncoderSnapshot>(OSSM_SURFACE_STREAM_MAP[RadSchema.RadSurface.Encoder], timeoutMs);
        this.#onSurface[RadSchema.RadSurface.Encoder].dispatch(snapshot);
        return snapshot;
    }

    async getAnalogSnapshot(timeoutMs?: number): Promise<OssmSchema.OssmAnalogSnapshot> {
        const snapshot = await this.getSnapshot<OssmSchema.OssmAnalogSnapshot>(OSSM_SURFACE_STREAM_MAP[RadSchema.RadSurface.Analog], timeoutMs);
        this.#onSurface[RadSchema.RadSurface.Analog].dispatch(snapshot);
        return snapshot;
    }

    async getMotionSnapshot(timeoutMs?: number): Promise<OssmSchema.OssmMotionSnapshot> {
        const snapshot = await this.getSnapshot<OssmSchema.OssmMotionSnapshot>(OSSM_SURFACE_STREAM_MAP[RadSchema.RadSurface.Motion], timeoutMs);
        this.#onSurface[RadSchema.RadSurface.Motion].dispatch(snapshot);
        return snapshot;
    }
    // #endregion

    // #region setting.read
    // https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L239

    async getSpeed(timeoutMs?: number): Promise<number> {
        return (await this.readSetting<OssmSchema.OssmReadResult<number>>("motion.speed", timeoutMs, true)).value;
    }

    async getStroke(timeoutMs?: number): Promise<number> {
        return (await this.readSetting<OssmSchema.OssmReadResult<number>>("motion.stroke", timeoutMs)).value;
    }

    async getDepth(timeoutMs?: number): Promise<number> {
        return (await this.readSetting<OssmSchema.OssmReadResult<number>>("motion.depth", timeoutMs)).value;
    }

    /**
     * Gets the 'sensation' setting which is often used as an arbitrary parameter value for the set StrokeEngine pattern
     */
    async getSensation(timeoutMs?: number): Promise<number> {
        return (await this.readSetting<OssmSchema.OssmReadResult<number>>("motion.sensation", timeoutMs)).value;
    }

    async getBuffer(timeoutMs?: number): Promise<number> {
        return (await this.readSetting<OssmSchema.OssmReadResult<number>>("motion.buffer", timeoutMs)).value;
    }

    /**
     * Gets the current active pattern idx for the StrokeEngine
     */
    async getActivePatternIndex(timeoutMs?: number): Promise<number> {
        return (await this.readSetting<OssmSchema.OssmReadResult<number>>("motion.pattern", timeoutMs)).value;
    }

    async getSpeedBle(timeoutMs?: number): Promise<number> {
        // I believe this gets the 'simulated' ble speed for when the speed knob limit is enabled?
        return (await this.readSetting<OssmSchema.OssmReadResult<number>>("motion.speedBle", timeoutMs)).value;
    }

    async isSpeedKnobAsLimit(timeoutMs?: number): Promise<boolean> {
        return (await this.readSetting<OssmSchema.OssmReadResult<boolean>>("setting.speedKnobAsLimit", timeoutMs)).value;
    }

    async getLatencyCompensation(timeoutMs?: number): Promise<number> {
        return (await this.readSetting<OssmSchema.OssmReadResult<number>>("setting.latencyCompensation", timeoutMs)).value;
    }

    async getDisplayMetric(timeoutMs?: number): Promise<string> {
        return (await this.readSetting<OssmSchema.OssmReadResult<string>>("setting.displayMetric", timeoutMs)).value;
    }

    async getAfterHomingPosition(timeoutMs?: number): Promise<number> {
        return (await this.readSetting<OssmSchema.OssmReadResult<number>>("setting.afterHomingPosition", timeoutMs)).value;
    }

    async getMqttPublishFrequency(timeoutMs?: number): Promise<number> {
        return (await this.readSetting<OssmSchema.OssmReadResult<number>>("setting.mqttPublishFrequency", timeoutMs)).value;
    }

    override async getDeviceName(timeoutMs?: number): Promise<string> {
        return (await this.readSetting<OssmSchema.OssmReadResult<string>>("setting.deviceName", timeoutMs)).value;
    }

    async getFirmwareProvenance(timeoutMs?: number) {
        const result = await this.readSetting<{ path: string } & OssmSchema.OssmFirmwareProvenance>("device.firmwareProvenance", timeoutMs);
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
    async getSpeedKnob(raw: boolean = false, timeoutMs?: number): Promise<number> {
        /* https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L245
         * https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/board.cpp#L22
         * The OSSM firmware returns the raw sensor value via analogRead and uses a resolution of 12 (0-4096)
         * A percentage value between 0 and 100 is returned if the percent property is requested instead
         */
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>(
            raw ? "analog.speedKnob" : "analog.speedKnobPercent",
            timeoutMs
        )).value;
    }

    /**
     * @param unfiltered If true, returns the unfiltered sensor value, otherwise returns the calibrated sensor value
     * @returns The current motor current as a raw value (0-4096)
     */
    async getMotorCurrent(unfiltered: boolean = false, timeoutMs?: number): Promise<number> {
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>(
            unfiltered ? "analog.motorCurrent" : "analog.motorCurrentFiltered",
            timeoutMs
        )).value;
    }

    async isHomed(timeoutMs?: number): Promise<boolean> {
        return (await this.readSensor<OssmSchema.OssmReadResult<boolean>>("motion.homed", timeoutMs)).value;
    }

    /**
     * @returns The current position millimeters
     */
    async getPosition(timeoutMs?: number): Promise<number> {
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>("motion.position", timeoutMs, true)).value;
    }

    async getMotorCurrentOffset(timeoutMs?: number): Promise<number> {
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>("analog.currentOffset", timeoutMs)).value;
    }

    /**
     * @returns The measured stroke length in millimeters
     */
    async getMeasuredStroke(timeoutMs?: number): Promise<number> {
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>("motion.measuredStroke", timeoutMs)).value;
    }

    /**
     * @returns The target position in millimeters
     */
    async getTargetPosition(timeoutMs?: number): Promise<number> {
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>("motion.targetPosition", timeoutMs)).value;
    }

    async getTargetTime(timeoutMs?: number): Promise<number> {
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>("motion.targetTime", timeoutMs)).value;
    }

    async getStrokeCount(timeoutMs?: number): Promise<number> {
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>("session.strokeCount", timeoutMs)).value;
    }

    /**
     * @returns The total distance traveled in meters for the current session
     */
    async getDistance(timeoutMs?: number): Promise<number> {
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>("session.distance", timeoutMs)).value;
    }

    async isEmergencyStopEngaged(timeoutMs?: number): Promise<boolean> {
        return (await this.readSensor<OssmSchema.OssmReadResult<boolean>>("button.emergencyStop", timeoutMs)).value;
    }

    async isLimitSwitchEngaged(timeoutMs?: number): Promise<boolean> {
        return (await this.readSensor<OssmSchema.OssmReadResult<boolean>>("switch.limit", timeoutMs)).value;
    }

    /**
     * Reads the state of a GPIO pin
     * @param pin The GPIO pin number to read (0-4)
     * @returns The analogRead value of the pin (0-4096)
     */
    async readGpioPin(pin: number, timeoutMs?: number): Promise<boolean> {
        return (await this.readSensor<OssmSchema.OssmReadResult<boolean>>(`analog.expansion${pin}`, timeoutMs)).value;
    }

    async isEnterButtonPressed(timeoutMs?: number): Promise<boolean> {
        return (await this.readSensor<OssmSchema.OssmReadResult<boolean>>("button.enter", timeoutMs)).value;
    }

    /**
     * @returns The position of the motors rotary encoder
     */
    async getEncoderPosition(timeoutMs?: number): Promise<number> {
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>("encoder.position", timeoutMs)).value;
    }

    async getBleConnectionCount(timeoutMs?: number): Promise<number> {
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>("connectivity.bleConnections", timeoutMs)).value;
    }

    async getWifiStatus(timeoutMs?: number): Promise<OssmSchema.OssmWifiStatus> {
        const readResult = await this.readSensor<{ path: string } & OssmSchema.OssmWifiStatus>("connectivity.wifi", timeoutMs);
        // Remove the path property from the result before returning
        const { path, ...wifiStatus } = readResult;
        return wifiStatus;
    }
    // #endregion

    // #region setting.write
    // https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L309

    /** Sets the pin to output mode and writes the given value */
    async setGpioPin(pin: number, value: number, timeoutMs?: number): Promise<void>;
    /** Sets a pin to input mode */
    async setGpioPin(pin: number, mode: Extract<OssmSchema.OssmGpioPinMode, "input" | "inputPullup">, timeoutMs?: number): Promise<void>;
    /** @deprecated Use the overloaded methods instead */
    async setGpioPin(pin: number, modeOrValue: OssmSchema.OssmGpioPinMode | number, timeoutMs?: number): Promise<void> {
        let finalMode: OssmSchema.OssmGpioPinMode;
        let finalValue: number | undefined;

        if (typeof modeOrValue === "number") {
            finalMode = OssmSchema.OssmGpioPinMode.Output;
            finalValue = modeOrValue;
        } else {
            finalMode = modeOrValue;
            finalValue = undefined;
        }

        await this.writeSetting(`analog.expansion${pin}`, {
            mode: finalMode,
            value: finalValue
        }, timeoutMs);
    }

    /**
     * Configure whether speed knob acts as upper limit for BLE speed commands
     * @param value
     * **When** `true`: BLE speed commands (0-100) are treated as a percentage of the current physical knob value  
     * Example: Knob at 50%, BLE command `set:speed:80` → Effective speed = 40%  
     * **When** `false`: BLE speed commands (0-100) are used directly as the speed value  
     * Example: BLE command `set:speed:80` → Effective speed = 80%
     */
    async setSpeedKnobAsLimit(value: boolean, timeoutMs?: number): Promise<void> {
        await this.writeSetting("setting.speedKnobAsLimit", { value }, timeoutMs);
    }

    async setLatencyCompensation(value: boolean, timeoutMs?: number): Promise<void> {
        await this.writeSetting("setting.latencyCompensation", { value }, timeoutMs);
    }

    async setDisplayMetric(value: boolean, timeoutMs?: number): Promise<void> {
        await this.writeSetting("setting.displayMetric", { value }, timeoutMs);
    }

    async setAfterHomingPosition(value: number, timeoutMs?: number): Promise<void> {
        await this.writeSetting("setting.afterHomingPosition", { value }, timeoutMs);
    }

    async setMqttPublishFrequency(value: number, timeoutMs?: number): Promise<void> {
        await this.writeSetting("setting.mqttPublishFrequency", { value }, timeoutMs);
    }

    async setSpeedBle(value: number, timeoutMs?: number): Promise<void> {
        await this.writeSetting("motion.speedBle", { value }, timeoutMs);
    }

    // override async setDeviceName(name: string, timeoutMs?: number): Promise<void> {
    //     await this.writeSetting("setting.deviceName", { value: name }, timeoutMs);
    // }

    /**
     * Sets the active pattern for the StrokeEngine
     * @param patternIdx The index of the pattern to set. See {@link}
     */
    async setPattern(patternIdx: number, timeoutMs?: number): Promise<void> {
        await this.writeSetting("motion.pattern", { value: patternIdx }, timeoutMs);
    }

    /** @param value The speed value between 0 and 100 */
    async setSpeed(value: number, timeoutMs?: number): Promise<void> {
        await this.writeSetting("motion.speed", { value }, timeoutMs, true);
    }

    /** @param value The stroke length value between 0 and 100 */
    async setStroke(value: number, timeoutMs?: number): Promise<void> {
        await this.writeSetting("motion.stroke", { value }, timeoutMs);
    }

    /** @param value The depth value between 0 and 100 */
    async setDepth(value: number, timeoutMs?: number): Promise<void> {
        await this.writeSetting("motion.depth", { value }, timeoutMs);
    }

    /** @param value The sensation value between 0 and 100 */
    async setSensation(value: number, timeoutMs?: number): Promise<void> {
        await this.writeSetting("motion.sensation", { value }, timeoutMs);
    }

    /** @param value The buffer value between 0 and 100 */
    async setBuffer(value: number, timeoutMs?: number): Promise<void> {
        await this.writeSetting("motion.buffer", { value }, timeoutMs);
    }
    // #endregion

    // #region [input|event].emit
    // https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L431

    async #emitEvent(path: string, args?: Record<string, unknown>, timeoutMs?: number, isPriority?: boolean): Promise<void> {
        this._requireLease();
        await this.send({ op: "event.emit", path, args }, this.lease!, timeoutMs, isPriority);
    }

    async emitButtonEvent(clickType: OssmSchema.OssmButtonClickType, timeoutMs?: number): Promise<void> {
        await this.#emitEvent("button.enter", { event: clickType }, timeoutMs, true);
    }

    async emitReturnToMenuEvent(timeoutMs?: number): Promise<void> {
        await this.#emitEvent("event.returnToMenu", undefined, timeoutMs, true);
    }

    async emitDoneEvent(timeoutMs?: number): Promise<void> {
        await this.#emitEvent("event.done", undefined, timeoutMs);
    }

    async emitErrorEvent(timeoutMs?: number): Promise<void> {
        await this.#emitEvent("event.error", undefined, timeoutMs, true);
    }

    async emitGoHomeEvent(timeoutMs?: number): Promise<void> {
        await this.#emitEvent("event.home", undefined, timeoutMs, true);
    }

    async emitEmergencyStopEvent(timeoutMs?: number): Promise<void> {
        await this.#emitEvent("event.emergencyStop", undefined, timeoutMs, true);
    }

    async emitUpdateUnavailableEvent(timeoutMs?: number): Promise<void> {
        await this.#emitEvent("event.updateUnavailable", undefined, timeoutMs);
    }
    // #endregion

    // #region target.set
    // https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L465

    async navigateTo(menu: OssmSchema.OssmMenu, timeoutMs?: number): Promise<void> {
        this._requireLease();
        const result = await this.send<{ deferred?: true }>({ op: "target.set", path: `target.${menu}` }, this.lease!, timeoutMs, true);
        // TODO: If the task is deferred figure out how to wait for it to complete
    }

    /** Runs the calibration task on the machine */
    async homeRail(timeoutMs?: number): Promise<void> {
        this._requireLease();
        this.send({ op: "target.set", path: "target.home" }, this.lease!, timeoutMs, true);
    }

    /**
     * Emergency stops the device
     * @note This aborts all other pending and processing API calls
     */
    async emergencyStop(timeoutMs?: number): Promise<void> {
        this._requireLease(); // I find it kinda stupid how this command requires a lease lol
        // Clear the queue for this call since it is a safety function and we shouldn't wait on other tasks to complete, even if we prepend this task to the queue
        this._taskQueue.clearQueue();
        // Set the isPriority parameter to true to guarantee that this function is called next
        this.send({ op: "target.set", path: "target.emergencyStop" }, this.lease!, timeoutMs, true);
    }

    /**
     * @param position The new target position to move to
     * @param durationMs The time in milliseconds it takes to transition to the new position
     * @note Requires the device to be in {@link OssmSchema.OssmMenu.Streaming} mode
     */
    async streamPosition(position: number, durationMs: number, timeoutMs?: number): Promise<void> {
        this._requireLease();
        this.send({
            op: "target.set",
            path: "motion.position",
            args: {
                value: position,
                durationMs
            }
        }, this.lease!, timeoutMs, true);
    }
    // #endregion

    // #region encoder.[set|delta]
    // https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L530

    /**
     * Writes a value to the encoder
     * @param value The value to write to the encoder
     * @param isAbsolute When 'true' the value is written as-is to the encoder. When 'false' the value is added to the current encoder value
     */
    async encoderWrite(value: number, isAbsolute: boolean, timeoutMs?: number) {
        this._requireLease();
        await this.send({
            op: isAbsolute ? "encoder.set" : "encoder.delta",
            path: "encoder.main",
            args: isAbsolute ? { value } : { delta: value }
        }, undefined, timeoutMs);
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
    async setLed(r: number, g: number, b: number, timeoutMs?: number): Promise<void> {
        this._requireLease();
        // Range validation will be left to the firmware
        await this.send({ op: "indicator.set", path: "indicator.status", args: { r, g, b } }, this.lease!, timeoutMs);
    }
    // #endregion

    // #region Surface streaming
    override async startStream(
        surface: OssmSchema.OssmSurface,
        rateHz?: number,
        timeoutMs?: number
    ): Promise<RadSchema.RadStreamResult> {
        // Only map if 'surface' is a valid key in OSSM_SURFACE_STREAM_MAP (super calls out to this so we can't blindly get the key from the map)
        const streamTarget = surface in OSSM_SURFACE_STREAM_MAP
            ? OSSM_SURFACE_STREAM_MAP[surface as OssmSchema.OssmSurface]
            : surface;
        return super.startStream(streamTarget, rateHz, timeoutMs);
    }

    override async updateStream(rateHz?: number, timeoutMs?: number): Promise<RadSchema.RadStreamResult>;
    override async updateStream(surface?: OssmSchema.OssmSurface, rateHz?: number, timeoutMs?: number): Promise<RadSchema.RadStreamResult>;
    override async updateStream(
        surfaceOrRateHz?: OssmSchema.OssmSurface | number,
        rateHzOrTimeoutMs?: number,
        timeoutMs?: number
    ): Promise<RadSchema.RadStreamResult> {
        let path: string | undefined;
        let rateHz: number | undefined;
        let timeout: number | undefined;

        if (typeof surfaceOrRateHz === "number") {
            // Called as updateStream(rateHz, timeoutMs)
            path = undefined;
            rateHz = surfaceOrRateHz;
            timeout = rateHzOrTimeoutMs;
        } else if (surfaceOrRateHz !== undefined) {
            // Called as updateStream(surface, rateHz, timeoutMs)
            path = surfaceOrRateHz in OSSM_SURFACE_STREAM_MAP
                ? OSSM_SURFACE_STREAM_MAP[surfaceOrRateHz as OssmSchema.OssmSurface]
                : surfaceOrRateHz;
            rateHz = rateHzOrTimeoutMs;
            timeout = timeoutMs;
        } else {
            // Called as updateStream()
            path = undefined;
            rateHz = rateHzOrTimeoutMs;
            timeout = timeoutMs;
        }

        return super.updateStream(path, rateHz, timeout);
    }

    async #onStream(t: RadTelemetry): Promise<void> {
        const streamTelemetry = t as RadSchema.RadStream;
        if (!streamTelemetry.surface || !(streamTelemetry.surface in OSSM_SURFACE_STREAM_MAP)) return;
        (this.#onSurface[streamTelemetry.surface as OssmSchema.OssmSurface] as SingleEventSource<[any]>).dispatch(streamTelemetry.data);
    }
    // #endregion
}
