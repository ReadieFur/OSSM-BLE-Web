/*
 * This module is for the OssmLite firmware
 * 
 * Since the OssmLite firmware uses rather simple and fast endpoints I have decided to go with mostly schema driven approach
 * Unlike the RadBleApi which has schema driven types and manual function definitions
 * This module uses the schema for 100% dynamically generated types and code at runtime
 * The setup is rather complex but it means adding in new properties is dead simple
 * Most of the configuration therefore is done in the LITE_BLE_SPEC below
 */

// #region Imports
import { BleConnectionHandler } from "../common/BleConnectionHandler";
import { CancellationToken, CancellationTokenSource, ICancellationToken } from "../common/CancellationToken";
import { enforceRange } from "../common/Helpers";
import * as OssmSchema from "../ossm/OssmProtocolSchema";
import { SingleEvent, SingleEventSource } from "../common/SingleEvent";
// #endregion

// #region Common codecs
type LiteCodec<T> = {
    enc: (v: T) => string;
    dec: (v: string) => T;
};

const LITE_CODECS = {
    number: (options?: { int?: boolean; min?: number; max?: number }): LiteCodec<number> => {
        const min = options?.min ?? Number.NEGATIVE_INFINITY;
        const max = options?.max ?? Number.POSITIVE_INFINITY;
        return {
            enc: (v: number) => {
                if (options?.min !== undefined || options?.max !== undefined)
                    enforceRange(v, min, max);
                return options?.int ? Math.trunc(v).toString() : v.toString();
            },
            dec: v => options?.int ? Number.parseInt(v) : Number.parseFloat(v)
        };
    },
    string: {
        enc: (v: string) => v,
        dec: v => v
    },
    boolean: {
        enc: (v: boolean) => v ? "true" : "false",
        dec: (v: string) => {
            const lower = v.trim().toLowerCase();
            if (["true", "1", "t"].includes(lower)) return true;
            if (["false", "0", "f"].includes(lower)) return false;
            throw new DOMException(`Invalid boolean value: "${v}"`, "SyntaxError");
        }
    }
} as const satisfies Record<string, LiteCodec<any> | ((...args: any[]) => LiteCodec<any>)>;
// #endregion

// #region BLE Specification
/*
 * Define all BLE characteristics here
 * If the characteristic has read/write properties and a set encoder/decoder then a dynamically generated method & type hints will be created for it
 * If the OssmLiteClientImpl class has a member who's name matches one of these characteristics then it will be overriden by the class impl
 * The characteristic keys must be unique here as they are union'd
 */

const LITE_UUID_COMMON_BASE_1 = "4f53534d-436f-6d6d-6f6e-";
const LITE_UUID_COMMON_BASE_2 = "4f53534d-506f-7369-7469-";
const LITE_UUID_COMMON_BASE_3 = "4f53534d-456e-6769-6e65-";
const LITE_UUID_CONFIG_BASE = "4f53534d-436f-6e66-6967-";
const LITE_UUID_AP_BASE = "4F53534D-6164-7661-6E63-";

