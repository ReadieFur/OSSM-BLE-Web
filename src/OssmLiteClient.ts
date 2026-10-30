import { BleConnectionHandler } from "./BleConnectionHandler";
import { CancellationToken, CancellationTokenSource, ICancellationToken } from "./CancellationToken";
import { enforceRange } from "./Helpers";
import * as OssmSchema from "./OssmProtocolSchema";

const LITE_CONFIG_UUID_BASE = "4f53534d-436f-6e66-6967-";
const LITE_COMMON_UUID_BASE_1 = "4f53534d-436f-6d6d-6f6e-";
const LITE_COMMON_UUID_BASE_2 = "4f53534d-506f-7369-7469-";
const LITE_COMMON_UUID_BASE_3 = "4f53534d-456e-6769-6e65-";

const OSSM_LITE_BLE_SPEC = {
    config: {
        serviceUuid: "055C",
        characteristics: {
            wifiConfig: { uuid: LITE_CONFIG_UUID_BASE + "202057694669", properties: ["read", "write"] },
            renameDevice: { uuid: LITE_CONFIG_UUID_BASE + "52656E616D65", properties: ["read", "write", "writeWithoutResponse", "notify"] },
            homingType: { uuid: LITE_CONFIG_UUID_BASE + "486F6D696E67", properties: ["read", "write", "writeWithoutResponse", "notify"] },
            railLength: { uuid: LITE_CONFIG_UUID_BASE + "4C656E677468", properties: ["read", "write", "writeWithoutResponse", "notify"] },
            railDirection: { uuid: LITE_CONFIG_UUID_BASE + "496E76657274", properties: ["read", "write", "writeWithoutResponse", "notify"] },
            homeBetweenModes: { uuid: LITE_CONFIG_UUID_BASE + "5265486F6D65", properties: ["read", "write", "writeWithoutResponse", "notify"] },
            gpio: { uuid: LITE_CONFIG_UUID_BASE + "20204750494F", properties: ["read", "write", "writeWithoutResponse", "notify"] },
            updateAndRestart: { uuid: LITE_CONFIG_UUID_BASE + "557064617465", properties: ["write", "writeWithoutResponse"] },
            maxAcceleration: { uuid: LITE_CONFIG_UUID_BASE + "4d414343454c", properties: ["read", "write", "writeWithoutResponse", "notify"] },
            maxMotorRpm: { uuid: LITE_CONFIG_UUID_BASE + "4d415852504d", properties: ["read", "write", "writeWithoutResponse", "notify"] },
            stepsPerRevolution: { uuid: LITE_CONFIG_UUID_BASE + "535445505052", properties: ["read", "write", "writeWithoutResponse", "notify"] },
            pulleyTeeth: { uuid: LITE_CONFIG_UUID_BASE + "50554c4c4559", properties: ["read", "write", "writeWithoutResponse", "notify"] },
            beltPitch: { uuid: LITE_CONFIG_UUID_BASE + "425049544348", properties: ["read", "write", "writeWithoutResponse", "notify"] },
            currentSensorLimit: { uuid: LITE_CONFIG_UUID_BASE + "53656e736f72", properties: ["read", "write", "writeWithoutResponse", "notify"] },
            speedCurve: { uuid: LITE_CONFIG_UUID_BASE + "537064437276", properties: ["read", "write", "writeWithoutResponse", "notify"] },
            homingSpeed: { uuid: LITE_CONFIG_UUID_BASE + "537064486f6d", properties: ["read", "write", "writeWithoutResponse", "notify"] }
        }
    },
    common: {
        serviceUuid: "055E",
        characteristics: {
            speed: { uuid: LITE_COMMON_UUID_BASE_1 + "005370656564", properties: ["read", "write", "writeWithoutResponse", "notify"] },
            maxDepth: { uuid: LITE_COMMON_UUID_BASE_1 + "4d6178446570", properties: ["read", "write", "writeWithoutResponse", "notify"] },
            minDepth: { uuid: LITE_COMMON_UUID_BASE_1 + "4d696e446570", properties: ["read", "write", "writeWithoutResponse", "notify"] },
            streamInput: { uuid: LITE_COMMON_UUID_BASE_1 + "53747265616D", properties: ["read", "write", "writeWithoutResponse", "notify"] },
            targetPosition: { uuid: LITE_COMMON_UUID_BASE_2 + "6f6e546178", properties: ["read", "notify"] },
            currentPosition: { uuid: LITE_COMMON_UUID_BASE_2 + "6f6e63757272", properties: ["read", "notify"] },
            sensation: { uuid: LITE_COMMON_UUID_BASE_3 + "536174696f6e", properties: ["read", "write", "writeWithoutResponse", "notify"] },
            pattern: { uuid: LITE_COMMON_UUID_BASE_3 + "50617465726e", properties: ["read", "write", "writeWithoutResponse", "notify"] },
            patternOptions: { uuid: LITE_COMMON_UUID_BASE_3 + "5061744c7374", properties: ["read", "write"] }
        }
    }
} as const satisfies {
    [key: string]: {
        serviceUuid: string;
        characteristics: {
            [charKey: string]: {
                uuid: string;
                properties: readonly ("read" | "write" | "writeWithoutResponse" | "notify")[];
            };
        };
    };
};

