import { BleConnectionHandler, GattServiceDefinition } from "./BleConnectionHandler";
import { AutoLease, RadLease, SimpleLease } from "./RadLease";
import * as Schema from "./RadProtocolSchema";
import crc32 from "crc-32";
import { SingleEvent, SingleEventSource } from "./SingleEvent";
import { AsyncFunctionQueue } from "./AsyncFunctionQueue";

// #region Rad ble api metadata
// Pulled from https://github.com/researchanddesire/rad-ble/blob/main/protocol/rad-ble-v1.json
const RAD_CHARACTERISTICS_SPEC = {
    PROTOCOL_INFO: { suffix: "0002", required: true, properties: ["read"], encoding: "json" },
    CATALOG: { suffix: "0003", required: true, properties: ["read"], encoding: "json" },
    DEVICE_NAME: { suffix: "0004", required: true, properties: ["read", "write", "notify"], encoding: "json" },
    DEVICE_IDENTITY: { suffix: "0005", required: true, properties: ["read"], encoding: "json" },
    REQUEST: { suffix: "1000", required: true, properties: ["write", "writeWithoutResponse"], encoding: "json" },
    RESPONSE: { suffix: "1100", required: true, properties: ["read", "indicate"], encoding: "json" },
    STATE: { suffix: "2000", required: true, properties: ["read", "notify"], encoding: "json", surface: "state" },
    ESSENTIAL_STATE: { suffix: "2010", required: true, properties: ["read", "notify"], encoding: "json", surface: "essential" },
    EVENT: { suffix: "2100", required: true, properties: ["read", "notify"], encoding: "json" },
    SENSOR_STREAM: { suffix: "2300", required: false, channel: "sensorStream", properties: ["read", "notify"], encoding: "binary" },
    BUTTON: { suffix: "3000", required: false, channel: "button", properties: ["read", "write", "notify"], encoding: "json", surface: "button" },
    ENCODER: { suffix: "3010", required: false, channel: "encoder", properties: ["read", "write", "notify"], encoding: "json", surface: "encoder" },
    IMU: { suffix: "3100", required: false, channel: "imu", properties: ["read", "notify"], encoding: "json", surface: "imu" },
    POWER: { suffix: "3110", required: false, channel: "power", properties: ["read", "notify"], encoding: "json", surface: "power" },
    ANALOG: { suffix: "3120", required: false, channel: "analog", properties: ["read", "notify"], encoding: "json", surface: "analog" },
    MAGNETIC: { suffix: "3130", required: false, channel: "magnetic", properties: ["read", "notify"], encoding: "json", surface: "magnetic" },
    MOTION: { suffix: "3140", required: false, channel: "motion", properties: ["read", "notify"], encoding: "json", surface: "motion" },
    CONNECTIVITY: { suffix: "3150", required: false, channel: "connectivity", properties: ["read", "notify"], encoding: "json", surface: "connectivity" },
    INDICATOR: { suffix: "4000", required: false, channel: "indicator", properties: ["read", "write", "notify"], encoding: "json", surface: "indicator" },
    HAPTIC: { suffix: "4010", required: false, channel: "haptic", properties: ["read", "write", "notify"], encoding: "json", surface: "haptic" },
    AUDIO: { suffix: "4020", required: false, channel: "audio", properties: ["read", "write", "notify"], encoding: "json", surface: "audio" },
    DISPLAY: { suffix: "4030", required: false, channel: "display", properties: ["read", "write", "notify"], encoding: "json", surface: "display" },
    OTA_CONTROL: { suffix: "5000", required: false, channel: "applicationOta", properties: ["read", "write", "indicate"], encoding: "json" },
    OTA_DATA: { suffix: "5010", required: false, channel: "applicationOta", properties: ["write", "writeWithoutResponse"], encoding: "binary" },
    OTA_STATUS: { suffix: "5020", required: false, channel: "applicationOta", properties: ["read", "notify"], encoding: "json" }
} as const;

// voodoo magic shit (reused from old project, I'm not gonna pretend like I know how this works)
type SnakeToCamelCase<S extends string> = S extends `${infer Head}_${infer Tail}`
    ? `${Lowercase<Head>}${Capitalize<SnakeToCamelCase<Tail>>}`
    : Lowercase<S>;

type RawSpecKey = keyof typeof RAD_CHARACTERISTICS_SPEC;
type RadCharacteristicKey = SnakeToCamelCase<RawSpecKey>;

// Derived Union of keys that are mandatory vs optional on hardware
type RadRequiredCharacteristicKey = {
    [K in RawSpecKey]: typeof RAD_CHARACTERISTICS_SPEC[K]["required"] extends true ? SnakeToCamelCase<K> : never;
}[RawSpecKey];

type RadOptionalCharacteristicKey = Exclude<RadCharacteristicKey, RadRequiredCharacteristicKey>;

// Maps required characteristics as mandatory properties, and optional ones as optional properties
type RadCharacteristicGatts = {
    [K in RadRequiredCharacteristicKey]: BluetoothRemoteGATTCharacteristic;
} & {
    [K in RadOptionalCharacteristicKey]?: BluetoothRemoteGATTCharacteristic;
};