// https://github.com/fray-d/OSSM-Lite/tree/e1ff45d8eafbf43e1d6b7f5f9a35a8277faa9b9b/Software/src/services/communication
const LITE_BLE_SPEC = {
    common: {
        serviceUuid: 0x055E,
        characteristics: {
            speed: { uuid: LITE_UUID_COMMON_BASE_1 + "005370656564", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.number({ min: 0, max: 100 }) },
            maxDepth: { uuid: LITE_UUID_COMMON_BASE_1 + "4d6178446570", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.number({ min: 0, max: 100 }) },
            minDepth: { uuid: LITE_UUID_COMMON_BASE_1 + "4d696e446570", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.number({ min: 0, max: 100 }) },
            streamInput: { uuid: LITE_UUID_COMMON_BASE_1 + "53747265616D", properties: ["read", "write", "writeWithoutResponse", "notify"],
                enc: (v: { position: number, duration: number }) => `${v.position}:${v.duration}`
                // omit decoder (disables getter), value is always "POS:MS" and never holds any real value
            },
            targetPosition: { uuid: LITE_UUID_COMMON_BASE_2 + "6f6e54617267", properties: ["read", "notify"], ...LITE_CODECS.number({ min: 0, max: 100 }) },
            currentPosition: { uuid: LITE_UUID_COMMON_BASE_2 + "6f6e63757272", properties: ["read", "notify"], ...LITE_CODECS.number({ min: 0, max: 100 }) },
            sensation: { uuid: LITE_UUID_COMMON_BASE_3 + "536174696f6e", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.number({ min: 0, max: 100 }) },
            pattern: { uuid: LITE_UUID_COMMON_BASE_3 + "50617465726e", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.number({ int: true, min: 0 }) },
            patternOptions: { uuid: LITE_UUID_COMMON_BASE_3 + "5061744c7374", properties: ["read", "write"] } // Not publicly exposed, see class impl of getPatterns
        }
    },
    config: {
        serviceUuid: 0x055C,
        characteristics: {
            wifiConfig: { uuid: LITE_UUID_CONFIG_BASE + "202057694669", properties: ["read", "write"],
                enc: (v: { ssid: string; password: string }) => `set:wifi:${v.ssid}|${v.password}`,
                dec: v => JSON.parse(v) as {
                    connected: boolean,
                    ssid?: string,
                    ip?: string,
                    rssi?: number
                }
            },
            deviceName: { uuid: LITE_UUID_CONFIG_BASE + "52656E616D65", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.string },
            homingType: { uuid: LITE_UUID_CONFIG_BASE + "486F6D696E67", properties: ["read", "write", "writeWithoutResponse", "notify"],
                enc: (v: LiteHomingType) => v.toString(), // Given this is using TS assume type safety, if JS is used and an invalid value is passed let the machine catch it
                dec: v => Number.parseInt(v, 10) as LiteHomingType
            },
            railLength: { uuid: LITE_UUID_CONFIG_BASE + "4C656E677468", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.number({ min: 0 }) },
            invertRailDirection: { uuid: LITE_UUID_CONFIG_BASE + "496E76657274", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.boolean },
            homeBetweenModes: { uuid: LITE_UUID_CONFIG_BASE + "5265486F6D65", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.boolean },
            gpio: { uuid: LITE_UUID_CONFIG_BASE + "20204750494F", properties: ["read", "write", "writeWithoutResponse", "notify"],
                enc: (v: { pin: number; high: boolean }) => {
                    enforceRange(v.pin, 1, 4, "Invalid pin number");
                    return `${v.pin}:${v.high ? '1' : '0'}`;
                },
                dec: v => v.match(/\[(.*?)\]/)?.[1].split(",").map(Number) ?? []
            },
            updateAndRestart: { uuid: LITE_UUID_CONFIG_BASE + "557064617465", properties: ["write", "writeWithoutResponse"] }, // Manual implementation inside class definition
            maxAcceleration: { uuid: LITE_UUID_CONFIG_BASE + "4d414343454c", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.number({ min: 0 }) },
            maxMotorRpm: { uuid: LITE_UUID_CONFIG_BASE + "4d415852504d", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.number({ min: 0 }) },
            stepsPerRevolution: { uuid: LITE_UUID_CONFIG_BASE + "535445505052", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.number({ min: 0 }) },
            pulleyTeeth: { uuid: LITE_UUID_CONFIG_BASE + "50554c4c4559", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.number({ min: 0 }) },
            beltPitch: { uuid: LITE_UUID_CONFIG_BASE + "425049544348", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.number({ min: 0 }) },
            currentSensorLimit: { uuid: LITE_UUID_CONFIG_BASE + "53656e736f72", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.number({ min: 0 }) }, // This has bound ranges in firmware but I don't want to hardcode limits in-case these bounds change (firmware bounds are 1.5 to 5.0)
            speedCurve: { uuid: LITE_UUID_CONFIG_BASE + "537064437276", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.number({ min: 0 }) }, // Firmware bounds are 0.5 to 1
            homingSpeed: { uuid: LITE_UUID_CONFIG_BASE + "537064486f6d", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.number({ min: 0 }) } // Firmware bounds are 10 to 40
        }
    },
    advancedPenetration: {
        serviceUuid: 0x055A,
        characteristics: {
            advancedPenetrationConfig: { uuid: LITE_UUID_AP_BASE + "656473746174", properties: ["read", "notify"],
                /* The currently loaded advanced config */
                dec: (v): LiteAPConfig => {
                    const parseField = (s: string): LiteAPControlEntry => {
                        const parts = s.split(":").map(Number);
                        return {
                            value: parts[0],
                            amplitude: parts[1], // In JS if the index is out of bounds on an array it just returns undefined which is fine for this object
                            inStep: parts[2],
                            inWait: parts[3],
                            outStep: parts[4],
                            outWait: parts[5],
                            offset: parts[6]
                        };
                    };
                    const fields = v.split(",")
                    return {
                        maxDepth: parseField(fields[0]),
                        minDepth: parseField(fields[1]),
                        inSpeed: parseField(fields[2]),
                        outSpeed: parseField(fields[3]),
                        inAcceleration: parseField(fields[4]),
                        outAcceleration: parseField(fields[5]),
                        speed: parseField(fields[6]),
                    };
                }
            },
            advancedControl: { uuid: LITE_UUID_AP_BASE + "6564636F6E74", properties: ["read", "write", "writeWithoutResponse"] }, // Implemented in class
            advancedPresets: { uuid: LITE_UUID_AP_BASE + "656470727374", properties: ["read", "write"] }, // Implemented in class
        }
    }
} as const satisfies LiteSpecSkeleton;

