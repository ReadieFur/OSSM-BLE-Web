import { BleConnectionHandler, GattServiceDefinition } from "./BleConnectionHandler";
import { AutoLease, RadLease, SimpleLease } from "./RadLease";
import * as Schema from "./RadProtocolSchema";
import crc32 from "crc-32";

/* I bless Copilot for helping my find the core of how this RAD API works (namely around the request/response handling)
 * There are NO ossm docs for this and the firmware source code is frankly a steaming pile of shit x3
 */
/* https://github.com/researchanddesire/rad-ble/blob/main/src/RadBleProtocol.generated.h
 * https://github.com/researchanddesire/rad-ble/blob/main/protocol/rad-ble-v1.json
 * There are other characteristics defined in the schema but we either don't need them
 * or a lot of them point to the same method handler inside the firmware (so we can just reuse request/response)
 */
const RAD_CHARACTERISTIC_SUFFIXES = {
    protocolInfo: "0002",   // Protocol/version/capability metadata for RAD
    request: "1000",        // Send RAD JSON requests (setting.write, target.set, sensor.read, etc.)
    response: "1100",       // Receive command results / staged responses
    state: "2000",          // Full state snapshot + state notifications
    essentialState: "2010", // Compact state heartbeat notifications
    event: "2100",          // General async events/notifications
    stream: "2300",         // High-rate sensor/state streaming channel
    otaData: "5000"         // OTA firmware chunk upload data channel
};

type RadCharacteristics = {
    [key in keyof typeof RAD_CHARACTERISTIC_SUFFIXES]: BluetoothRemoteGATTCharacteristic;
};

const defaultRadRequestTimeoutMs = 6000;

/**
 * Generic RAD BLE API handler. Handles the RAD protocol over BLE, and it's common calls
 */
export class RadBleApi extends BleConnectionHandler {
    readonly #onResponseSignature = this.onResponse.bind(this);
    readonly #onStateSignature = this.onState.bind(this);
    readonly #onEssentialStateSignature = this.onEssentialState.bind(this);
    readonly #onEventSignature = this.onEvent.bind(this);

    readonly #enc = new TextEncoder();
    readonly #dec = new TextDecoder();

