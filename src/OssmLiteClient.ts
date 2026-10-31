import { BleConnectionHandler } from "./BleConnectionHandler";
import { CancellationToken, CancellationTokenSource, ICancellationToken } from "./CancellationToken";
import { enforceRange } from "./Helpers";
import * as OssmSchema from "./OssmProtocolSchema";
import { SingleEvent, SingleEventSource } from "./SingleEvent";

const LITE_CONFIG_UUID_BASE = "4f53534d-436f-6e66-6967-";
const LITE_COMMON_UUID_BASE_1 = "4f53534d-436f-6d6d-6f6e-";
const LITE_COMMON_UUID_BASE_2 = "4f53534d-506f-7369-7469-";
const LITE_COMMON_UUID_BASE_3 = "4f53534d-456e-6769-6e65-";

type Codec<T> = {
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
} as const satisfies Record<string, Codec<any>>

type LiteSpecSkeleton = {
    [key: string]: {
        serviceUuid: string;
        characteristics: {
            [charKey: string]: {
                uuid: string;
                properties: readonly ("read" | "write" | "writeWithoutResponse" | "notify")[];
            } & Partial<Codec<any>>;
        };
    };
};

const LITE_BLE_SPEC = {
    config: {
        serviceUuid: "055C",
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
        serviceUuid: "055E",
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
            targetPosition: { uuid: LITE_COMMON_UUID_BASE_2 + "6f6e546178", properties: ["read", "notify"], ...LITE_CODECS.float },
            currentPosition: { uuid: LITE_COMMON_UUID_BASE_2 + "6f6e63757272", properties: ["read", "notify"], ...LITE_CODECS.float },
            sensation: { uuid: LITE_COMMON_UUID_BASE_3 + "536174696f6e", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.float },
            pattern: { uuid: LITE_COMMON_UUID_BASE_3 + "50617465726e", properties: ["read", "write", "writeWithoutResponse", "notify"], ...LITE_CODECS.int },
            patternOptions: { uuid: LITE_COMMON_UUID_BASE_3 + "5061744c7374", properties: ["read", "write"] }
        }
    }
} as const satisfies LiteSpecSkeleton;

type LiteSpec = typeof LITE_BLE_SPEC;

type LiteHasProperty<Props extends readonly string[], Target extends string> = Target extends Props[number] ? true : false;

type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never;

type LiteGetterGenerator<T extends LiteSpecSkeleton> = UnionToIntersection<{
    -readonly [ServiceKey in keyof T]: {
        -readonly [CharKey in keyof T[ServiceKey]["characteristics"] as CharKey extends string
            ? T[ServiceKey]["characteristics"][CharKey] extends { dec: infer D }
                ? D extends (v: string) => infer R
                    ? LiteHasProperty<T[ServiceKey]["characteristics"][CharKey]["properties"], "read"> extends true
                        ? `get${Capitalize<CharKey>}`
                        : never
                    : never
                : never
            : never
        ]: (ct?: any) => Promise<
            T[ServiceKey]["characteristics"][CharKey] extends { dec: (v: string) => infer R } ? R : never
        >;
    };
}[keyof T]>;

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
        ]: (
            value: T[ServiceKey]["characteristics"][CharKey] extends { enc: (v: infer V) => string } ? V : never,
            ct?: any
        ) => Promise<void>;
    };
}[keyof T]>;

type LiteMemberGenerator<T extends LiteSpecSkeleton> = LiteGetterGenerator<T> & LiteSetterGenerator<T>;

type OssmLiteClientGenerated = Omit<LiteMemberGenerator<LiteSpec>, keyof OssmLiteClientImpl>;

type LiteRuntimeCharacteristic = {
    characteristic: BluetoothRemoteGATTCharacteristic,
} & Partial<Codec<any>>;

class OssmLiteClientImpl extends BleConnectionHandler {
    static async pairDevice(): Promise<OssmLiteClient> {
        const bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: "OSSM" }],
            optionalServices: []
        });
        return new OssmLiteClientImpl(bleDevice) as OssmLiteClient;
    }

    protected readonly _enc = new TextEncoder();
    protected readonly _dec = new TextDecoder();
    
    #defaultTimeoutMs = 6000;
    get defaultTimeoutMs(): number | null { return this.#defaultTimeoutMs == -1 ? null : this.#defaultTimeoutMs; }
    set defaultTimeoutMs(value: number) {
        if (value < -1 || Number.isNaN(value))
            throw new DOMException("Value must be a positive integer or -1");
        this.#defaultTimeoutMs = value;
    }

    private get generated(): OssmLiteClientGenerated { return this as unknown as OssmLiteClientGenerated; }
    constructor(device: BluetoothDevice) {
        super(device);
    }

    protected async _setupServicesAndCharacteristics(gatt: BluetoothRemoteGATTServer): Promise<void> {
        for (const [serviceKey, serviceSpec] of Object.entries(LITE_BLE_SPEC as LiteSpecSkeleton)) {
            const gattService = await gatt.getPrimaryService(serviceSpec.serviceUuid);
            const deviceChars = new Map((await gattService.getCharacteristics()).map(c => [c.uuid.toLowerCase(), c]));

            for (const charKey of Object.keys(serviceSpec.characteristics)) {
                const charSpec = serviceSpec.characteristics[charKey];

                const char = deviceChars.get(charSpec.uuid.toLowerCase());
                if (!char) throw new DOMException(`[OssmLiteClient] Characteristic ${charKey} not found`, "NotFoundError");

                const runtimeChar: LiteRuntimeCharacteristic = {
                    characteristic: char,
                };

                for (const prop of charSpec.properties) {
                    switch (prop) {
                        case "read": {
                            if (!charSpec.dec) break;
                            break;
                        }
                        case "write": {
                            if (!charSpec.enc) break;
                            break;
                        }
                        case "writeWithoutResponse": {
                            if (!charSpec.enc) break;
                            break;
                        }
                        case "notify": {
                            break;
                        }
                    }
                }
            }
        }
    }
}

// Export combined types for IDE & compiler hints
export type OssmLiteClient = OssmLiteClientGenerated & OssmLiteClientImpl;
// Export object mapped to impl with public definitions (exporting OssmLiteClientImpl as-is won't do this for some reason)
export const OssmLiteClient = OssmLiteClientImpl as unknown as (
    (typeof OssmLiteClientImpl extends new (...args: infer P) => any 
        ? new (...args: P) => OssmLiteClient 
        : never) & 
    typeof OssmLiteClientImpl
);