export const OSSM_LITE_SERVICE_UUIDS = Object.values(LITE_BLE_SPEC).map(service => service.serviceUuid);

export enum LiteHomingType {
    None = 0,
    Default = 1,
    SingleSided = 2,
    DoubleTap = 3
};

enum LiteAPControlModifier {
    Amplitude = 0,
    InStep = 1,
    InWait = 2,
    OutStep = 3,
    OutWait = 4,
    Offset = 5,
}

enum LiteAPControl {
    MaxDepth = 0,
    MinDepth = 1,
    InSpeed = 2,
    OutSpeed = 3,
    InAcceleration = 4,
    OutAcceleration = 5,
    Speed = 6,
}

type LiteAPControlEntry = { value: number } & { [K in Uncapitalize<keyof typeof LiteAPControlModifier>]?: number };

export type LiteAPConfig = { [K in Uncapitalize<keyof typeof LiteAPControl>]: LiteAPControlEntry };

export type LiteWriteAdvancedPatternParams = { [K in keyof LiteAPConfig]?: Partial<LiteAPConfig[K]> };

type LiteSpecSkeletonCharacteristic = {
    uuid: string;
    properties: readonly ("read" | "write" | "writeWithoutResponse" | "notify")[];
} & Partial<LiteCodec<any>>;

type LiteSpecSkeleton = {
    [key: string]: {
        serviceUuid: string | number;
        characteristics: {
            [charKey: string]: LiteSpecSkeletonCharacteristic;
        };
    };
};
// #endregion

// #region Type generators
/* oO0Oo Very magic voodoo shit! oO0Oo */

type LiteSpec = typeof LITE_BLE_SPEC;

type LiteGatts = {
    [S in keyof LiteSpec]: {
        [C in keyof (LiteSpec)[S]["characteristics"]]: BluetoothRemoteGATTCharacteristic;
    }
};

type LiteHasProperty<Props extends readonly string[], Target extends string> = Target extends Props[number] ? true : false;

type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never;

type LiteGetter<T> = (ct?: ICancellationToken) => Promise<T>;
type LiteGetterGenerator<T extends LiteSpecSkeleton> = UnionToIntersection<{
    -readonly [ServiceKey in keyof T]: {
        -readonly [CharKey in keyof T[ServiceKey]["characteristics"] as CharKey extends string
            ? T[ServiceKey]["characteristics"][CharKey] extends { dec: infer D }
                ? D extends (v: string) => infer R
                    ? LiteHasProperty<T[ServiceKey]["characteristics"][CharKey]["properties"], "read"> extends true
                        ? `get${Capitalize<CharKey>}` // If the char has a read prop and a decoder then generate a method
                        : never // Otherwise omit the entry
                    : never
                : never
            : never
        ]: LiteGetter<T[ServiceKey]["characteristics"][CharKey] extends { dec: LiteCodec<infer R>["dec"] } ? R : never>; // Infer the method parameters & return type from the decoder;
    };
}[keyof T]>;

