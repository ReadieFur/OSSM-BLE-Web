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
import { BleConnectionHandler } from "./BleConnectionHandler";
import { CancellationToken, CancellationTokenSource, ICancellationToken } from "./CancellationToken";
import { enforceRange } from "./Helpers";
import * as OssmSchema from "./OssmProtocolSchema";
import { SingleEvent, SingleEventSource } from "./SingleEvent";
// #endregion

// #region Common codecs
type LiteCodec<T> = {
    enc: (v: T) => string;
    dec: (v: string) => T;
};

const LITE_CODECS = {
    float: {
        enc: (v: number) => v.toString(),
        dec: v => Number.parseFloat(v)
    },
    int: {
        enc: (v: number) => v.toString(),
        dec: v => Number.parseInt(v)
    },
    string: {
        enc: (v: string) => v,
        dec: v => v
    }
} as const satisfies Record<string, LiteCodec<any>>
// #endregion

// #region BLE Specification
/*
 * Define all BLE characteristics here
 * If the characteristic has read/write properties and a set encoder/decoder then a dynamically generated method & type hints will be created for it
 * If the OssmLiteClientImpl class has a member who's name matches one of these characteristics then it will be overriden by the class impl
 * The characteristic keys must be unique here as they are unioned
 */

const LITE_CONFIG_UUID_BASE = "4f53534d-436f-6e66-6967-";
const LITE_COMMON_UUID_BASE_1 = "4f53534d-436f-6d6d-6f6e-";
const LITE_COMMON_UUID_BASE_2 = "4f53534d-506f-7369-7469-";
const LITE_COMMON_UUID_BASE_3 = "4f53534d-456e-6769-6e65-";

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

// https://github.com/fray-d/OSSM-Lite/tree/e1ff45d8eafbf43e1d6b7f5f9a35a8277faa9b9b/Software/src/services/communication
const LITE_BLE_SPEC = {
    config: {
        serviceUuid: 0x055C,
        characteristics: {
            wifiConfig: { uuid: LITE_CONFIG_UUID_BASE + "202057694669", properties: ["read", "write"] },
            renameDevice: { uuid: LITE_CONFIG_UUID_BASE + "52656E616D65", properties: ["read", "write", "writeWithoutResponse", "notify"] },
            homingType: { uuid: LITE_CONFIG_UUID_BASE + "486F6D696E67", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.int },
            railLength: { uuid: LITE_CONFIG_UUID_BASE + "4C656E677468", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.float },
            railDirection: { uuid: LITE_CONFIG_UUID_BASE + "496E76657274", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.int },
            homeBetweenModes: { uuid: LITE_CONFIG_UUID_BASE + "5265486F6D65", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.int },
            gpio: { uuid: LITE_CONFIG_UUID_BASE + "20204750494F", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.int },
            updateAndRestart: { uuid: LITE_CONFIG_UUID_BASE + "557064617465", properties: ["write", "writeWithoutResponse"], ...LITE_CODECS.int },
            maxAcceleration: { uuid: LITE_CONFIG_UUID_BASE + "4d414343454c", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.float },
            maxMotorRpm: { uuid: LITE_CONFIG_UUID_BASE + "4d415852504d", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.int },
            stepsPerRevolution: { uuid: LITE_CONFIG_UUID_BASE + "535445505052", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.int },
            pulleyTeeth: { uuid: LITE_CONFIG_UUID_BASE + "50554c4c4559", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.float },
            beltPitch: { uuid: LITE_CONFIG_UUID_BASE + "425049544348", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.float },
            currentSensorLimit: { uuid: LITE_CONFIG_UUID_BASE + "53656e736f72", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.float },
            speedCurve: { uuid: LITE_CONFIG_UUID_BASE + "537064437276", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.float },
            homingSpeed: { uuid: LITE_CONFIG_UUID_BASE + "537064486f6d", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.float }
        }
    },
    common: {
        serviceUuid: 0x055E,
        characteristics: {
            speed: { uuid: LITE_COMMON_UUID_BASE_1 + "005370656564", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.float },
            maxDepth: { uuid: LITE_COMMON_UUID_BASE_1 + "4d6178446570", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.float },
            minDepth: { uuid: LITE_COMMON_UUID_BASE_1 + "4d696e446570", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.float },
            streamInput: { uuid: LITE_COMMON_UUID_BASE_1 + "53747265616D", properties: ["read", "write", "writeWithoutResponse", "notify"],
                enc: (v: { position: number, duration: number }) => `${v.position}:${v.duration}`,
                dec: v => {
                    const [position, duration] = v.split(":");
                    return { position: Number.parseFloat(position), duration: Number.parseFloat(duration) };
                }
            },
            targetPosition: { uuid: LITE_COMMON_UUID_BASE_2 + "6f6e54617267", properties: ["read", "notify"], ...LITE_CODECS.float },
            currentPosition: { uuid: LITE_COMMON_UUID_BASE_2 + "6f6e63757272", properties: ["read", "notify"], ...LITE_CODECS.float },
            sensation: { uuid: LITE_COMMON_UUID_BASE_3 + "536174696f6e", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.float },
            pattern: { uuid: LITE_COMMON_UUID_BASE_3 + "50617465726e", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.int },
            patternOptions: { uuid: LITE_COMMON_UUID_BASE_3 + "5061744c7374", properties: ["read", "write"] }
        }
    }
} as const satisfies LiteSpecSkeleton;
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

type LiteGetter<T> = (ct?: CancellationToken) => Promise<T>;
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