type OssmLiteGatts = {
    [S in keyof typeof OSSM_LITE_BLE_SPEC]: {
        [C in keyof (typeof OSSM_LITE_BLE_SPEC)[S]["characteristics"]]: BluetoothRemoteGATTCharacteristic;
    }
};

type OssmLiteCharacteristicKey = {
    [S in keyof typeof OSSM_LITE_BLE_SPEC]: {
        [C in keyof typeof OSSM_LITE_BLE_SPEC[S]["characteristics"]]: `${S & string}/${C & string}`;
    }[keyof typeof OSSM_LITE_BLE_SPEC[S]["characteristics"]];
}[keyof typeof OSSM_LITE_BLE_SPEC];

export class OssmLiteClient extends BleConnectionHandler {
    static async pairDevice(): Promise<OssmLiteClient> {
        const bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: "OSSM" }],
            optionalServices: []
        });
        return new OssmLiteClient(bleDevice);
    }

    protected readonly _enc = new TextEncoder();
    protected readonly _dec = new TextDecoder();
    readonly #onCharacteristicValueChangedSignature = this.#onCharacteristicValueChanged.bind(this);
    #defaultTimeoutMs = 6000;
    #characteristics = {} as OssmLiteGatts;
    #characteristicGattMap = new Map<BluetoothRemoteGATTCharacteristic, OssmLiteCharacteristicKey>();

    get defaultTimeoutMs(): number | null { return this.#defaultTimeoutMs == -1 ? null : this.#defaultTimeoutMs; }
    set defaultTimeoutMs(value: number) {
        if (value < -1 || Number.isNaN(value))
            throw new DOMException("Value must be a positive integer or -1");
        this.#defaultTimeoutMs = value;
    }

    protected async _setupServicesAndCharacteristics(gatt: BluetoothRemoteGATTServer): Promise<void> {
        this.#characteristics = {} as OssmLiteGatts;
        this.#characteristicGattMap.clear();

        for (const [serviceKey, serviceSpec] of Object.entries(OSSM_LITE_BLE_SPEC)) {
            const gattService = await gatt.getPrimaryService(serviceSpec.serviceUuid);
            const deviceChars = new Map((await gattService.getCharacteristics()).map(c => [c.uuid.toLowerCase(), c]));

            const serviceCharsObj = {} as Record<string, BluetoothRemoteGATTCharacteristic>;

            for (const [charKey, charSpec] of Object.entries(serviceSpec.characteristics)) {
                const char = deviceChars.get(charSpec.uuid.toLowerCase());

                if (!char)
                    throw new DOMException(`[OssmLiteClient] Characteristic ${charKey} not found`, "NotFoundError");

                const metaHasNotify = charSpec.properties.includes("notify");
                const charHasNotify = char.properties.notify || char.properties.indicate;

                serviceCharsObj[charKey] = char;
                this.#characteristicGattMap.set(char, `${serviceKey}/${charKey}` as OssmLiteCharacteristicKey);

                if (metaHasNotify && charHasNotify) {
                    char.addEventListener("characteristicvaluechanged", this.#onCharacteristicValueChangedSignature);
                    await char.startNotifications();
                }
            }

            (this.#characteristics as Record<string, any>)[serviceKey] = serviceCharsObj;
        }
    }

    #onCharacteristicValueChanged(event: Event) {
        if (!event.target) return;
        const target = event.target as BluetoothRemoteGATTCharacteristic

        const key = this.#characteristicGattMap.get(target);
        if (!key) return;

        // TODO: Handle notifications
    }

    // #region Common
    getSpeed(ct?: ICancellationToken): Promise<number> {
        return this.#read(this.#characteristics.common.speed, Number.parseFloat, ct);
    }
    setSpeed(speed: number, ct?: ICancellationToken): Promise<void> {
        enforceRange(speed, 0, 100);
        return this.#fastWrite(this.#characteristics.common.speed, speed, ct);
    }
    
    getMaxDepth(ct?: ICancellationToken): Promise<number> {
        return this.#read(this.#characteristics.common.maxDepth, Number.parseFloat, ct);
    }
    setMaxDepth(maxDepth: number, ct?: ICancellationToken): Promise<void> {
        enforceRange(maxDepth, 0, 100);
        return this.#fastWrite(this.#characteristics.common.maxDepth, maxDepth, ct);
    }

    getMinDepth(ct?: ICancellationToken): Promise<number> {
        return this.#read(this.#characteristics.common.minDepth, Number.parseFloat, ct);
    }
    setMinDepth(minDepth: number, ct?: ICancellationToken): Promise<void> {
        enforceRange(minDepth, 0, 100);
        return this.#fastWrite(this.#characteristics.common.minDepth, minDepth, ct);
    }

    async getStreamInput(ct?: ICancellationToken): Promise<{position: number, duration: number}> {
        const [position, duration] = (await this.#read(this.#characteristics.common.streamInput, ct)).split(":", 2);
        return {
            position: Number.parseFloat(position),
            duration: Number.parseFloat(duration)
        };
    }
    setStreamInput(position: number, duration: number, ct?: ICancellationToken): Promise<void> {
        enforceRange(position, 0, 100, "Position must be between 0 and 100");
        return this.#fastWrite(this.#characteristics.common.streamInput, `${position}:${duration}`, ct);
    }

    getSensation(ct?: ICancellationToken): Promise<number> {
        return this.#read(this.#characteristics.common.sensation, Number.parseFloat, ct);
    }
    setSensation(sensation: number, ct?: ICancellationToken): Promise<void> {
        enforceRange(sensation, 0, 100);
        return this.#fastWrite(this.#characteristics.common.sensation, sensation, ct);
    }

    getPattern(ct?: ICancellationToken): Promise<number> {
        return this.#read(this.#characteristics.common.pattern, Number.parseFloat, ct);
    }
    setPattern(pattern: number, ct?: ICancellationToken): Promise<void> {
        if (Number.isInteger(pattern)) throw new DOMException("Pattern index must be an integer", "IndexSizeError");
        enforceRange(pattern, 0, Number.MAX_SAFE_INTEGER, "Pattern index must be positive");
        return this.#fastWrite(this.#characteristics.common.pattern, pattern, ct);
    }

    async *getPatterns(ct?: ICancellationToken): AsyncGenerator<OssmSchema.OssmPattern, void, unknown> {
        const cts = !ct && this.defaultTimeoutMs ? CancellationTokenSource.createWithTimeout(this.defaultTimeoutMs) : undefined;
        ct = ct ?? cts?.token ?? CancellationToken.None;

        let idx = 0;
        while (true) {
            // Write patten index to fetch then read it back
            const payload = this._enc.encode(idx.toString());
            const valueStr = this._dec.decode(await this._taskQueue.enqueue(async () => {
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
    #fastWrite(char: BluetoothRemoteGATTCharacteristic, val: string | number, ct?: ICancellationToken): Promise<void> {
        const cts = !ct && this.defaultTimeoutMs ? CancellationTokenSource.createWithTimeout(this.defaultTimeoutMs) : undefined;
        ct = ct ?? cts?.token ?? CancellationToken.None;

        const buf = this._enc.encode(val === "string" ? val : (val as number).toString());
        return this._taskQueue.enqueue(() => char.writeValueWithoutResponse(buf), ct);
    }

    #read(char: BluetoothRemoteGATTCharacteristic, ct?: ICancellationToken): Promise<string>;
    #read<T>(char: BluetoothRemoteGATTCharacteristic, parser: (value: string) => T, ct?: ICancellationToken): Promise<T>;
    async #read<T>(char: BluetoothRemoteGATTCharacteristic, parserOrCt?: ((value: string) => T) | ICancellationToken, ct?: ICancellationToken): Promise<any> {
        let cancellationToken: ICancellationToken | undefined;
        let parser: ((value: string) => T) | undefined;
        if (typeof parserOrCt === "function") {
            parser = parserOrCt;
            cancellationToken = ct;
        } else {
            cancellationToken = parserOrCt;
            parser = undefined;
        }

        const cts = !cancellationToken && this.defaultTimeoutMs ? CancellationTokenSource.createWithTimeout(this.defaultTimeoutMs) : undefined;
        cancellationToken = cancellationToken ?? cts?.token ?? CancellationToken.None;

        const response = this._dec.decode(await this._taskQueue.enqueue(() => char.readValue(), cancellationToken));
        return parser ? parser(response) : (response as unknown as T);
    }
    // #endregion
}