type LiteSetter<T> = (v: T, ct?: ICancellationToken) => Promise<void>;
type LiteSetterGenerator<T extends LiteSpecSkeleton> = UnionToIntersection<{
    -readonly [ServiceKey in keyof T]: {
        -readonly [CharKey in keyof T[ServiceKey]["characteristics"] as CharKey extends string
            ? T[ServiceKey]["characteristics"][CharKey] extends { enc: infer E }
                ? E extends (v: infer V) => string
                    ? (LiteHasProperty<T[ServiceKey]["characteristics"][CharKey]["properties"], "write"> extends true ? true :
                       LiteHasProperty<T[ServiceKey]["characteristics"][CharKey]["properties"], "writeWithoutResponse"> extends true ? true : false) extends true
                        ? `set${Capitalize<CharKey>}`
                        : never
                    : never
                : never
            : never
        ]: LiteSetter<T[ServiceKey]["characteristics"][CharKey] extends { enc: LiteCodec<infer V>["enc"] } ? V : never>;
    };
}[keyof T]>;

type LiteNotifierGenerator<T extends LiteSpecSkeleton, TOwned> = UnionToIntersection<{
    -readonly [ServiceKey in keyof T]: {
        -readonly [CharKey in keyof T[ServiceKey]["characteristics"] as CharKey extends string
            ? T[ServiceKey]["characteristics"][CharKey] extends { dec: infer D }
                ? D extends (v: string) => infer R
                    ? LiteHasProperty<T[ServiceKey]["characteristics"][CharKey]["properties"], "notify"> extends true
                        ? CharKey
                        : never
                    : never
                : never
            : never
        ]: TOwned extends true
            ? SingleEventSource<[T[ServiceKey]["characteristics"][CharKey] extends { dec: LiteCodec<infer R>["dec"] } ? R : never]>
            : SingleEvent<[T[ServiceKey]["characteristics"][CharKey] extends { dec: LiteCodec<infer R>["dec"] } ? R : never]>;
    };
}[keyof T]>;
type LiteNotifiers<TOwned> = LiteNotifierGenerator<LiteSpec, TOwned>;

type LiteMemberGenerator<T extends LiteSpecSkeleton> = LiteGetterGenerator<T> & LiteSetterGenerator<T>;

type OssmLiteClientGenerated = Omit<LiteMemberGenerator<LiteSpec>, keyof OssmLiteClientImpl>;
// #endregion

// #region Class implementation
/*
 * This is where the runtime generated methods are created and stored
 * And where any additional methods or overrides are written
 */