type LiteSetter<T> = (v: T, ct?: CancellationToken) => Promise<void>;
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
            optionalServices: Object.values(LITE_BLE_SPEC).map(service => service.serviceUuid)
        });
        return new OssmLiteClientImpl(bleDevice) as OssmLiteClient;
    }

    protected readonly _enc = new TextEncoder();
    protected readonly _dec = new TextDecoder();
    readonly #on = {} as LiteNotifiers<true>;
    #defaultTimeoutMs = 6000;
    #characteristics = {} as LiteGatts;
    #generatedNotifierSignatures: Map<BluetoothRemoteGATTCharacteristic, (e: Event) => void> = new Map();

    get on(): Readonly<LiteNotifiers<false>> { return this.#on; }
    get defaultTimeoutMs(): number | null { return this.#defaultTimeoutMs == -1 ? null : this.#defaultTimeoutMs; }
    set defaultTimeoutMs(value: number) {
        if (value < -1 || Number.isNaN(value))
            throw new DOMException("Value must be a positive integer or -1");
        this.#defaultTimeoutMs = value;
    }

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

        // Generate methods but set them to throw if called since we aren't ready yet
        this.#clearGenerated();
    }

    // #region Dynamic method generators
    #clearGenerated(): void {
        for (const [bluetooth, signature] of this.#generatedNotifierSignatures)
            bluetooth.removeEventListener("characteristicvaluechanged", signature);

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

        for (const [serviceKey, serviceSpec] of Object.entries(LITE_BLE_SPEC as LiteSpecSkeleton)) {
            this._debugLog("_setupServicesAndCharacteristics service", serviceKey, serviceSpec.serviceUuid)

            const gattService = await gatt.getPrimaryService(serviceSpec.serviceUuid);
            const deviceCharacteristics = new Map((await gattService.getCharacteristics()).map(c => [c.uuid.toLowerCase(), c]));

            const serviceCharsObj = {} as Record<string, BluetoothRemoteGATTCharacteristic>;

            for (const charKey of Object.keys(serviceSpec.characteristics)) {
                const charSpec = serviceSpec.characteristics[charKey];

                const characteristic = deviceCharacteristics.get(charSpec.uuid.toLowerCase());
                if (!characteristic) throw new DOMException(`[OssmLiteClient] Characteristic ${charKey} not found`, "NotFoundError");
                this._debugLog("_setupServicesAndCharacteristics characteristic", charKey, characteristic.uuid)

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
                            (this.generated as any as Record<string, LiteSetter<unknown>>)[`set${OssmLiteClientImpl.#upperFirst(charKey)}`] =
                                (v, ct) => this.#write(characteristic, charSpec.enc!(v), true, ct);
                            break;
                        }
                        case "writeWithoutResponse": {
                            if (!charSpec.enc) break;
                            if (!characteristic.properties.writeWithoutResponse) throw new DOMException("Characteristic missing required writeWithoutResponse property", "NotSupportedError");
                            (this.generated as any as Record<string, LiteSetter<unknown>>)[`set${OssmLiteClientImpl.#upperFirst(charKey)}`] =
                                (v, ct) => this.#write(characteristic, charSpec.enc!(v), false, ct);
                            break;
                        }
                        case "notify": {
                            if (!charSpec.dec) break;
                            if (!characteristic.properties.notify && !characteristic.properties.indicate) throw new DOMException("Characteristic missing required notify property", "NotSupportedError");
                            
                            const notifySignature = (event: Event) => this.#notifyHandler(event, charKey, charSpec.dec!);
                            characteristic.addEventListener("characteristicvaluechanged", notifySignature);
                            this.#generatedNotifierSignatures.set(characteristic, notifySignature);
                            // TODO
                            break;
                        }
                    }
                }

                (this.#characteristics as Record<string, any>)[serviceKey] = serviceCharsObj;
            }
        }
    }
    // #endregion

    // #region Lifecycle
    protected override async _onBeforeDisconnect(): Promise<void> {
        this.#clearGenerated();
    }
    // #endregion

    // #region Custom methods
    async *getPatterns(ct?: ICancellationToken): AsyncGenerator<OssmSchema.OssmPattern, void, unknown> {
        const cts = !ct && this.defaultTimeoutMs ? CancellationTokenSource.createWithTimeout(this.defaultTimeoutMs) : undefined;
        ct = ct ?? cts?.token ?? CancellationToken.None;

        let idx = 0;
        while (true) {
            // Write patten index to fetch then read it back
            const payload = this._enc.encode(idx.toString());
            const valueStr = this._dec.decode(await this._taskQueue.enqueue(async () => {
                this._debugLog("Fetching pattern info for idx", idx);
                await this.#characteristics.common.patternOptions.writeValue(payload);
                return await this.#characteristics.common.patternOptions.readValue();
            }));

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
    }
    // #endregion

    // #region Helpers
    async #read(characteristic: BluetoothRemoteGATTCharacteristic, cancellationToken?: CancellationToken): Promise<string> {
        const [cts, ct] = this.#getCancellationToken(cancellationToken);
        try { return this._dec.decode(await this._taskQueue.enqueue(() => characteristic.readValue(), ct)); }
        finally { cts?.dispose(); }
    }

    async #write(characteristic: BluetoothRemoteGATTCharacteristic, value: string, waitForResponse: boolean, cancellationToken?: ICancellationToken): Promise<void> {
        const [cts, ct] = this.#getCancellationToken(cancellationToken);
        const buf = this._enc.encode(value);
        try { return this._taskQueue.enqueue(() => waitForResponse ? characteristic.writeValueWithoutResponse(buf) : characteristic.writeValue(buf), ct); }
        finally { cts?.dispose(); }
    }

    #notifyHandler(event: Event, characteristicKey: string, decoder: LiteCodec<unknown>["dec"]) {
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