    #nextId = 1;
    #pending = new Map<number, {
        resolve: (v: Schema.RadResponse) => void;
        reject: (e: Error) => void;
        timer: number;
    }>();

    #radServiceDefinition: GattServiceDefinition;
    #radCharacteristics: RadCharacteristics | null = null;
    protected get radService(): RadCharacteristics | null { return this.#radCharacteristics; }

    public lease: RadLease | null = null;
    
    // #region BLE lifecycle
    constructor(serviceUuid: string, device: BluetoothDevice) {
        super(device);

        // Split the UUID into parts so we can build the RAD characteristic UUIDs
        const uuidParts = serviceUuid.split("-");
        if (uuidParts.length !== 5)
            throw new DOMException(`Invalid service UUID: ${serviceUuid}`, "InvalidStateError");

        this.#radServiceDefinition = {
            uuid: serviceUuid,
            characteristics: Object.fromEntries(Object.entries(RAD_CHARACTERISTIC_SUFFIXES).map(([key, suffix]) => {
                const charUuid = `${uuidParts[0]}-${uuidParts[1]}-${uuidParts[2]}-${suffix}-${uuidParts[4]}`;
                return [key, charUuid];
            })) as Record<keyof typeof RAD_CHARACTERISTIC_SUFFIXES, BluetoothCharacteristicUUID>
        }
    }

    /**
     * Sets up the RAD BLE service and its characteristics, and starts notifications for the relevant channels. This is called automatically during the connection process
     */
    protected async setupServicesAndCharacteristics(gatt: BluetoothRemoteGATTServer): Promise<void> {
        // Discover service
        let service = await BleConnectionHandler.discoverGattService(gatt, this.#radServiceDefinition);
        /* Direct cast is fine here since discoverGattService returns a DiscoveredGattService<TDef> which matches the RadCharacteristics type
         * and will fail if any characteristics are not found on the remote
         */
        this.#radCharacteristics = service.characteristics as RadCharacteristics;

        // Set up notifications
        this.radService!.response.addEventListener("characteristicvaluechanged", this.#onResponseSignature);
        await this.enqueueBleTask(() => this.radService!.response.startNotifications());

        this.radService!.state.addEventListener("characteristicvaluechanged", this.#onStateSignature);
        await this.enqueueBleTask(() => this.radService!.state.startNotifications());

        this.radService!.essentialState.addEventListener("characteristicvaluechanged", this.#onEssentialStateSignature);
        await this.enqueueBleTask(() => this.radService!.essentialState.startNotifications());

        this.radService!.event.addEventListener("characteristicvaluechanged", this.#onEventSignature);
        await this.enqueueBleTask(() => this.radService!.event.startNotifications());

        // Validate protocol
        const info = this.#parseValueAsJson<Schema.RadProtocolInfo>(
            await this.enqueueBleTask(() => this.radService!.protocolInfo.readValue()));
        if (!info || info?.protocol !== "rad-ble" || info?.version !== 1)
            throw new DOMException(`Unexpected protocol info: ${JSON.stringify(info)}`, "NotSupportedError");
    }

    /**
     * Called before disconnecting. Cleans up any resources that were allocated during the connection
     */
    protected override async onBeforeDisconnect(): Promise<void> {
        if (this.radService) {
            this.radService.response.removeEventListener("characteristicvaluechanged", this.#onResponseSignature);
            this.radService.state.removeEventListener("characteristicvaluechanged", this.#onStateSignature);
            this.radService.essentialState.removeEventListener("characteristicvaluechanged", this.#onEssentialStateSignature);
            this.radService.event.removeEventListener("characteristicvaluechanged", this.#onEventSignature);
        }
    }

    /**
     * Invalidates the stored RAD service
     */
    protected override async onDisconnected(wasConnected: boolean): Promise<void> {
        this.#radCharacteristics = null;
    }
    // #endregion

    // #region RAD request/response handling
    /**
     * Sends a RAD request to the device and waits for a response
     * @param req The request object to send. Must satisfy {@link RadRequest}
     * @param lease Optional lease to include in the request. If the request requires a lease, this must be provided otherwise the request will fail. Use {@link acquireLease} to obtain a lease.
     * @param timeoutMs Optional timeout in milliseconds to wait for a response before rejecting. Defaults to {@link defaultRadRequestTimeoutMs}
     * @returns A promise that resolves to {@link RadResponse} containing the response data
     */
    async send<T = unknown>(
        req: Omit<Schema.RadRequest, "v" | "id" | "lease">,
        lease?: number | RadLease,
        timeoutMs: number = defaultRadRequestTimeoutMs
    ): Promise<Schema.RadResponse<T>> {
        const id = this.#nextId++;
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
            payload = () => this.#enc.encode(JSON.stringify(request));
        } else {
            request.lease = lease;
            const payloadBuf = this.#enc.encode(JSON.stringify(request));
            payload = () => payloadBuf;
        }

        const result = await new Promise<Schema.RadResponse<T>>((resolve, reject) => {
            const timer = window.setTimeout(() => {
                this.#pending.delete(id);
                reject(new DOMException(`RAD request timeout (id=${id}, op=${req.op})`, "TimeoutError"));
            }, timeoutMs);

            this.#pending.set(id, { resolve: resolve as any, reject, timer });

            this.enqueueBleTask(async () => {
                const requestChar = this.radService?.request;
                if (!requestChar)
                    throw new DOMException("RAD request characteristic not available", "InvalidStateError");
                await requestChar.writeValueWithoutResponse(payload());
            }).catch(err => {
                window.clearTimeout(timer);
                this.#pending.delete(id);
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
        timeoutMs?: number
    ): Promise<T> {
        return this.send<T>(req, lease, timeoutMs).then(res => {
            if (!res.result)
                throw new DOMException("RAD request returned no result", "DataError");
            return res.result;
        });
    }

    /**
     * Handles incoming RAD responses from the device and either rejects or resolves pending requests
     */
    protected onResponse(event: Event): void {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        const msg = this.#parseValueAsJson<Schema.RadResponse>(value);
        this.debugLog("RAD response received:", msg);
        if (!msg || !this.#pending.has(msg.id)) return;

        const p = this.#pending.get(msg.id)!;
        if (!p) return;

        // RAD can emit accepted + completed; only resolve on terminal stages
        if (msg.stage === "failed") {
            window.clearTimeout(p.timer);
            this.#pending.delete(msg.id);
            p.reject(new DOMException(`RAD request failed (id=${msg.id}, op=${msg.stage}): ${msg.code ?? "unknown"} - ${msg.message ?? "no message"}`, "Error"));
            return;
        }

        if (msg.stage === "completed") {
            window.clearTimeout(p.timer);
            this.#pending.delete(msg.id);
            p.resolve(msg);
            return;
        }
    }

    // TODO
    protected onState(event: Event): void {
        try {
            const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
            if (!value) return;
            const msg = this.#parseValueAsJson(value);
            this.debugLog("RAD state notification:", msg);
        } catch (e) {
            console.error("Failed to parse RAD state notification:", e);
        }
    }

    // TODO
    protected onEssentialState(event: Event): void {
        try {
            const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
            if (!value) return;
            const msg = this.#parseValueAsJson(value);
            this.debugLog("RAD essential state notification:", msg);
        } catch (e) {
            console.error("Failed to parse RAD essential state notification:", e);
        }
    }

    // TODO
    protected onEvent(event: Event): void {
        try {
            const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
            if (!value) return;
            const msg = this.#parseValueAsJson(value);
        } catch (e) {
            console.error("Failed to parse RAD event notification:", e);
        }
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

    async getDeviceCapabilities(): Promise<Schema.RadProtocolInfoCompact> {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L996
        return this.sendWithResult<Schema.RadProtocolInfoCompact>({ op: "device.capabilities" });
    }

    async getOtaCapabilities(): Promise<Schema.RadOtaCapabilities> {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1002
        return this.sendWithResult<Schema.RadOtaCapabilities>({ op: "ota.capabilities" });
    }

    /**
     * Streams catalog entries from the device page by page, yielding entries individually
     * @throws DataError if the catalog response is malformed or missing data
     */
    async *getCatalog(): AsyncGenerator<Schema.RadCatalogEntry, void, unknown> {
        let page = 0;
        while (true) {
            // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1031
            const res = await this.sendWithResult<Schema.RadCatalogPage>({ op: "catalog.read", args: { page } });

            // Yield each resource in the page
            yield* res.resources;

            if (page >= res.pages - 1)
                break;

            page++;
        }
    }

    async getStateSnapshot(): Promise<Schema.RadState> {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1041
        return this.sendWithResult<Schema.RadState>({ op: "state.read" });
    }

    async readSensor<T = unknown>(path: string): Promise<T> {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1052
        return this.sendWithResult<T>({ op: "sensor.read", path });
    }

    async getEssentialSnapshot(): Promise<unknown> {
        // Only essential.live is operated upon in the base RAD firmware, but that still calls out to the snapshot handler for an unknown compile time response, so for now I will leave this as T = unknown and let the caller handle the type
        return this.readSensor<unknown>("essential.live");
    }

    async getConnectivitySnapshot(): Promise<unknown> {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1061
        // This also calls out to a Surface:: and has no default handler, so return type is unknown here
        return this.sendWithResult({ op: "wifi.status" });
    }

    /**
     * @note
     * Calls out to the snapshot handler implementation in the firmware.
     * Extended classes should shadow shadow this with getSnapshot* calls for their own snapshot types.
     * Surfaces allowed: Indicator, Haptic, Audio, Display
     * See https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1495
     */
    async readOutput<T = unknown>(path: string): Promise<T> {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1069
        // Calls a dynamic snapshot surface handler, type is unknown
        return this.sendWithResult<T>({ op: "output.read", path });
    }

    async readSensorMany<T = unknown>(paths: string[]): Promise<Schema.RadSensorReadManyEntry<T>[]> {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1095
        return this.sendWithResult<Schema.RadSensorReadManyEntry<T>[]>({ op: "sensor.readMany", args: { paths } });
    }

    /**
     * Starts a stream of data from the device
     * @param path Path to stream
     * @param rateHz Rate in Hz to stream at. If omitted, the device will use its default rate for the stream
     * @requires A valid lease token
     */
    async startStream(path: string, rateHz?: number): Promise<Schema.RadStreamResult> {
        this.requireLease();
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1569
        return this.sendWithResult<Schema.RadStreamResult>({
            op: "stream.start",
            path,
            args: {
                rateHz
            }
        }, this.lease!);
    }

    /**
     * Updates the current stream configuration
     * @param path Path to stream, if any. If omitted, the current stream path is used
     * @param rateHz Rate in Hz to stream at. If omitted, the current stream rate is used
     * @returns A promise resolving to the updated stream result
     * @requires A valid lease token
     */
    async updateStream(path?: string, rateHz?: number): Promise<Schema.RadStreamResult> {
        this.requireLease();
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1550
        return this.sendWithResult<Schema.RadStreamResult>({
            op: "stream.update",
            path,
            args: {
                rateHz
            }
        }, this.lease!);
    }

    /**
     * @requires A valid lease token
     */
    async stopStream(): Promise<void> {
        this.requireLease();
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1542
        await this.send({ op: "stream.stop" }, this.lease!);
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

                await this.enqueueBleTask(async () => this.radService!.otaData.writeValueWithoutResponse(frameArray));

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
    async wifiScan(): Promise<Schema.RadWiFiScanResult> {
        this.requireLease();
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1606
        const res = await this.sendWithResult<Partial<Schema.RadWiFiScanResult>>({ op: "wifi.scan" }, this.lease!);

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
    async wifiForget(): Promise<void> {
        this.requireLease();
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1705
        await this.send({ op: "wifi.forget" }, this.lease!);
    }

    /**
     * Configures the device to connect to a WiFi network.
     * @param ssid The SSID of the WiFi network to connect to
     * @param password Optional password for the WiFi network
     * @returns Void when the credentials have been saved and the device has requested to connect. This does not guarantee that the connection was successful, only that the device has accepted the request to connect. Use {@link getConnectivitySnapshot} to check the connection status.
     * @requires A valid lease token
     */
    async wifiConfigure(ssid: string, password?: string): Promise<void> {
        this.requireLease();
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1711
        await this.send({ op: "wifi.configure", args: { ssid, password } }, this.lease!);
    }

    /**
     * Restarts the device
     * @requires a valid lease
     * @note This also discards this RAD API instance
     */
    async restartSystem(): Promise<void> {
        this.requireLease();
        await this.send({ op: "system.restart" }, this.lease!);
        this.disconnect();
    }

    /**
     * Reads a setting from the device
     * @param path The path to the setting to read
     * @returns The value of the setting
     * @requires A valid lease token
     */
    async readSetting<T = unknown>(path: string): Promise<T> {
        this.requireLease();
        // Handled by abstract command handler, compile time type is unknown
        return this.sendWithResult<T>({ op: "setting.read", path }, this.lease!);
    }

    /**
     * Writes a setting to the device
     * @param path The path to the setting to write
     * @param value The value to write
     * @returns The value of the setting
     * @requires A valid lease token
     */
    async writeSetting<T = unknown>(path: string, args: Record<string, unknown>): Promise<T> {
        this.requireLease();
        // Handled by abstract command handler, compile time type is unknown
        return this.sendWithResult<T>({
            op: "setting.write",
            path,
            args
        }, this.lease!);
    }

    /**
     * Resets a setting on the device
     * @param path The path to the setting to reset
     * @requires A valid lease token
     */
    async resetSetting(path: string): Promise<void> {
        this.requireLease();
        // Handled by abstract command handler, compile time type is unknown
        await this.send({ op: "setting.reset", path }, this.lease!);
    }

    async getDeviceName(): Promise<string> {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1238
        return this.readSetting<string>("device.name");
    }

    async setDeviceName(name: string): Promise<Schema.RadSetDeviceNameResult> {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L714
        return this.writeSetting<Schema.RadSetDeviceNameResult>("device.name", { value: name });
    }

    async resetDeviceName(): Promise<void> {
        // https://github.com/researchanddesire/rad-ble/blob/e0aca3336eb67af2b6090c94e7b4f1896b09b47a/src/RadBle.cpp#L1238
        await this.resetSetting("device.name");
    }
    // #endregion

    // #region Helpers
    #parseValueAsJson<T = unknown>(value: DataView): T {
        const str = this.#dec.decode(value);
        return JSON.parse(str) as T;
    }

    /**
     * Ensures that a lease is currently active and valid.
     * @throws DOMException if no lease is available or if the existing lease has expired.
     */
    protected requireLease(): void {
        if (!this.lease)
            throw new DOMException("No lease acquired", "InvalidStateError");
        if (this.lease.isExpired)
            throw new DOMException("Lease has expired", "InvalidStateError");
    }
    // #endregion
}
