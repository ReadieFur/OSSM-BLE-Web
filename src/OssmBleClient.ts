import { RadApiBaseParams, RadBleApi, RadTelemetry } from "./RadBleApi";
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

export type OssmCommonPlayParameters = Pick<OssmSchema.OssmMotionSnapshot,
    "speed"
    | "stroke"
    | "depth"
    | "sensation"
    | "pattern"
>;

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
    override async getStateSnapshot(params: RadApiBaseParams = {}): Promise<OssmSchema.OssmStateSnapshot> {
        const snapshot = await super.getStateSnapshot(params);
        // this.#onSurface[RadSchema.RadSurface.State].dispatch(snapshot);
        return snapshot;
    }

    override async getEssentialSnapshot(params: RadApiBaseParams = {}): Promise<OssmSchema.OssmEssentialSnapshot> {
        const snapshot = await super.getEssentialSnapshot(params) as any as OssmSchema.OssmEssentialSnapshot;
        this.#onSurface[RadSchema.RadSurface.Essential].dispatch(snapshot);
        return snapshot;
    }

    override async getConnectivitySnapshot(params: RadApiBaseParams = {}): Promise<OssmSchema.OssmConnectivitySnapshot> {
        const snapshot = await super.getConnectivitySnapshot(params) as any as OssmSchema.OssmConnectivitySnapshot;
        this.#onSurface[RadSchema.RadSurface.Connectivity].dispatch(snapshot);
        return snapshot;
    }

    async getButtonSnapshot(params: RadApiBaseParams = {}): Promise<OssmSchema.OssmButtonSnapshot> {
        const snapshot = await this.getSnapshot<OssmSchema.OssmButtonSnapshot>({ ...params, path: OSSM_SURFACE_STREAM_MAP[RadSchema.RadSurface.Button] });
        this.#onSurface[RadSchema.RadSurface.Button].dispatch(snapshot);
        return snapshot;
    }

    async getEncoderSnapshot(params: RadApiBaseParams = {}): Promise<OssmSchema.OssmEncoderSnapshot> {
        const snapshot = await this.getSnapshot<OssmSchema.OssmEncoderSnapshot>({ ...params, path: OSSM_SURFACE_STREAM_MAP[RadSchema.RadSurface.Encoder] });
        this.#onSurface[RadSchema.RadSurface.Encoder].dispatch(snapshot);
        return snapshot;
    }

    async getAnalogSnapshot(params: RadApiBaseParams = {}): Promise<OssmSchema.OssmAnalogSnapshot> {
        const snapshot = await this.getSnapshot<OssmSchema.OssmAnalogSnapshot>({ ...params, path: OSSM_SURFACE_STREAM_MAP[RadSchema.RadSurface.Analog] });
        this.#onSurface[RadSchema.RadSurface.Analog].dispatch(snapshot);
        return snapshot;
    }

    async getMotionSnapshot(params: RadApiBaseParams = {}): Promise<OssmSchema.OssmMotionSnapshot> {
        const snapshot = await this.getSnapshot<OssmSchema.OssmMotionSnapshot>({ ...params, path: OSSM_SURFACE_STREAM_MAP[RadSchema.RadSurface.Motion] });
        this.#onSurface[RadSchema.RadSurface.Motion].dispatch(snapshot);
        return snapshot;
    }
    // #endregion

    // #region setting.read
    // https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L239

    async getSpeed(params: RadApiBaseParams = {}): Promise<number> {
        return (await this.readSetting<OssmSchema.OssmReadResult<number>>({ ...params, path: "motion.speed", isPriority: true })).value;
    }

    async getStroke(params: RadApiBaseParams = {}): Promise<number> {
        return (await this.readSetting<OssmSchema.OssmReadResult<number>>({ ...params, path: "motion.stroke" })).value;
    }

    async getDepth(params: RadApiBaseParams = {}): Promise<number> {
        return (await this.readSetting<OssmSchema.OssmReadResult<number>>({ ...params, path: "motion.depth" })).value;
    }

    /**
     * Gets the 'sensation' setting which is often used as an arbitrary parameter value for the set StrokeEngine pattern
     */
    async getSensation(params: RadApiBaseParams = {}): Promise<number> {
        return (await this.readSetting<OssmSchema.OssmReadResult<number>>({ ...params, path: "motion.sensation" })).value;
    }

    async getBuffer(params: RadApiBaseParams = {}): Promise<number> {
        return (await this.readSetting<OssmSchema.OssmReadResult<number>>({ ...params, path: "motion.buffer" })).value;
    }

    /**
     * Gets the current active pattern idx for the StrokeEngine
     */
    async getActivePatternIndex(params: RadApiBaseParams = {}): Promise<number> {
        return (await this.readSetting<OssmSchema.OssmReadResult<number>>({ ...params, path: "motion.pattern" })).value;
    }

    async getSpeedBle(params: RadApiBaseParams = {}): Promise<number> {
        // I believe this gets the 'simulated' ble speed for when the speed knob limit is enabled?
        return (await this.readSetting<OssmSchema.OssmReadResult<number>>({ ...params, path: "motion.speedBle" })).value;
    }

    async isSpeedKnobAsLimit(params: RadApiBaseParams = {}): Promise<boolean> {
        return (await this.readSetting<OssmSchema.OssmReadResult<boolean>>({ ...params, path: "setting.speedKnobAsLimit" })).value;
    }

    async getLatencyCompensation(params: RadApiBaseParams = {}): Promise<number> {
        return (await this.readSetting<OssmSchema.OssmReadResult<number>>({ ...params, path: "setting.latencyCompensation" })).value;
    }

    async getDisplayMetric(params: RadApiBaseParams = {}): Promise<string> {
        return (await this.readSetting<OssmSchema.OssmReadResult<string>>({ ...params, path: "setting.displayMetric" })).value;
    }

    async getAfterHomingPosition(params: RadApiBaseParams = {}): Promise<number> {
        return (await this.readSetting<OssmSchema.OssmReadResult<number>>({ ...params, path: "setting.afterHomingPosition" })).value;
    }

    async getMqttPublishFrequency(params: RadApiBaseParams = {}): Promise<number> {
        return (await this.readSetting<OssmSchema.OssmReadResult<number>>({ ...params, path: "setting.mqttPublishFrequency" })).value;
    }

    override async getDeviceName(params: RadApiBaseParams = {}): Promise<string> {
        return (await this.readSetting<OssmSchema.OssmReadResult<string>>({ ...params, path: "setting.deviceName" })).value;
    }

    async getFirmwareProvenance(params: RadApiBaseParams = {}) {
        const result = await this.readSetting<{ path: string } & OssmSchema.OssmFirmwareProvenance>({ ...params, path: "device.firmwareProvenance" });
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
    getSpeedKnob(raw: boolean): Promise<number>;
    getSpeedKnob(params: RadApiBaseParams & { raw: boolean }): Promise<number>;
    async getSpeedKnob(arg: RadApiBaseParams & { raw: boolean } | boolean = { raw: false }): Promise<number> {
        /* https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L245
         * https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/board.cpp#L22
         * The OSSM firmware returns the raw sensor value via analogRead and uses a resolution of 12 (0-4096)
         * A percentage value between 0 and 100 is returned if the percent property is requested instead
         */
        const opts = this._singleArg(arg, "raw");
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>({ ...opts, path: opts.raw ? "analog.speedKnob" : "analog.speedKnobPercent" })).value;
    }

    /**
     * @param unfiltered If true, returns the unfiltered sensor value, otherwise returns the calibrated sensor value
     * @returns The current motor current as a raw value (0-4096)
     */
    getMotorCurrent(unfiltered: boolean): Promise<number>;
    getMotorCurrent(params: RadApiBaseParams & { unfiltered: boolean }): Promise<number>;
    async getMotorCurrent(arg: RadApiBaseParams & { unfiltered: boolean } | boolean = { unfiltered: false }): Promise<number> {
        const opts = this._singleArg(arg, "unfiltered");
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>({ ...opts, path: opts.unfiltered ? "analog.motorCurrent" : "analog.motorCurrentFiltered" })).value;
    }

    async isHomed(params: RadApiBaseParams = {}): Promise<boolean> {
        return (await this.readSensor<OssmSchema.OssmReadResult<boolean>>({ ...params, path: "motion.homed" })).value;
    }

    /**
     * @returns The current position millimeters
     */
    async getPosition(params: RadApiBaseParams = {}): Promise<number> {
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>({ ...params, path: "motion.position", isPriority: true })).value;
    }

    async getMotorCurrentOffset(params: RadApiBaseParams = {}): Promise<number> {
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>({ ...params, path: "analog.currentOffset" })).value;
    }

    /**
     * @returns The measured stroke length in millimeters
     */
    async getMeasuredStroke(params: RadApiBaseParams = {}): Promise<number> {
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>({ ...params, path: "motion.measuredStroke" })).value;
    }

    /**
     * @returns The target position in millimeters
     */
    async getTargetPosition(params: RadApiBaseParams = {}): Promise<number> {
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>({ ...params, path: "motion.targetPosition" })).value;
    }

    async getTargetTime(params: RadApiBaseParams = {}): Promise<number> {
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>({ ...params, path: "motion.targetTime" })).value;
    }

    async getStrokeCount(params: RadApiBaseParams = {}): Promise<number> {
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>({ ...params, path: "session.strokeCount" })).value;
    }

    /**
     * @returns The total distance traveled in meters for the current session
     */
    async getDistance(params: RadApiBaseParams = {}): Promise<number> {
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>({ ...params, path: "session.distance" })).value;
    }

    async isEmergencyStopEngaged(params: RadApiBaseParams = {}): Promise<boolean> {
        return (await this.readSensor<OssmSchema.OssmReadResult<boolean>>({ ...params, path: "button.emergencyStop" })).value;
    }

    async isLimitSwitchEngaged(params: RadApiBaseParams = {}): Promise<boolean> {
        return (await this.readSensor<OssmSchema.OssmReadResult<boolean>>({ ...params, path: "switch.limit" })).value;
    }

    /**
     * Reads the state of a GPIO pin
     * @param pin The GPIO pin number to read (0-4)
     * @returns The analogRead value of the pin (0-4096)
     */
    readGpioPin(pin: number): Promise<boolean>;
    readGpioPin(params: RadApiBaseParams & { pin: number }): Promise<boolean>;
    async readGpioPin(arg: RadApiBaseParams & { pin: number } | number): Promise<boolean> {
        const opts = this._singleArg(arg, "pin");
        this.#enforceRange(opts.pin, 0, 4, "Invalid GPIO pin number");
        return (await this.readSensor<OssmSchema.OssmReadResult<boolean>>({ ...opts, path: `analog.expansion${opts.pin}` })).value;
    }

    async isEnterButtonPressed(params: RadApiBaseParams = {}): Promise<boolean> {
        return (await this.readSensor<OssmSchema.OssmReadResult<boolean>>({ ...params, path: "button.enter" })).value;
    }

    /**
     * @returns The position of the motors rotary encoder
     */
    async getEncoderPosition(params: RadApiBaseParams = {}): Promise<number> {
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>({ ...params, path: "encoder.position" })).value;
    }

    async getBleConnectionCount(params: RadApiBaseParams = {}): Promise<number> {
        return (await this.readSensor<OssmSchema.OssmReadResult<number>>({ ...params, path: "connectivity.bleConnections" })).value;
    }

    async getWifiStatus(params: RadApiBaseParams = {}): Promise<OssmSchema.OssmWifiStatus> {
        const readResult = await this.readSensor<{ path: string } & OssmSchema.OssmWifiStatus>({ ...params, path: "connectivity.wifi" });
        // Remove the path property from the result before returning
        const { path, ...wifiStatus } = readResult;
        return wifiStatus;
    }
    // #endregion

    // #region setting.write
    // https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L309
    async setGpioPin(params: RadApiBaseParams & { pin: number, mode: OssmSchema.OssmGpioPinMode, value: boolean }): Promise<void> {
        this.#enforceRange(params.pin, 0, 4, "Invalid GPIO pin number");
        await this.writeSetting({
            ...params,
            path: `analog.expansion${params.pin}`,
            args: {
                mode: params.mode,
                value: params.value
            }
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
    setSpeedKnobAsLimit(speedKnobAsLimit: boolean): Promise<void>;
    setSpeedKnobAsLimit(params: RadApiBaseParams & { value: boolean }): Promise<void>;
    async setSpeedKnobAsLimit(arg: RadApiBaseParams & { value: boolean } | boolean): Promise<void> {
        const opts = this._singleArg(arg, "value");
        await this.writeSetting({ ...opts, path: "setting.speedKnobAsLimit", args: { value: opts.value } });
    }

    setLatencyCompensation(enabled: boolean): Promise<void>;
    setLatencyCompensation(params: RadApiBaseParams & { value: boolean }): Promise<void>;
    async setLatencyCompensation(arg: RadApiBaseParams & { value: boolean } | boolean): Promise<void> {
        const opts = this._singleArg(arg, "value");
        await this.writeSetting({ ...opts, path: "setting.latencyCompensation", args: { value: opts.value }});
    }

    setDisplayMetrics(enabled: boolean): Promise<void>;
    setDisplayMetrics(params: RadApiBaseParams & { value: boolean }): Promise<void>;
    async setDisplayMetrics(arg: RadApiBaseParams & { value: boolean } | boolean): Promise<void> {
        const opts = this._singleArg(arg, "value");
        await this.writeSetting({ ...opts, path: "setting.displayMetric", args: { value: opts.value }});
    }

    setAfterHomingPosition(position: number): Promise<void>;
    setAfterHomingPosition(params: RadApiBaseParams & { value: number }): Promise<void>;
    async setAfterHomingPosition(arg: RadApiBaseParams & { value: number } | number): Promise<void> {
        const opts = this._singleArg(arg, "value");
        this.#enforceRange(opts.value, 0, 100, "Value must be between 0 and 100");
        await this.writeSetting({ ...opts, path: "setting.afterHomingPosition", args: { value: opts.value }});
    }

    setMqttPublishFrequency(frequencyHz: number): Promise<void>;
    setMqttPublishFrequency(params: RadApiBaseParams & { value: number }): Promise<void>;
    async setMqttPublishFrequency(arg: RadApiBaseParams & { value: number } | number): Promise<void> {
        const opts = this._singleArg(arg, "value");
        this.#enforceRange(opts.value, 0, 100, "Value must be between 0 and 100");
        await this.writeSetting({ ...opts, path: "setting.mqttPublishFrequency", args: { value: opts.value }});
    }

    setSpeedBle(bleSpeed: number): Promise<void>;
    setSpeedBle(params: RadApiBaseParams & { value: number }): Promise<void>;
    async setSpeedBle(arg: RadApiBaseParams & { value: number } | number): Promise<void> {
        const opts = this._singleArg(arg, "value");
        this.#enforceRange(opts.value, 0, 100, "Value must be between 0 and 100");
        await this.writeSetting({ ...opts, path: "motion.speedBle", args: { value: opts.value }});
    }

    // override async setDeviceName(name: string, timeoutMs?: number): Promise<void> {
    //     await this.writeSetting({ ...params, path: "setting.deviceName", { value: name }, timeoutMs);
    // }

    /**
     * Sets the active pattern for the StrokeEngine
     * @param patternIdx The index of the pattern to set. See {@link}
     */
    setPattern(patternIdx: number): Promise<void>;
    setPattern(params: RadApiBaseParams & { patternIdx: number }): Promise<void>;
    async setPattern(arg: RadApiBaseParams & { patternIdx: number } | number): Promise<void> {
        const opts = this._singleArg(arg, "patternIdx");
        this.#enforceRange(opts.patternIdx, 0, Number.MAX_SAFE_INTEGER, "Pattern index must be positive");
        await this.writeSetting({ ...opts, path: "motion.pattern", args: { value: opts.patternIdx }});
    }

    /** @param value The speed value between 0 and 100 */
    setSpeed(speed: number): Promise<void>;
    setSpeed(params: RadApiBaseParams & { value: number }): Promise<void>;
    async setSpeed(arg: RadApiBaseParams & { value: number } | number): Promise<void> {
        const opts = this._singleArg(arg, "value");
        this.#enforceRange(opts.value, 0, 100, "Value must be between 0 and 100");
        await this.writeSetting({ ...opts, path: "motion.speed", args: { value: opts.value }, isPriority: true });
    }

    /** @param value The stroke length value between 0 and 100 */
    setStroke(stroke: number): Promise<void>;
    setStroke(params: RadApiBaseParams & { value: number }): Promise<void>;
    async setStroke(arg: RadApiBaseParams & { value: number } | number): Promise<void> {
        const opts = this._singleArg(arg, "value");
        this.#enforceRange(opts.value, 0, 100, "Value must be between 0 and 100");
        await this.writeSetting({ ...opts, path: "motion.stroke", args: { value: opts.value }});
    }

    /** @param value The depth value between 0 and 100 */
    setDepth(depth: number): Promise<void>;
    setDepth(params: RadApiBaseParams & { value: number }): Promise<void>;
    async setDepth(arg: RadApiBaseParams & { value: number } | number): Promise<void> {
        const opts = this._singleArg(arg, "value");
        this.#enforceRange(opts.value, 0, 100, "Value must be between 0 and 100");
        await this.writeSetting({ ...opts, path: "motion.depth", args: { value: opts.value }});
    }

    /** @param value The sensation value between 0 and 100 */
    setSensation(sensation: number): Promise<void>;
    setSensation(params: RadApiBaseParams & { value: number }): Promise<void>;
    async setSensation(arg: RadApiBaseParams & { value: number } | number): Promise<void> {
        const opts = this._singleArg(arg, "value");
        this.#enforceRange(opts.value, 0, 100, "Value must be between 0 and 100");
        await this.writeSetting({ ...opts, path: "motion.sensation", args: { value: opts.value }});
    }

    /** @param value The buffer value between 0 and 100 */
    setBuffer(buffer: number): Promise<void>;
    setBuffer(params: RadApiBaseParams & { value: number }): Promise<void>;
    async setBuffer(arg: RadApiBaseParams & { value: number } | number): Promise<void> {
        const opts = this._singleArg(arg, "value");
        await this.writeSetting({ ...opts, path: "motion.buffer", args: { value: opts.value }});
    }
    // #endregion

    // #region [input|event].emit
    // https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L431

    async #emitEvent(params: RadApiBaseParams & { path: string, args?: Record<string, unknown> }): Promise<void> {
        await this.send({ ...params, req: { op: "event.emit", path: params.path, args: params.args }, lease: this._requireLease() });
    }

    emitButtonEvent(clickType: OssmSchema.OssmButtonClickType): Promise<void>;
    emitButtonEvent(params: RadApiBaseParams & { clickType: OssmSchema.OssmButtonClickType }): Promise<void>;
    async emitButtonEvent(arg: RadApiBaseParams & { clickType: OssmSchema.OssmButtonClickType } | OssmSchema.OssmButtonClickType): Promise<void> {
        const opts = this._singleArg(arg, "clickType");
        await this.#emitEvent({ ...opts, path: "button.enter", args: { event: opts.clickType }});
    }

    async emitReturnToMenuEvent(params: RadApiBaseParams = {}): Promise<void> {
        await this.#emitEvent({ ...params, path: "event.returnToMenu", isPriority: true });
    }

    async emitDoneEvent(params: RadApiBaseParams = {}): Promise<void> {
        await this.#emitEvent({ ...params, path: "event.done" });
    }

    async emitErrorEvent(params: RadApiBaseParams = {}): Promise<void> {
        await this.#emitEvent({ ...params, path: "event.error", isPriority: true });
    }

    async emitGoHomeEvent(params: RadApiBaseParams = {}): Promise<void> {
        await this.#emitEvent({ ...params, path: "event.home", isPriority: true });
    }

    async emitEmergencyStopEvent(params: RadApiBaseParams = {}): Promise<void> {
        await this.#emitEvent({ ...params, path: "event.emergencyStop", isPriority: true });
    }

    async emitUpdateUnavailableEvent(params: RadApiBaseParams = {}): Promise<void> {
        await this.#emitEvent({ ...params, path: "event.updateUnavailable", isPriority: true });
    }
    // #endregion

    // #region target.set
    // https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L465

    navigateTo(menu: OssmSchema.OssmMenu): Promise<void>;
    navigateTo(params: RadApiBaseParams & { menu: OssmSchema.OssmMenu }): Promise<void>;
    async navigateTo(arg: RadApiBaseParams & { menu: OssmSchema.OssmMenu } | OssmSchema.OssmMenu): Promise<void> {
        const opts = this._singleArg(arg, "menu");
        const result = await this.send<{ deferred?: true }>({
            ...opts,
            req: {
                op: "target.set",
                path: `target.${opts.menu}`
            },
            lease: this._requireLease(),
            isPriority: true
        });
        // TODO: If the task is deferred figure out how to wait for it to complete
    }

    /** Runs the calibration task on the machine */
    async homeRail(params: RadApiBaseParams = {}): Promise<void> {
        await this.send({
            ...params,
            req: {
                op: "target.set",
                path: "target.home"
            },
            lease: this._requireLease(),
            isPriority: true
        });
    }

    /**
     * Emergency stops the device
     * @note This aborts all other pending and processing API calls
     */
    async emergencyStop(params: RadApiBaseParams = {}): Promise<void> {
        // I find it kinda stupid how this command requires a lease lol
        // Clear the queue for this call since it is a safety function and we shouldn't wait on other tasks to complete, even if we prepend this task to the queue
        this._taskQueue.clearQueue();
        // Set the isPriority parameter to true to guarantee that this function is called next
        await this.send({
            ...params,
            req: {
                op: "target.set",
                path: "target.emergencyStop"
            },
            lease: this._requireLease(),
            isPriority: true
        });
    }

    /**
     * @param position The new target position to move to
     * @param durationMs The time in milliseconds it takes to transition to the new position
     * @note Requires the device to be in {@link OssmSchema.OssmMenu.Streaming} mode  
     * *It is also recommended to set the stroke, depth, speed & sensation values to 100 in order to get a more "absolute" positioning mode*
     */
    async streamPosition(params: RadApiBaseParams & { position: number, durationMs: number }): Promise<void> {
        await this.send({
            ...params,
            req: {
                op: "target.set",
                path: "motion.position",
                args: {
                    value: params.position,
                    durationMs: params.durationMs
                }
            },
            lease: this._requireLease(),
            isPriority: true
        });
    }
    // #endregion

    // #region encoder.[set|delta]
    // https://github.com/KinkyMakers/OSSM-hardware/blob/b7f01bf6df1be6f3ebf17dc0e31ed64ddf4c15b7/Software/src/services/communication/rad_ble.cpp#L530

    /**
     * Writes a value to the encoder
     * @param value The value to write to the encoder
     * @param isAbsolute When 'true' the value is written as-is to the encoder. When 'false' the value is added to the current encoder value
     */
    async encoderWrite(params: RadApiBaseParams & { value: number, isAbsolute: boolean }) {
        await this.send({
            ...params,
            req: {
                op: params.isAbsolute ? "encoder.set" : "encoder.delta",
                path: "encoder.main",
                args: params.isAbsolute ? { value: params.value } : { delta: params.value }
            },
            lease: this._requireLease()
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
    async setLed(params: RadApiBaseParams & { r: number, g: number, b: number }): Promise<void> {
        // Range validation will be left to the firmware
        this.#enforceRange(params.r, 0, 255, "Red value must be between 0 and 255");
        this.#enforceRange(params.g, 0, 255, "Green value must be between 0 and 255");
        this.#enforceRange(params.b, 0, 255, "Blue value must be between 0 and 255");
        await this.send({
            ...params,
            req: {
                op: "indicator.set",
                path: "indicator.status",
                args: {
                    r: params.r,
                    g: params.g,
                    b: params.b
                }
            },
            lease: this._requireLease()
        });
    }
    // #endregion

    // #region Surface streaming
    /**
     * Starts a stream for a given surface from the device
     * @param surface Surface to stream
     * @param rateHz Rate in Hz to stream at. If omitted, the device will use its default rate for the stream
     * @requires A valid lease token
     */
    async startStream(params: RadApiBaseParams & { surface: OssmSchema.OssmSurface, rateHz?: number }): Promise<RadSchema.RadStreamResult>;
    /** @deprecated Use one of the `surface` overload instead */
    async startStream(params: RadApiBaseParams & { path: string, rateHz?: number }): Promise<RadSchema.RadStreamResult>;
    /** @deprecated Use one of the `surface` overload instead */
    override async startStream(params: RadApiBaseParams & { path: string, surface: OssmSchema.OssmSurface, rateHz?: number }): Promise<RadSchema.RadStreamResult> {
        return super.startStream({
            ...params,
            // Overload jank fix. Only map if 'surface' is a valid key in OSSM_SURFACE_STREAM_MAP (super calls out to this so we can't blindly get the key from the map)
            path: params.path ?? OSSM_SURFACE_STREAM_MAP[params.surface as OssmSchema.OssmSurface]
        });
    }

    // God I don't like how overloads work in JS
    async updateStream(params: RadApiBaseParams & { surface?: OssmSchema.OssmSurface, rateHz?: number }): Promise<RadSchema.RadStreamResult>;
    /** @deprecated Use one of the `surface` overload instead */
    async updateStream(params: RadApiBaseParams & { path: string, rateHz?: number }): Promise<RadSchema.RadStreamResult>;
    /** @deprecated Use one of the `surface` overload instead */
    override async updateStream(params: RadApiBaseParams & { path: string, surface?: OssmSchema.OssmSurface, rateHz?: number }): Promise<RadSchema.RadStreamResult> {
        if (!params.path && !params.surface && !params.rateHz)
            throw new DOMException("Either surface or rateHz must be provided", "SyntaxError");
        return super.updateStream({
            ...params,
            // Overload jank fix. Only map if 'surface' is a valid key in OSSM_SURFACE_STREAM_MAP (super calls out to this so we can't blindly get the key from the map)
            path: params.path ?? OSSM_SURFACE_STREAM_MAP[params.surface as OssmSchema.OssmSurface]
        });
    }

    async #onStream(t: RadTelemetry): Promise<void> {
        const streamTelemetry = t as RadSchema.RadStream;
        if (!streamTelemetry.surface || !(streamTelemetry.surface in OSSM_SURFACE_STREAM_MAP)) return;
        (this.#onSurface[streamTelemetry.surface as OssmSchema.OssmSurface] as SingleEventSource<[any]>).dispatch(streamTelemetry.data);
    }
    // #endregion

    // #region Helpers
    /**
     * Helper function to apply common stroke engine parameters in an order that aims to be safer and reduce jerkiness
     * @param newParams A partial object of the new values to set
     * @param oldState The old state to compare to determine the safe order to apply the new parameters.
     * @requires A valid lease
     */
    async setCommonPlayParameters(params: RadApiBaseParams & {
        newState: Partial<OssmCommonPlayParameters>
        oldState?: Partial<OssmCommonPlayParameters>
    }): Promise<void> {
        // Based on old code from: https://github.com/ReadieFur/OSSM-BLE-Web/blob/8779560bce4cade1eedafa5acd9140db0bc305a0/src/ossmBle.ts#L740-L810

        if (!params.oldState) params.oldState = {};

        // I decided to not fetch the current state from the device or cache here since it adds too much delay

        const shouldWritePattern = params.newState.pattern !== undefined && params.newState.pattern !== params.oldState.pattern;
        const shouldWriteSpeed = params.newState.speed !== undefined && params.newState.speed !== params.oldState.speed;
        const shouldWriteDepth = params.newState.depth !== undefined && params.newState.depth !== params.oldState.depth;
        const shouldWriteStroke = params.newState.stroke !== undefined && params.newState.stroke !== params.oldState.stroke;
        const shouldWriteSensation = params.newState.sensation !== undefined && params.newState.sensation !== params.oldState.sensation;

        // Fast exit if no parameters changed
        if (!shouldWritePattern && !shouldWriteSpeed && !shouldWriteDepth && !shouldWriteStroke && !shouldWriteSensation)
            return;

        // Synthesize worst-case effective old values for missing parameters (0 = conservative baseline)
        const effectiveOldSpeed = params.oldState.speed ?? 0;
        const effectiveOldDepth = params.oldState.depth ?? 0;
        const effectiveOldStroke = params.oldState.stroke ?? 0;

        const targetSpeed = params.newState.speed ?? effectiveOldSpeed;
        const targetDepth = params.newState.depth ?? effectiveOldDepth;
        const targetStroke = params.newState.stroke ?? effectiveOldStroke;

        const promises: Promise<unknown>[] = [];

        // Function delegates
        const applyPattern = () => {
            if (shouldWritePattern) promises.push(this.setPattern({ ...params, patternIdx: params.newState.pattern! }));
        };
        const applySpeed = () => {
            if (shouldWriteSpeed) promises.push(this.setSpeed({ ...params, value: params.newState.speed! }));
        };
        const applyDepthAndStroke = () => {
            if (shouldWriteDepth) promises.push(this.setDepth({ ...params, value: params.newState.depth! }));
            if (shouldWriteStroke) promises.push(this.setStroke({ ...params, value: params.newState.stroke! }));
        };
        const applySensation = () => {
            if (shouldWriteSensation) promises.push(this.setSensation({ ...params, value: params.newState.sensation! }));
        };

        // Calculate offsets used to determine the safe order to apply the changes
        const oldMin = effectiveOldDepth - effectiveOldStroke;
        const oldMax = effectiveOldDepth;
        const newMin = targetDepth - targetStroke;
        const newMax = targetDepth;
        const isDecreasingSpeed = targetSpeed < effectiveOldSpeed;
        const isExpandingRangeAtHigherSpeed = targetSpeed > effectiveOldSpeed && (newMin < oldMin || newMax > oldMax);

        applyPattern();
        if (isDecreasingSpeed) {
            // Safe case: Drop speed first, then apply motion range changes
            applySpeed();
            applyDepthAndStroke();
        } else if (isExpandingRangeAtHigherSpeed) {
            // Risky case: Expand motion range at current lower speed BEFORE accelerating
            applyDepthAndStroke();
            applySpeed();
        } else {
            // Neutral case
            applyDepthAndStroke();
            applySpeed();
        }
        applySensation();

        /* Use Promise.all here instead of awaiting on each call, the queue manager will send the requests in the order they are called
         * But this method won't wait for a response after each call, so the result is the device gets updated much faster
         * But still wait for all of them to complete before returning
         */
        await Promise.all(promises);
    }

    #enforceRange(value: number, min: number, max: number, errorStr?: string): void {
        if (value < min || value > max) throw new DOMException(errorStr, "IndexSizeError");
    }
    // #endregion
}