// Filter for notifiable properties
type RadNotifiableCharacteristicKey = {
    [K in RawSpecKey]: 
        "notify" extends typeof RAD_CHARACTERISTICS_SPEC[K]["properties"][number] ? SnakeToCamelCase<K> :
        "indicate" extends typeof RAD_CHARACTERISTICS_SPEC[K]["properties"][number] ? SnakeToCamelCase<K> :
        never;
}[RawSpecKey];

type RadTelemetryObjType<OWNED extends boolean = false> = {
    [K in RadNotifiableCharacteristicKey]:
        OWNED extends true ? SingleEventSource<[GattValue]> : SingleEvent<[GattValue]>
};
// #endregion

type GattValue = DataView | undefined;

interface ResolveReject<T = void> {
    resolve: (v: T) => void;
    reject: (e: Error) => void;
}

interface ResolveRejectTimer<T = void> extends ResolveReject<T> {
    timer: number;
}

/**
 * Generic RAD BLE API handler. Handles the RAD protocol over BLE, and it's common calls
 */
export class RadBleApi extends BleConnectionHandler {
    readonly #handleIncomingTelemetrySignature = this.#handleIncomingTelemetry.bind(this);
    readonly #radServiceUuid: Readonly<string>;
    #radCharacteristics: RadCharacteristicGatts = {} as RadCharacteristicGatts;
    #radCharacteristicGattMap: Map<BluetoothRemoteGATTCharacteristic, RadCharacteristicKey> = new Map();
    /** A map of all the requests that are currently being processed */
    #defaultTimeoutMs = 6000;
    #requests = {
        nextId: 1,
        pending: new Map<number, ResolveRejectTimer<Schema.RadResponse>>()
    }
    #activeStream: Schema.RadStreamResult | null = null;
    readonly #pendingSnapshots = {
        /** Holds the stream that the snapshot manager is currently waiting on */
        activeStream: null as { id: number; surface: string; } | null,
        /** Keeps track of pending snapshot requests */
        pendingSurfaces: new Map<string, Set<ResolveRejectTimer<unknown>>>(),
        /** Keeps track of the function that will activate a stream for a given surface */
        streamActivators: new Map<string, {
            expiresAt: number,
            promise: ResolveReject,
            signature: Function
        }>(),
        /** Processes snapshot requests in order of surface request */
        streamActivatorQueue: new AsyncFunctionQueue(),
        /** Stores handled stream ids that may send transient responses for a short while ) */
        transientStreamIds: new Set<number>()
    };

    protected readonly _enc = new TextEncoder();
    protected readonly _dec = new TextDecoder();
    protected get _radService(): RadCharacteristicGatts { return this.#radCharacteristics; }
    protected readonly _onRadTelemetry: Readonly<RadTelemetryObjType<true>>;

    lease: RadLease | null = null;
    get onRadTelemetry(): Readonly<RadTelemetryObjType<false>> { return this._onRadTelemetry; }
    get activeStream(): Schema.RadStreamResult | null { return this.#activeStream; }
    get defaultTimeoutMs() { return this.#defaultTimeoutMs; }
    set defaultTimeoutMs(value: number) {
        if (value <= 0 || Number.isNaN(value))
            throw new DOMException("Value must be a positive integer");
        this.#defaultTimeoutMs = value;
    }

    // #region BLE lifecycle
    constructor(serviceUuid: string, device: BluetoothDevice) {
        super(device);

        // Split the UUID into parts so we can build the RAD characteristic UUIDs
        this.#radServiceUuid = serviceUuid;
        if (serviceUuid.split("-").length !== 5)
            throw new DOMException(`Invalid service UUID: ${serviceUuid}`, "InvalidStateError");

        const notifier = {} as RadTelemetryObjType<true>;
        for (const [rawKey, spec] of Object.entries(RAD_CHARACTERISTICS_SPEC))
            if (spec.properties.some(p => p === "notify" || p === "indicate"))
                notifier[this.#snakeCaseToCamelCase(rawKey) as RadNotifiableCharacteristicKey] = new SingleEventSource<[GattValue]>();
        this._onRadTelemetry = notifier;
    }

    /**
     * Sets up the RAD BLE service and its characteristics, and starts notifications for the relevant channels. This is called automatically during the connection process
     */
    protected async _setupServicesAndCharacteristics(gatt: BluetoothRemoteGATTServer): Promise<void> {
        this.#radCharacteristics = {} as RadCharacteristicGatts;
        this.#radCharacteristicGattMap.clear();

        const gattService = await gatt.getPrimaryService(this.#radServiceUuid);
        const uuidParts = this.#radServiceUuid.split("-");

        // Iterate over the spec entries for full metadata access
        const entries = Object.entries(RAD_CHARACTERISTICS_SPEC).map(([rawKey, spec]) => [
            this.#snakeCaseToCamelCase(rawKey) as RadCharacteristicKey, // Convert the runtime string into camelCase
            spec
        ] as const);

        for (const [key, spec] of entries) {
            const charUuid = `${uuidParts[0]}-${uuidParts[1]}-${uuidParts[2]}-${spec.suffix}-${uuidParts[4]}`;

            try {
                const char = await gattService.getCharacteristic(charUuid);

                // Ensure that the char matches the expected notification type (either notify/indicate or none)
                const metaHasNotifyOrIndicate = spec.properties.some(p => p === "notify" || p === "indicate");
                const charHasNotifyOrIndicate = char.properties.notify || char.properties.indicate;
                if (metaHasNotifyOrIndicate && !charHasNotifyOrIndicate) {
                    /* It seems that, at least from testing against Ossm firmware, the spec doesn't always match the device...
                     * So instead of failing outright, if it was an optional property that failed, warn instead
                     */
                    const message = `[RadBleApi] ${spec.required ? 'Required' : 'Optional'} characteristic ${key} was expected to support notify/indicate`
                    if (spec.required)
                        throw new DOMException(message, "NotSupportedError");
                    else if (this.debug)
                        console.warn(message)
                }

                this.#radCharacteristics[key] = char;
                this.#radCharacteristicGattMap.set(char, key);

                if (charHasNotifyOrIndicate) {
                    char.addEventListener("characteristicvaluechanged", this.#handleIncomingTelemetrySignature);
                    char.startNotifications();
                }

            } catch (err) {
                if (err instanceof DOMException && err.name === "NotFoundError") {
                    if (spec.required)
                        throw new DOMException(`[RadBleApi] Characteristic ${key} was required but not found`, "NotFoundError");

                    if (this.debug)
                        console.warn(`[RadBleApi] Optional characteristic ${key} was not present on the target device`)
                } else {
                    // Re-throw error if it wasn't expected
                    throw err;
                }
            }
        }

        // Validate protocol
        const info = this.#parseValueAsJson<Schema.RadProtocolInfo>(
            await this._taskQueue.enqueue(() => this._radService.protocolInfo!.readValue()));
        if (!info || info?.protocol !== "rad-ble" || info?.version !== 1)
            throw new DOMException(`Unexpected protocol info: ${JSON.stringify(info)}`, "NotSupportedError");
    }

    /**
     * Called before disconnecting. Cleans up any resources that were allocated during the connection
     */
    protected override async _onBeforeDisconnect(): Promise<void> {
        for (const characteristic of Object.values(this.#radCharacteristics))
            if (characteristic.properties.notify || characteristic.properties.read)
                characteristic.removeEventListener("characteristicvaluechanged", this.#handleIncomingTelemetrySignature);
    }

    /**
     * Invalidates the stored RAD service
     */
    protected override async _onDisconnected(wasConnected: boolean): Promise<void> {
        this.#radCharacteristics = {} as RadCharacteristicGatts;
        this.#radCharacteristicGattMap.clear();

        this.#activeStream = null;
        this.#pendingSnapshots.activeStream = null;

        // If we are auto-reconnecting we shouldn't discard pending requests since they may still be resolved if we reconnect in time
        if (this.autoReconnect)
            return;

        const disconnectError = new DOMException("Device disconnected", "NetworkError");

        for (const request of this.#requests.pending.values()) {
            if (!Number.isNaN(request.timer))
                window.clearTimeout(request.timer);
            request.reject(disconnectError);
        }
        this.#requests.pending.clear();

        for (const pendingSet of this.#pendingSnapshots.pendingSurfaces.values()) {
            for (const handler of pendingSet) {
                if (!Number.isNaN(handler.timer))
                    window.clearTimeout(handler.timer);
                handler.reject(disconnectError);
            }
        }
        this.#pendingSnapshots.pendingSurfaces.clear();

        for (const activator of this.#pendingSnapshots.streamActivators.values())
            activator.promise.reject(disconnectError);
        this.#pendingSnapshots.streamActivators.clear();
    }
    // #endregion

    // #region RAD request/response handling
    /**
     * Sends a RAD request to the device and waits for a response
     * @param req The request object to send. Must satisfy {@link RadRequest}
     * @param lease Optional lease to include in the request. If the request requires a lease, this must be provided otherwise the request will fail. Use {@link acquireLease} to obtain a lease.
     * @param timeoutMs Optional timeout in milliseconds to wait for a response before rejecting. Defaults to {@link defaultTimeoutMs}
     * @returns A promise that resolves to {@link RadResponse} containing the response data
     */
    async send<T = unknown>(
        req: Omit<Schema.RadRequest, "v" | "id" | "lease">,
        lease?: number | RadLease,
        timeoutMs?: number,
        isPriority: boolean = false
    ): Promise<Schema.RadResponse<T>> {
        if (!timeoutMs) timeoutMs = this.defaultTimeoutMs;

        const id = this.#requests.nextId++;
        const request: Schema.RadRequest = { v: 1, id, ...req };

        let payload: () => BufferSource;
        /* If a lease is specified and it is a typeof RadLease then don't stringify the request until it is made
         * We should wait because if we stringify too early we may encode an expired token
         * The downside to this is it means if the JSON fails to encode then we won't catch it as early
         * (This isn't strictly needed since the token doesn't change between renewals, but I will leave it here as future proofing)
         * 
         * If the lease isn't specified or it is a plain number then encode it before queuing the ble action
         * We do this because it saves cycles inside the queue
         */
        if (lease instanceof RadLease) {
            if (lease.isExpired)
                throw new DOMException("Cannot send RAD request with expired lease", "InvalidStateError");
            request.lease = lease.token!;
            payload = () => this._enc.encode(JSON.stringify(request));
        } else {
            request.lease = lease;
            const payloadBuf = this._enc.encode(JSON.stringify(request));
            payload = () => payloadBuf;
        }

        // Request gets resolved inside #onRequest
        const result = await new Promise<Schema.RadResponse<T>>((resolve, reject) => {
            const timer = window.setTimeout(() => {
                this.#requests.pending.delete(id);
                reject(new DOMException(`RAD request timeout (id=${id}, op=${req.op})`, "TimeoutError"));
            }, timeoutMs);

            this.#requests.pending.set(id, { resolve: resolve as any, reject, timer });

            const func = async () => {
                // Check that the request hasn't been aborted
                if (!this.#requests.pending.has(id)) return;

                // Ensure the state is valid to make the ble call
                this._requireRadCharacteristic("request");
                await this._radService.request!.writeValueWithoutResponse(payload());

            };
            const queuedItem = isPriority
                ? this._taskQueue.prepend(func, timeoutMs)
                : this._taskQueue.enqueue(func, timeoutMs);
            queuedItem.catch(err => {
                window.clearTimeout(timer);
                this.#requests.pending.delete(id);
                reject(err);
            });
        });

        if (!result.ok || result.stage === "failed")
            throw new DOMException(`RAD request failed (id=${id}, op=${req.op}): ${result.code ?? "unknown"} - ${result.message ?? "no message"}`, "Error");
        return result;
    }

    /**
     * Sends a request and returns the result, throwing an error if the result is missing.
     * @param req The request to send
     * @param lease The lease to use, if any
     * @param timeoutMs The timeout in milliseconds, if any
     * @returns A promise resolving to the result of the request
     */
    async sendWithResult<T = unknown>(
        req: Omit<Schema.RadRequest, "v" | "id" | "lease">,
        lease?: number | RadLease,
        timeoutMs?: number,
        isPriority?: boolean
    ): Promise<T> {
        return this.send<T>(req, lease, timeoutMs, isPriority).then(res => {
            if (!res.result)
                throw new DOMException("RAD request returned no result", "DataError");
            return res.result;
        });
    }

    #handleIncomingTelemetry(event: Event) {
        if (!event.target) return;
        const target = event.target as BluetoothRemoteGATTCharacteristic
        const key = this.#radCharacteristicGattMap.get(target);
        if (!key) return;

        let handled = false;
        switch (key) {
            case "response":
                handled = this.#onResponse(target.value);
                break;
            case "sensorStream":
                handled = this.#onStream(target.value);
                break;
            default:
                /* Certain snapshots are sent out periodically, but I think they are mostly left down to the abstract implementation
                * So I won't write blocks for all of them in here
                * https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L820
                */
                break;
        }

        if (!handled) {
            // 'key' should always be 'RadNotifiableCharacteristicKey' here
            this._onRadTelemetry[key as RadNotifiableCharacteristicKey].dispatch(target.value);
        }
    }

    /**
     * Handles incoming RAD responses from the device and either rejects or resolves pending requests
     */
    #onResponse(dataView: GattValue): boolean {
        /* I bless Copilot for helping my find the core of how this RAD API works (namely around the request/response handling)
        * There are NO ossm docs for this and the firmware source code is frankly a steaming pile of shit x3
        * https://github.com/researchanddesire/rad-ble/blob/main/src/RadBleProtocol.generated.h
        * There are other characteristics defined in the schema but we either don't need them
        * or a lot of them point to the same method handler inside the firmware (so we can just reuse request/response)
        */

        if (!dataView) return false;
        let msg: Schema.RadResponse;
        try { msg = this.#parseValueAsJson<Schema.RadResponse>(dataView); }
        catch { return false; }
        this._debugLog("RAD response received:", msg);
        if (!this.#requests.pending.has(msg.id)) return false;

        const p = this.#requests.pending.get(msg.id)!;
        if (!p) return false;

        // RAD can emit accepted + completed; only resolve on terminal stages
        switch (msg.stage) {
            case "failed": {
                window.clearTimeout(p.timer);
                this.#requests.pending.delete(msg.id);
                p.reject(new DOMException(`RAD request failed (id=${msg.id}, op=${msg.stage}): ${msg.code ?? "unknown"} - ${msg.message ?? "no message"}`, "Error"));
                return true;
            }
            case "completed": {
                window.clearTimeout(p.timer);
                this.#requests.pending.delete(msg.id);
                p.resolve(msg);
                return true;
            }
            default: break;
        }

        return false;
    }

    #onStream(dataView: GattValue): boolean {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1938
        const STREAM_HEADER_BYTES = 20;

        if (!dataView || dataView.byteLength <= STREAM_HEADER_BYTES) return false;

        const streamId = dataView.getUint8(1);

        /* After a stream has been handled, due to the round-trip-time on stopping a stream/starting a new one
         * old streams may (and in testing, will) send a few more results.
         * To avoid leaking these streams out to the generic event dispatcher we will capture them here and silently discard them
         */
        if (this.#pendingSnapshots.transientStreamIds.has(streamId))
            return true;

        // If no stream is active or the frame doesn't match our active stream ID, ignore
        if (!this.#pendingSnapshots || this.#pendingSnapshots.activeStream?.id !== streamId) return false;

        const surface = this.#pendingSnapshots.activeStream.surface;
        const pendingSet = this.#pendingSnapshots.pendingSurfaces.get(surface);
        if (!pendingSet || pendingSet.size === 0) return false;

        // See comment above about handled/transient streams
        this.#pendingSnapshots.transientStreamIds.add(streamId);
        window.setTimeout(() => this.#pendingSnapshots.transientStreamIds.delete(streamId), 500);

        // Extract all handlers and immediately clean up state so other pending requests can continue
        const handlers = Array.from(pendingSet);
        this.#pendingSnapshots.pendingSurfaces.delete(surface);
        // Resolve the activator so it can process the next item in the queue
        this.#pendingSnapshots.streamActivators.get(surface)?.promise.resolve();

        // Parse the value
        let value: unknown;
        try {
            value = this.#parseValueAsJson(new Uint8Array(
                // Get payload value part
                dataView.buffer,
                dataView.byteOffset + STREAM_HEADER_BYTES,
                dataView.byteLength - STREAM_HEADER_BYTES
            ));
        }
        catch (err) {
            for (const handler of handlers) {
                window.clearTimeout(handler.timer);
                handler.reject(err as Error);
            }
            return false;
        }

        // Resolve pending targets with the value
        for (const handler of handlers) {
            window.clearTimeout(handler.timer);
            handler.resolve(value);
        }

        return true;
    }
    // #endregion

    // #region RAD API methods
    /**
     * Acquires a lease from the device, which is required for certain operations that modify state
     * The lease token is valid for a limited time and must be renewed or released when no longer needed
     * @param autoRenew Whether the lease should automatically renew at 60% TTL and recover from disconnects. Defaults to false
     * @param ttlSeconds The time-to-live for the lease in seconds. Defaults to 10 seconds
     * @param store Whether to store the acquired lease in the `lease` property of this instance. Defaults to true
     * @returns A promise that resolves to a {@link RadLease} object representing the acquired lease
     * @throws OperationError if the lease acquisition fails
     */
    async acquireLease(autoRenew = false, ttlSeconds = 10, store = true): Promise<SimpleLease | AutoLease> {
        let lease: SimpleLease | AutoLease;

        if (autoRenew) {
            const autoLease = new AutoLease(this, ttlSeconds);
            await autoLease.start();
            lease = autoLease;
        } else {
            const simpleLease = new SimpleLease(this, ttlSeconds);
            await simpleLease.acquire();
            lease = simpleLease;
        }

        if (store)
            this.lease = lease;

        return lease;
    }

    async getDeviceCapabilities(timeoutMs?: number): Promise<Schema.RadProtocolInfoCompact> {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L996
        return this.sendWithResult<Schema.RadProtocolInfoCompact>({ op: "device.capabilities" }, undefined, timeoutMs);
    }

    async getOtaCapabilities(timeoutMs?: number): Promise<Schema.RadOtaCapabilities> {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1002
        return this.sendWithResult<Schema.RadOtaCapabilities>({ op: "ota.capabilities" }, undefined, timeoutMs);
    }

    /**
     * Streams catalog entries from the device page by page, yielding entries individually
     * @throws DataError if the catalog response is malformed or missing data
     */
    async *getCatalog(timeoutMsPerPage?: number): AsyncGenerator<Schema.RadCatalogEntry, void, unknown> {
        let page = 0;
        while (true) {
            // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1031
            const res = await this.sendWithResult<Schema.RadCatalogPage>({ op: "catalog.read", args: { page } }, undefined, timeoutMsPerPage);

            // Yield each resource in the page
            yield* res.resources;

            if (page >= res.pages - 1)
                break;

            page++;
        }
    }

    async getStateSnapshot(timeoutMs?: number): Promise<Schema.RadState> {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1041
        return this.sendWithResult<Schema.RadState>({ op: "state.read" }, undefined, timeoutMs);
    }

    async readSensor<T = unknown>(path: string, timeoutMs?: number, isPriority?: boolean): Promise<T> {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1052
        return this.sendWithResult<T>({ op: "sensor.read", path }, undefined, timeoutMs, isPriority);
    }

    async getEssentialSnapshot(timeoutMs?: number): Promise<unknown> {
        // Only essential.live is operated upon in the base RAD firmware, but that still calls out to the snapshot handler for an unknown compile time response, so for now I will leave this as T = unknown and let the caller handle the type
        return this.readSensor<unknown>("essential.live", timeoutMs);
    }

    async getConnectivitySnapshot(timeoutMs?: number): Promise<unknown> {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1061
        // This also calls out to a Surface:: and has no default handler, so return type is unknown here
        return this.sendWithResult({ op: "wifi.status" }, undefined, timeoutMs);
    }

    /**
     * @note
     * Calls out to the snapshot handler implementation in the firmware.
     * Extended classes should shadow shadow this with getSnapshot* calls for their own snapshot types.
     * Surfaces allowed: Indicator, Haptic, Audio, Display
     * See https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1495
     */
    async readOutput<T = unknown>(path: string, timeoutMs?: number, isPriority?: boolean): Promise<T> {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1069
        // Calls a dynamic snapshot surface handler, type is unknown
        return this.sendWithResult<T>({ op: "output.read", path }, undefined, timeoutMs, isPriority);
    }

    async readSensorMany<T = unknown>(paths: string[], timeoutMs?: number, isPriority?: boolean): Promise<Schema.RadSensorReadManyEntry<T>[]> {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1095
        return this.sendWithResult<Schema.RadSensorReadManyEntry<T>[]>({ op: "sensor.readMany", args: { paths } }, undefined, timeoutMs, isPriority);
    }

    /**
     * Starts a stream of data from the device
     * @param path Path to stream
     * @param rateHz Rate in Hz to stream at. If omitted, the device will use its default rate for the stream
     * @requires A valid lease token
     */
    async startStream(path: string, rateHz?: number, timeoutMs?: number): Promise<Schema.RadStreamResult> {
        this._requireLease();

        if (this.activeStream)
            throw new DOMException("An existing stream is already active, call stopStream first", "InvalidStateError");
        
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1569
        const result = await this.sendWithResult<Schema.RadStreamResult>({
            op: "stream.start",
            path,
            args: {
                rateHz
            }
        }, this.lease!, timeoutMs);

        this.#activeStream = result;

        return result;
    }

    /**
     * Updates the current stream configuration
     * @param path Path to stream, if any. If omitted, the current stream path is used
     * @param rateHz Rate in Hz to stream at. If omitted, the current stream rate is used
     * @returns A promise resolving to the updated stream result
     * @requires A valid lease token
     */
    async updateStream(path?: string, rateHz?: number, timeoutMs?: number): Promise<Schema.RadStreamResult> {
        this._requireLease();

        if (!this.activeStream)
            throw new DOMException("No stream is active, call startStream first", "InvalidStateError");

        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1550
        const result = await this.sendWithResult<Schema.RadStreamResult>({
            op: "stream.update",
            path,
            args: {
                rateHz
            }
        }, this.lease!, timeoutMs); 
        
        this.#activeStream = result;

        return result;
    }

    /**
     * @requires A valid lease token
     */
    async stopStream(timeoutMs?: number): Promise<void> {
        this._requireLease();
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1542
        await this.send({ op: "stream.stop" }, this.lease!, timeoutMs);
        this.#activeStream = null;
    }

    /**
     * Gets a snapshot for a given surface (via path)
     * @param path The property path that is streamable  
     * *Due to quirkiness in how the firmware works, despite streams returning snapshots of entire surfaces, the stream parameter requires the path to a property instead...*
     * @returns A snapshot of the surface that the property belongs to
     */
    async getSnapshot<T>(path: string, timeoutMs?: number): Promise<T> {
        if (!timeoutMs) timeoutMs = this.defaultTimeoutMs;
        const [surface] = path.split(".", 2);

        this._requireLease();

        /**
         * This function works in a three part process:
         * 1. A promise returned to the caller that waits on a snapshot to be received
         * 2. An internal asynchronous command queue to start and stop streams on the remote device that sends data to #onStream
         * 3. #onStream that resolves the promise returned to the caller, this is fired on an incoming stream notification
         */

        // #region (Part 1) Outward facing promise
        // Setup the 'user-facing' promise that we will return
        /* Because this method relies on intercepting stream data and it cleans up the stream instance once data is received, we cannot allow other external streams to run at the same time
         * TODO: Resume the external stream if one was active
         */
        if (this.#activeStream && !this.#pendingSnapshots.activeStream)
            throw new DOMException("getSnapshot cannot be called while an external stream is active", "NotSupportedError");

        const snapshotPromise = new Promise<T>((resolve, reject) => {
            const pendingSurfaceRequest: ResolveRejectTimer<T> = { resolve, reject, timer: Number.NaN }

            pendingSurfaceRequest.timer = window.setTimeout(() => {
                // If we time out waiting for a snapshot, remove self from the pending surfaces
                this.#pendingSnapshots.pendingSurfaces.get(surface)?.delete(pendingSurfaceRequest as ResolveRejectTimer<unknown>);
                reject(new DOMException("getSnapshot timed out", "TimeoutError"));
            }, timeoutMs);

            let pendingSet = this.#pendingSnapshots.pendingSurfaces.get(surface);
            if (!pendingSet) {
                pendingSet = new Set<ResolveRejectTimer<unknown>>();
                this.#pendingSnapshots.pendingSurfaces.set(surface, pendingSet);
            }
            pendingSet.add(pendingSurfaceRequest as ResolveRejectTimer<unknown>);
        });
        // #endregion

        // #region (Part 2) Internal stream manager
        // Setup the internal stream activator
        // On activator fail, if the set activator doesn't match the signature of self, reject all responses
        // On activator success, do nothing as the pendingSurfaces are handled by #onStream
        // On activator finally, remove itself from streamActivators
        const existingActivator = this.#pendingSnapshots.streamActivators.get(surface);
        const expiresAt = Date.now() + timeoutMs;

        /* If no activator exists for the surface if the existing activator will expire before this calls timeout
         * Create a new stream activator
         */
        if (!existingActivator || existingActivator.expiresAt < expiresAt) {
            // Setup the resolvers for the async calls (used to block the queue from continuing until timeout or onStream resolution)
            let resolveActivatorQueueTask!: () => void;
            let rejectActivatorQueueTask!: (err: Error) => void;
            const activatorWaitForPromise = new Promise<void>((resolve, reject) => {
                resolveActivatorQueueTask = resolve;
                rejectActivatorQueueTask = reject;
            });

            const activatorTask = async () => {
                // Don't activate a stream if nothing is waiting on it
                const pendingSet = this.#pendingSnapshots.pendingSurfaces.get(surface);
                if (!pendingSet || pendingSet.size == 0) return;

                let streamInstance: Schema.RadStreamResult | null = null;

                // If this task fails the queuedActivatorPromise.catch will handle cleanup
                try {
                    /* Set the stream rate to the max allowed for the fastest response (100hz)
                     * See https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.h#1576
                     */
                    // Not using updateStream here since we want to generate a new ID for the request
                    streamInstance = await this.startStream(path, 100, expiresAt - Date.now());
                    this.#pendingSnapshots.activeStream = { id: streamInstance.streamId, surface: surface };
                    
                    // Keep this function blocked until #onStream resolve it or it times out
                    await activatorWaitForPromise;
                } finally {
                    /* End the stream that was started for this task (this is allowed to throw)
                     * We have to dispose of it here since the firmware will reuse the existing stream ID
                     * if a stream is active and a new stream.start is called.
                     * This unfortunately means that there will be a bit more of a delay between calls
                     */
                    try { await this.stopStream(); }
                    catch (e) { console.warn("Failed to stop stream during snapshot cleanup", e); }

                    // Only clear activeStream tracking if it still belongs to this task instance
                    if (this.#pendingSnapshots.activeStream?.id === streamInstance?.streamId)
                        this.#pendingSnapshots.activeStream = null;

                    // Clean up activators when done
                    const currentActivator = this.#pendingSnapshots.streamActivators.get(surface);
                    if (currentActivator && currentActivator.signature === activatorTask)
                        this.#pendingSnapshots.streamActivators.delete(surface);
                }
            };

            // Update the stored activator for this surface
            this.#pendingSnapshots.streamActivators.set(surface, {
                expiresAt,
                signature: activatorTask,
                promise: {
                    resolve: resolveActivatorQueueTask,
                    reject: rejectActivatorQueueTask
                }
            });

            // (Re)place activator task in queue
            let queuedActivatorPromise: Promise<void>;
            if (existingActivator) {
                const error = new DOMException("Replaced by newer snapshot activator with extended timeout", "AbortError");
                existingActivator.promise.reject(error);
                queuedActivatorPromise = this.#pendingSnapshots.streamActivatorQueue.replaceOrEnqueue(
                    existingActivator.signature,
                    activatorTask,
                    error,
                    timeoutMs
                );
            } else {
                queuedActivatorPromise = this.#pendingSnapshots.streamActivatorQueue.enqueue(
                    activatorTask,
                    timeoutMs
                );
            }

            queuedActivatorPromise.catch((err: Error) => {
                /* If a signature was passed and it doesn't match the currently registered activator,
                * it means a newer activator replaced this one—so do NOT delete the new activator state
                */
                const currentActivator = this.#pendingSnapshots.streamActivators.get(surface);
                if (currentActivator && currentActivator.signature !== activatorTask)
                    return;

                const pendingSet = this.#pendingSnapshots.pendingSurfaces.get(surface);
                if (pendingSet) {
                    for (const handler of pendingSet) {
                        window.clearTimeout(handler.timer);
                        handler.reject(err);
                    }
                    this.#pendingSnapshots.pendingSurfaces.delete(surface);
                }
                this.#pendingSnapshots.streamActivators.delete(surface);
            });
        }
        // #endregion

        // (Part 3) -> See #onStream

        return snapshotPromise;
    }

    /**
     * Performs an OTA firmware update on the device
     * @param binaryBuffer The binary data to send to the device
     * @param sha256 Optional SHA256 hash of the binary. If not provided, it will be calculated automatically
     * @param component Optional target partition. Defaults to "application"
     * @param onProgress Optional callback to receive progress updates. Called with the number of bytes sent and the total number of bytes
     * @requires A valid lease token
     * @note **Untested**
     * @note This also discards this RAD API instance
     */
    async performOta(
        binaryBuffer: ArrayBuffer,
        sha256?: string,
        component?: Schema.RadOtaComponent,
        onProgress?: (bytesSent: number, totalBytes: number) => void
    ) {
        if (!sha256) {
            // Calculate SHA256 hash of the binary
            const hashBuffer = await crypto.subtle.digest("SHA-256", binaryBuffer);
            sha256 = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
        }

        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1190
        const beginResult = await this.sendWithResult<Schema.RadOtaBeginResult>({
            op: "ota.begin",
            args: {
                size: binaryBuffer.byteLength,
                sha256,
                component
            }
        }, this.lease!);

        // Transmit data
        try {
            const CHUNK_SIZE = 480;
            let offset = 0;
            while (offset < binaryBuffer.byteLength) {
                const chunk = binaryBuffer.slice(offset, offset + CHUNK_SIZE);
                
                // Frame building (not gonna pretend like I know whats going on here)
                const payloadLen = chunk.byteLength;
                const chunkCrc = crc32.buf(new Uint8Array(chunk)) >>> 0;
                const frameBuffer = new ArrayBuffer(14 + payloadLen);
                const view = new DataView(frameBuffer);

                view.setUint32(0, beginResult.session, true);
                view.setUint32(4, offset, true);
                view.setUint32(8, payloadLen, true);
                view.setUint32(12, chunkCrc, true);

                const frameArray = new Uint8Array(frameBuffer);
                frameArray.set(new Uint8Array(chunk), 14);

                await this._taskQueue.enqueue(async () => {
                    this._requireRadCharacteristic("otaData");
                    await this._radService.otaData!.writeValueWithoutResponse(frameArray);
                });

                onProgress?.(offset, binaryBuffer.byteLength);
                offset += CHUNK_SIZE;

                // Throttle to avoid overwhelming the device (as OTA writes to NVS slow down the device a lot in my testing in other projects)
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        } catch (err) {
            // If an error occurs during the OTA update, attempt to abort the update
            try {
                // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1215
                await this.send({
                    op: "ota.abort",
                    args: {
                        session: beginResult.session
                    }
                }, this.lease!);
            }
            catch { /* Ignore */ }
            throw err;
        }

        // Finish OTA
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1212
        const finishResult = await this.sendWithResult<Schema.RadOtaFinishResult>({
            op: "ota.finish",
            args: {
                session: beginResult.session
            }
        }, this.lease!);

        if (finishResult.sha256 !== sha256)
            throw new DOMException(`OTA update failed: SHA256 mismatch (expected ${sha256}, got ${finishResult.sha256})`, "DataError");

        this.disconnect(); // This instance will be invalidated since the device will reboot at this point
    }

    /**
     * Scans for available WiFi networks
     * @requires A valid lease token
     */
    async wifiScan(timeoutMs?: number): Promise<Schema.RadWiFiScanResult> {
        this._requireLease();
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1606
        const res = await this.sendWithResult<Partial<Schema.RadWiFiScanResult>>({ op: "wifi.scan" }, this.lease!, timeoutMs);

        /* This RAD command returns a success response even if a scan is already in progress.
         * The true success state is at the end of the original request where 'running' is false and the return result is ok
         */
        if (res.running === true)
            throw new DOMException("Another WiFi scan is already in progress", "InvalidStateError");

        return res as Schema.RadWiFiScanResult;
    }

    /**
     * @requires A valid lease token
     */
    async wifiForget(timeoutMs?: number): Promise<void> {
        this._requireLease();
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1705
        await this.send({ op: "wifi.forget" }, this.lease!, timeoutMs);
    }

    /**
     * Configures the device to connect to a WiFi network.
     * @param ssid The SSID of the WiFi network to connect to
     * @param password Optional password for the WiFi network
     * @returns Void when the credentials have been saved and the device has requested to connect. This does not guarantee that the connection was successful, only that the device has accepted the request to connect. Use {@link getConnectivitySnapshot} to check the connection status.
     * @requires A valid lease token
     */
    async wifiConfigure(ssid: string, password?: string, timeoutMs?: number): Promise<void> {
        this._requireLease();
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1711
        await this.send({ op: "wifi.configure", args: { ssid, password } }, this.lease!, timeoutMs);
    }

    /**
     * Restarts the device
     * @requires a valid lease
     * @note This also discards this RAD API instance
     */
    async restartSystem(timeoutMs?: number): Promise<void> {
        this._requireLease();
        this._taskQueue.clearQueue();
        await this.send({ op: "system.restart" }, this.lease!, timeoutMs, true);
        this.disconnect();
    }

    /**
     * Reads a setting from the device
     * @param path The path to the setting to read
     * @returns The value of the setting
     * @requires A valid lease token
     */
    async readSetting<T = unknown>(path: string, timeoutMs?: number, isPriority?: boolean): Promise<T> {
        this._requireLease();
        // Handled by abstract command handler, compile time type is unknown
        return this.sendWithResult<T>({ op: "setting.read", path }, this.lease!, timeoutMs, isPriority);
    }

    /**
     * Writes a setting to the device
     * @param path The path to the setting to write
     * @param value The value to write
     * @returns The value of the setting
     * @requires A valid lease token
     */
    async writeSetting<T = unknown>(path: string, args: Record<string, unknown>, timeoutMs?: number, isPriority?: boolean): Promise<T> {
        this._requireLease();
        // Handled by abstract command handler, compile time type is unknown
        return this.sendWithResult<T>({
            op: "setting.write",
            path,
            args
        }, this.lease!, timeoutMs, isPriority);
    }

    /**
     * Resets a setting on the device
     * @param path The path to the setting to reset
     * @requires A valid lease token
     */
    async resetSetting(path: string, timeoutMs?: number, isPriority?: boolean): Promise<void> {
        this._requireLease();
        // Handled by abstract command handler, compile time type is unknown
        await this.send({ op: "setting.reset", path }, this.lease!, timeoutMs, isPriority);
    }

    async getDeviceName(timeoutMs?: number): Promise<string> {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1238
        return this.readSetting<string>("device.name", timeoutMs);
    }

    async setDeviceName(name: string, timeoutMs?: number): Promise<Schema.RadSetDeviceNameResult> {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L714
        return this.writeSetting<Schema.RadSetDeviceNameResult>("device.name", { value: name }, timeoutMs);
    }

    async resetDeviceName(timeoutMs?: number): Promise<void> {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1238
        await this.resetSetting("device.name", timeoutMs);
    }
    // #endregion

    // #region Helpers
    #parseValueAsJson<T = unknown>(value: AllowSharedBufferSource): T {
        const str = this._dec.decode(value);
        return JSON.parse(str) as T;
    }

    protected _requireRadCharacteristic(characteristic: RadCharacteristicKey) {
        if (!this._radService[characteristic])
            throw new DOMException(`Characteristic ${characteristic} not available`, "InvalidStateError");
    }

    /**
     * Ensures that a lease is currently active and valid.
     * @throws DOMException if no lease is available or if the existing lease has expired.
     */
    protected _requireLease(): void {
        if (!this.lease)
            throw new DOMException("No lease acquired", "InvalidStateError");
        if (this.lease.isExpired)
            throw new DOMException("Lease has expired", "InvalidStateError");
    }

    #snakeCaseToCamelCase(str: string): string {
        return str.toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
    }
    // #endregion
}