class OssmLiteClientImpl extends BleConnectionHandler {
    static async pairDevice(): Promise<OssmLiteClient> {
        const bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: "OSSM" }],
            optionalServices: OSSM_LITE_SERVICE_UUIDS
        });
        return new OssmLiteClientImpl(bleDevice) as OssmLiteClient;
    }

    protected readonly _enc = new TextEncoder();
    protected readonly _dec = new TextDecoder();
    readonly #on = {} as LiteNotifiers<true>;
    #defaultTimeoutMs = 6000;
    #characteristics = {} as LiteGatts;
    #generatedNotifierSignatures: Map<BluetoothRemoteGATTCharacteristic, (e: Event) => void> = new Map();
    #isInAdvancedPenetrationMode = false;

    get on(): Readonly<LiteNotifiers<false>> { return this.#on; }
    get defaultTimeoutMs(): number | null { return this.#defaultTimeoutMs == -1 ? null : this.#defaultTimeoutMs; }
    set defaultTimeoutMs(value: number) {
        if (value < -1 || Number.isNaN(value))
            throw new DOMException("Value must be a positive integer or -1");
        this.#defaultTimeoutMs = value;
    }
    get isInAdvancedPenetrationMode() { return this.#isInAdvancedPenetrationMode; }

    /**
     * Provides access to the underlying BLE device in-case any additional functionality is required.  
     * For example the Lite firmware supports service/characteristic auto-discovery with descriptors.  
     * This can be useful for dynamically building UIs, or for accessing properties that this Library doesn't provide.
     * 
     * **WARNING:** Executing GATT operations directly on this object will bypass internal task queue scheduling.  
     * This can lead to race conditions and dropped commands, as the Web Bluetooth stack can only process operations sequentially.
     */
    /* I had considered adding auto-discovery to this library (see commit 3dad12029e081917155a12b7f3df9ae9639ac557)
     * but ultimately decided against it in order to keep this library type strict and clean.
     * I did experiment with auto-discovery but it slowed down startup a lot and meant raw data buffers were exposed
     */
    get device() { return this._device; }

    private get generated(): OssmLiteClientGenerated { return this as unknown as OssmLiteClientGenerated; }
    constructor(device: BluetoothDevice) {
        super(device);

        // Generate event dispatchers
        for (const [serviceKey, serviceSpec] of Object.entries(LITE_BLE_SPEC as LiteSpecSkeleton)) {
            for (const charKey of Object.keys(serviceSpec.characteristics)) {
                const charSpec = serviceSpec.characteristics[charKey];

                if (!charSpec.properties.includes("notify"))
                    continue;

                (this.#on as any as Record<string, SingleEventSource<[unknown]>>)[charKey] = new SingleEventSource();
            }
        }

        /* Used to determine the active mode
         * The active mode on the device switches automatically when the pattern or AP config is changed
         * Required so the e-stop function calls to the right method
         */
        this.on.pattern.subscribe(p => this.#isInAdvancedPenetrationMode = false);
        this.on.advancedPenetrationConfig.subscribe(p => this.#isInAdvancedPenetrationMode = true);

        // Generate methods but set them to throw if called since we aren't ready yet
        this.#clearGenerated();
    }

    // #region Lifecycle
    #clearGenerated(): void {
        for (const [bluetooth, signature] of this.#generatedNotifierSignatures) {
            bluetooth.removeEventListener("characteristicvaluechanged", signature);
            bluetooth.stopNotifications().catch(e => console.error(`Failed to stop notifications for ${bluetooth.uuid}`, e));
        }

        for (const [serviceKey, serviceSpec] of Object.entries(LITE_BLE_SPEC as LiteSpecSkeleton)) {
            for (const charKey of Object.keys(serviceSpec.characteristics)) {
                const charSpec = serviceSpec.characteristics[charKey];

                for (const prop of charSpec.properties) {
                    switch (prop) {
                        case "read": {
                            if (!charSpec.dec) break;
                            (this.generated as any as Record<string, LiteGetter<unknown>>)[`get${OssmLiteClientImpl.#upperFirst(charKey)}`] =
                                ct => { throw new DOMException("Not ready", "InvalidStateError"); };
                            break;
                        }
                        case "write":
                        case "writeWithoutResponse": {
                            if (charSpec.properties.includes("writeWithoutResponse") || !charSpec.enc) break;
                            (this.generated as any as Record<string, LiteSetter<unknown>>)[`set${OssmLiteClientImpl.#upperFirst(charKey)}`] =
                                (v, ct) => { throw new DOMException("Not ready", "InvalidStateError"); };
                            break;
                        }
                    }
                }
            }
        }
    }

    protected async _setupServicesAndCharacteristics(gatt: BluetoothRemoteGATTServer): Promise<void> {
        this.#characteristics = {} as LiteGatts;

        const tasks: Promise<unknown>[] = [];
        for (const [serviceKey, serviceSpec] of Object.entries(LITE_BLE_SPEC as LiteSpecSkeleton)) {
            const gattService = await this._taskQueue.enqueue(() => gatt.getPrimaryService(serviceSpec.serviceUuid));
            const deviceCharacteristics = new Map((await this._taskQueue.enqueue(() => gattService.getCharacteristics())).map(c => [c.uuid.toLowerCase(), c]));

            this._debugLog("service", serviceKey, serviceSpec.serviceUuid)

            const serviceCharsObj = {} as Record<string, BluetoothRemoteGATTCharacteristic>;

            for (const charKey of Object.keys(serviceSpec.characteristics)) {
                const charSpec = serviceSpec.characteristics[charKey];

                const characteristic = deviceCharacteristics.get(charSpec.uuid.toLowerCase());
                if (!characteristic) throw new DOMException(`Characteristic ${charKey} not found`, "NotFoundError");
                this._debugLog("characteristic", charKey, characteristic.uuid)

                serviceCharsObj[charKey] = characteristic;

                for (const prop of charSpec.properties) {
                    switch (prop) {
                        case "read": {
                            if (!charSpec.dec) break;
                            if (!characteristic.properties.read) throw new DOMException("Characteristic missing required read property", "NotSupportedError");
                            (this.generated as any as Record<string, LiteGetter<unknown>>)[`get${OssmLiteClientImpl.#upperFirst(charKey)}`] =
                                async ct => charSpec.dec!(await this.#read(characteristic, ct));
                            break;
                        }
                        case "write": {
                            if (charSpec.properties.includes("writeWithoutResponse") || !charSpec.enc) break;
                            if (!characteristic.properties.write) throw new DOMException("Characteristic missing required write property", "NotSupportedError");
                            /* As it is right now this lite api provides no way to tell if a write was valid
                             * One possible solution would be to watch the returned notify value if the characteristic has it and check if the value is the same as thee one written
                             * However this wouldn't work for all
                             * The firmware does set the characteristic to a fail string on error, but the read operation immediately overrides it with a valid value
                             * So in that manner we cannot read back the char to check if it failed
                             */
                            (this.generated as any as Record<string, LiteSetter<unknown>>)[`set${OssmLiteClientImpl.#upperFirst(charKey)}`] =
                                (v, ct) => this.#write(characteristic, charSpec.enc!(v), false, ct);
                            break;
                        }
                        case "writeWithoutResponse": {
                            if (!charSpec.enc) break;
                            if (!characteristic.properties.writeWithoutResponse) throw new DOMException("Characteristic missing required writeWithoutResponse property", "NotSupportedError");
                            (this.generated as any as Record<string, LiteSetter<unknown>>)[`set${OssmLiteClientImpl.#upperFirst(charKey)}`] =
                                (v, ct) => this.#write(characteristic, charSpec.enc!(v), true, ct);
                            break;
                        }
                        case "notify": {
                            if (!charSpec.dec) break;
                            if (!characteristic.properties.notify && !characteristic.properties.indicate) throw new DOMException("Characteristic missing required notify property", "NotSupportedError");
                            
                            const notifySignature = (event: Event) => this.#notifyHandler(event, charKey, charSpec.dec!);
                            characteristic.addEventListener("characteristicvaluechanged", notifySignature);
                            this.#generatedNotifierSignatures.set(characteristic, notifySignature);
                            tasks.push(this._taskQueue.enqueue(() => characteristic.startNotifications()));
                            break;
                        }
                    }
                }

                (this.#characteristics as Record<string, any>)[serviceKey] = serviceCharsObj;
            }
        }
        await Promise.all(tasks);
    }

    protected override async _onBeforeDisconnect(): Promise<void> {
        this.#clearGenerated();
    }

    protected async _onDisconnected(wasConnected: boolean): Promise<void> {
        this.#characteristics = {} as LiteGatts;
    }
    // #endregion

    // #region Custom methods
    /** Fetches the available patterns from the device */
    async *getPatterns(cancellationToken?: ICancellationToken): AsyncGenerator<OssmSchema.OssmPattern, void, unknown> {
        const [cts, ct] = this.#getCancellationToken(cancellationToken);

        let idx = 0;
        while (true) {
            // Write patten index to fetch then read it back
            const payload = this._enc.encode(idx.toString());
            const valueStr = this._dec.decode(await this._taskQueue.enqueue(async () => {
                this._debugLog("Fetching pattern info for idx", idx);
                await this.#characteristics.common.patternOptions.writeValue(payload);
                return await this.#characteristics.common.patternOptions.readValue();
            }, ct));

            // Empty string indicates we've reached the end of the pattern list
            if (!valueStr || valueStr.trim() === "")
                break;

            const [name, description] = valueStr.split(":", 2);

            yield {
                idx: idx++,
                name,
                description
            };
        }

        cts?.dispose();
    }

    /** Triggers the device to restart */
    async updateAndRestart(ct?: ICancellationToken): Promise<void> {
        await this.#write(this.#characteristics.config.updateAndRestart, "1", true, ct);
    }

    /** Emergency stops the device */
    async emergencyStop(ct?: ICancellationToken): Promise<void> {
        this._taskQueue.clearQueue();
        if (this.isInAdvancedPenetrationMode)
            await this.writeAdvancedPenetrationConfig({ speed: { value: 0 } });
        else
            await this.generated.setSpeed(0, ct);
    }

    /**
     * Gets the advanced patterns from the devices non-volatile storage
     * @returns A list of advanced pattern names from the device
     */
    async getAdvancedPenetrationConfigNames(ct?: ICancellationToken): Promise<string[]> {
        return (await this.#read(this.#characteristics.advancedPenetration.advancedPresets, ct)).split(",").filter(Boolean);
    }

    /**
     * Loads an advanced pattern from the devices non-volatile storage
     * @param name The name of the pattern to load
     * @throws If the pattern does not exist on the device
     */
    async loadAdvancedPenetrationConfig(name: string, ct?: ICancellationToken): Promise<void> {
        if (!(await this.getAdvancedPenetrationConfigNames()).includes(name))
            throw new DOMException("Pattern does not exist on device", "NotFoundError");
        await this.#write(this.#characteristics.advancedPenetration.advancedPresets, `:${name}`, true, ct);
    }

    /**
     * Writes a set of advanced pattern parameters and immediately executes them
     * 
     * *Note:* This will switch operating modes on the device if not in AdvancedPenetration mode already
     *
     * **WARNING:** If a mode switch is triggered then re-homing of the rail may occur!
     * 
     * @param parameters A dictionary of advanced pattern parameters, not all keys or properties have to be set
     * @see {@link OssmLiteClientGenerated.getAdvancedPenetrationConfig} to get the currently active advanced control parameters
     */
    async writeAdvancedPenetrationConfig(parameters: LiteWriteAdvancedPatternParams, ct?: ICancellationToken): Promise<void> {
        const commandParts: string[] = [];

        for (const [controlKeyStr, entry] of Object.entries(parameters)) {
            if (!entry) continue;

            // Re-capitalize first letter (TS generated type uncapitalizes it which forces callers to this method to use that uncapitalized key)
            const enumKey = controlKeyStr.charAt(0).toUpperCase() + controlKeyStr.slice(1);
            const control = LiteAPControl[enumKey as keyof typeof LiteAPControl];
            if (control === undefined) continue;

            // Control base value
            if (entry.value !== undefined) {
                let min: number, max: number;
                switch (control) {
                    case LiteAPControl.InSpeed:
                    case LiteAPControl.OutSpeed:
                        min = 1; max = 100; break;
                    case LiteAPControl.InAcceleration:
                    case LiteAPControl.OutAcceleration:
                        min = 40; max = 100; break;
                    case LiteAPControl.MaxDepth:
                    case LiteAPControl.MinDepth:
                    case LiteAPControl.Speed:
                        min = 0; max = 100; break;
                }
                enforceRange(entry.value, min, max, `${LiteAPControl[control]} must be between ${min} and ${max}`);
                commandParts.push(`${control}:${entry.value}`);
            }

            for (const [propKey, modifierValue] of Object.entries(entry)) {
                if (propKey === 'value' || modifierValue === undefined) continue; // Skip the base value entry if present (or if value is undefined)

                const modifierKey = propKey.charAt(0).toUpperCase() + propKey.slice(1);
                const modifier = LiteAPControlModifier[modifierKey as keyof typeof LiteAPControlModifier];
                if (modifier === undefined) continue;

                let min: number, max: number;
                switch (modifier) {
                    case LiteAPControlModifier.InStep:
                    case LiteAPControlModifier.OutStep:
                        min = 1; max = 25; break;
                    case LiteAPControlModifier.InWait:
                    case LiteAPControlModifier.OutWait:
                        min = 0; max = 25; break;
                    case LiteAPControlModifier.Amplitude:
                    case LiteAPControlModifier.Offset:
                        min = 0; max = 100; break;
                }
                enforceRange(modifierValue, min, max, `${modifierKey} must be between ${min} and ${max}`);
                commandParts.push(`${control}:${modifier}:${modifierValue}`);
            }
        }

        const commandStr = commandParts.join(",") + ",";
        if (commandStr === ",") return;

        await this.#write(this.#characteristics.advancedPenetration.advancedControl, commandStr, true, ct);
    }

    /**
     * Saves the currently active advanced pattern to the devices non-volatile storage
     * @param name The name to use when saving the pattern
     */
    async saveAdvancedPenetrationConfig(name: string, ct?: ICancellationToken): Promise<void> {
        await this.#write(this.#characteristics.advancedPenetration.advancedPresets, `>${name}`, true, ct);
    }

    /**
     * Deletes an advanced pattern from the devices non-volatile storage
     * @param name The name of the pattern to delete
     * @throws If the pattern does not exist on the device
     */
    async deleteAdvancedPenetrationConfig(name: string, ct?: ICancellationToken): Promise<void> {
        if (!(await this.getAdvancedPenetrationConfigNames()).includes(name))
            throw new DOMException("Pattern does not exist on device", "NotFoundError");
        await this.#write(this.#characteristics.advancedPenetration.advancedPresets, `<${name}`, true, ct);
    }

    /** Resets all stored advanced patterns to factory defaults */
    async resetAllAdvancedPenetrationConfigs(ct?: ICancellationToken): Promise<void> {
        await this.#write(this.#characteristics.advancedPenetration.advancedPresets, '^', true, ct);
    }
    // #endregion

    // #region Helpers
    async #read(characteristic: BluetoothRemoteGATTCharacteristic, cancellationToken?: ICancellationToken): Promise<string> {
        this.#requireReady();
        const [cts, ct] = this.#getCancellationToken(cancellationToken);
        try {
            return this._dec.decode(await this._taskQueue.enqueue(() => {
                this.#requireReady();
                return characteristic.readValue()
            }, ct));
        }
        finally { cts?.dispose(); }
    }

    async #write(characteristic: BluetoothRemoteGATTCharacteristic, value: string, withoutResponse: boolean, cancellationToken?: ICancellationToken): Promise<void> {
        this.#requireReady();
        const [cts, ct] = this.#getCancellationToken(cancellationToken);
        const buf = this._enc.encode(value);
        try {
            return this._taskQueue.enqueue(() => {
                this.#requireReady();
                return withoutResponse ? characteristic.writeValueWithoutResponse(buf) : characteristic.writeValue(buf)
            }, ct);
        }
        finally { cts?.dispose(); }
    }

    #notifyHandler(event: Event, characteristicKey: string, decoder: LiteCodec<unknown>["dec"]): void {
        if (!event.target) return;
        const target = event.target as BluetoothRemoteGATTCharacteristic;

        const dispatcher = (this.#on as any as Record<string, SingleEventSource<[unknown]> | undefined>)[characteristicKey];
        if (!dispatcher) return;

        let value: unknown;
        try { value = decoder(this._dec.decode(target.value)); }
        catch (e) { console.error(`[${this._device.id}] #notifyHandler failed to decode value`, e); }

        dispatcher.dispatch(value);
    }

    #getCancellationToken(cancellationToken?: ICancellationToken): [CancellationTokenSource | undefined, ICancellationToken] {
        const cts = !cancellationToken && this.defaultTimeoutMs ? CancellationTokenSource.createWithTimeout(this.defaultTimeoutMs) : undefined;
        return [cts, cancellationToken ?? cts?.token ?? CancellationToken.None];
    }

    #requireReady(): void {
        if (!this.isConnected)
            throw new DOMException("Not ready", "InvalidStateError");
    }

    static #upperFirst(string: string) {
        return string.charAt(0).toUpperCase() + string.slice(1);
    }
    // #endregion
}

// Export combined types for IDE & compiler hints
export type OssmLiteClient = OssmLiteClientGenerated & OssmLiteClientImpl;
// Export object mapped to impl with public definitions (exporting OssmLiteClientImpl as-is won't do this for some reason)
export const OssmLiteClient = OssmLiteClientImpl as unknown as (
    (typeof OssmLiteClientImpl extends new (...args: infer P) => any 
        ? new (...args: P) => OssmLiteClient 
        : never)
    & typeof OssmLiteClientImpl
);
// #endregion
