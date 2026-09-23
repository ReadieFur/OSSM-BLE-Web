import { BleConnectionHandler, DiscoveredGattService, GattServiceDefinition } from "./BleConnectionHandler";
import { AutoLease, RadLease, SimpleLease } from "./RadLease";

// I bless Copilot for this, there are NO ossm docs for this and the firmware source code is frankly a steaming pile of shit
type RequiredRadCharacteristics =
    "protocolInfo"      // Protocol/version/capability metadata for RAD
    | "catalog"         // Resource catalog (what paths/resources the device exposes)
    | "deviceName"      // Device name read/write endpoint (RAD-managed name)
    | "deviceIdentity"  // Device identity/build info
    | "request"         // Send RAD JSON requests (setting.write, target.set, sensor.read, etc.)
    | "response"        // Receive command results / staged responses
    | "state"           // Full state snapshot + state notifications
    | "essentialState"  // Compact state heartbeat notifications
    | "event"           // General async events/notifications
    | "stream"          // High-rate sensor/state streaming channel
    | "otaControl"      // OTA session control (start/finish/abort, status control plane)
    | "otaData"         // OTA firmware chunk upload data channel
    | "otaStatus";      // OTA progress/status notifications

export interface RadServiceDefinition extends GattServiceDefinition {
    characteristics: {
        [key in RequiredRadCharacteristics]: BluetoothCharacteristicUUID;
    } & {
        [key: string]: BluetoothCharacteristicUUID;
    };
}

export type RadStage = "accepted" | "completed" | "failed";

export interface RadResponse<T = unknown> {
    v: number;
    id: number;
    stage: RadStage;
    ok: boolean;
    code?: string;
    message?: string;
    result?: T;
    stateBefore?: string;
    stateAfter?: string;
}

export interface RadRequest {
    v: 1;
    id: number;
    op: string;
    path?: string;
    args?: Record<string, unknown>;
    lease?: number;
    ifState?: string;
}

export interface ProtocolInfo {
    capabilities: string[];
    capabilityHash: string;
    channels: number;
    deviceType: string;
    directFilesystemOta: boolean;
    directOta: boolean;
    essentialState: string;
    libraryVersion: string;
    maxMessageBytes: number;
    maxMtu: number;
    otaResumeTlsMs: number;
    protocol: string;
    security: string;
    serviceUuid: string;
    stateHeartbeatMs: number;
    streamHeaderBytes: number;
    version: number;
}

export interface CatalogEntry {
    available: boolean;
    category: string;
    constraints: unknown;
    id: string;
    leaseRequired: boolean;
    path: string;
    readable: boolean;
    safetyCritical: boolean;
    streamable: boolean;
    type: object;
    writable: boolean;
}

export interface CatalogPage {
    page: number;
    pageSize: number;
    pages: number;
    resources: CatalogEntry[];
    total: number;
}

const defaultRadRequestTimeoutMs = 6000;

/**
 * Generic RAD BLE API handler. This class handles the RAD protocol over BLE, and it's common calls
 */
export class RadBleApi extends BleConnectionHandler {
    readonly #enc = new TextEncoder();
    readonly #dec = new TextDecoder();
    #radServiceDefinition: RadServiceDefinition;
    #nextId = 1;
    #pending = new Map<number, {
        resolve: (v: RadResponse) => void;
        reject: (e: Error) => void;
        timer: number;
    }>();
    protected ossmRadService: DiscoveredGattService<RadServiceDefinition> | null = null;
    
    // #region BLE lifecycle
    constructor(radServiceDefinition: RadServiceDefinition, device: BluetoothDevice) {
        super(device);
        this.#radServiceDefinition = radServiceDefinition;
    }

    /**
     * Sets up the RAD BLE service and its characteristics, and starts notifications for the relevant channels. This is called automatically during the connection process
     */
    protected async setupServicesAndCharacteristics(gatt: BluetoothRemoteGATTServer): Promise<void> {
        // Discover service
        this.ossmRadService = await BleConnectionHandler.discoverGattService(gatt, this.#radServiceDefinition);

        // Set up notifications
        this.ossmRadService.characteristics.response.addEventListener("characteristicvaluechanged", this.onResponse.bind(this));
        await this.enqueueBleTask(() => this.ossmRadService!.characteristics.response.startNotifications());

        this.ossmRadService.characteristics.state.addEventListener("characteristicvaluechanged", this.onState.bind(this));
        await this.enqueueBleTask(() => this.ossmRadService!.characteristics.state.startNotifications());

        this.ossmRadService.characteristics.essentialState.addEventListener("characteristicvaluechanged", this.onEssentialState.bind(this));
        await this.enqueueBleTask(() => this.ossmRadService!.characteristics.essentialState.startNotifications());

        this.ossmRadService.characteristics.event.addEventListener("characteristicvaluechanged", this.onEvent.bind(this));
        await this.enqueueBleTask(() => this.ossmRadService!.characteristics.event.startNotifications());

        // Validate protocol
        const info = this.#parseValueAsJson<ProtocolInfo>(
            await this.enqueueBleTask(() => this.ossmRadService!.characteristics.protocolInfo.readValue()));
        if (!info || info.protocol !== "rad-ble")
            throw new DOMException(`Unexpected protocol info: ${JSON.stringify(info)}`, "NotSupportedError");
    }

    /**
     * Called before disconnecting. Cleans up any resources that were allocated during the connection
     */
    protected override async onBeforeDisconnect(): Promise<void> {
        if (this.ossmRadService) {
            this.ossmRadService.characteristics.response.removeEventListener("characteristicvaluechanged", this.onResponse.bind(this));
            this.ossmRadService.characteristics.state.removeEventListener("characteristicvaluechanged", this.onState.bind(this));
            this.ossmRadService.characteristics.essentialState.removeEventListener("characteristicvaluechanged", this.onEssentialState.bind(this));
            this.ossmRadService.characteristics.event.removeEventListener("characteristicvaluechanged", this.onEvent.bind(this));
        }
    }

    /**
     * Invalidates the stored RAD service
     */
    protected override async onDisconnected(wasConnected: boolean): Promise<void> {
        this.ossmRadService = null;
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
        req: Omit<RadRequest, "v" | "id" | "lease">,
        lease?: number | RadLease,
        timeoutMs: number = defaultRadRequestTimeoutMs
    ): Promise<RadResponse<T>> {
        const id = this.#nextId++;
        const request: RadRequest = { v: 1, id, ...req };

        if (lease instanceof RadLease) {
            if (lease.isExpired)
                throw new DOMException("Cannot send RAD request with expired lease", "InvalidStateError");
            request.lease = lease.token!;
        } else if (typeof lease === "number") {
            request.lease = lease;
        }

        const payload = this.#enc.encode(JSON.stringify(request));

        const result = await new Promise<RadResponse<T>>((resolve, reject) => {
            const timer = window.setTimeout(() => {
                this.#pending.delete(id);
                reject(new DOMException(`RAD request timeout (id=${id}, op=${req.op})`, "TimeoutError"));
            }, timeoutMs);

            this.#pending.set(id, { resolve: resolve as any, reject, timer });

            this.enqueueBleTask(async () => {
                const requestChar = this.ossmRadService?.characteristics.request;
                if (!requestChar)
                    throw new DOMException("RAD request characteristic not available", "InvalidStateError");
                await requestChar.writeValueWithoutResponse(payload);
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
     * Handles incoming RAD responses from the device and either rejects or resolves pending requests
     */
    protected onResponse(event: Event): void {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        const msg = this.#parseValueAsJson<RadResponse>(value);
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
            this.dispatchEvent("state", msg);
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
            this.dispatchEvent("essentialState", msg);
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
            this.dispatchEvent("event", msg);
        } catch (e) {
            console.error("Failed to parse RAD event notification:", e);
        }
    }
    // #endregion

    // #region RAD API methods
    /**
     * Acquires a lease from the device, which is required for certain operations that modify state.
     * The lease token is valid for a limited time and must be renewed or released when no longer needed.
     * @param autoRenew Whether the lease should automatically renew at 60% TTL and recover from disconnects. Defaults to false.
     * @param ttlSeconds The time-to-live for the lease in seconds. Defaults to 10 seconds
     * @returns A promise that resolves to a {@link RadLease} object representing the acquired lease
     * @throws OperationError if the lease acquisition fails
     */
    async acquireLease(autoRenew = false, ttlSeconds = 10): Promise<SimpleLease | AutoLease> {
        if (autoRenew) {
            const lease = new AutoLease(this, ttlSeconds);
            await lease.start();
            return lease;
        } else {
            const lease = new SimpleLease(this, ttlSeconds);
            await lease.acquire();
            return lease;
        }
    }

    /**
     * Fetches the entire catalog of commands & resources from the device, handling pagination automatically.
     * @throws DataError if the catalog response is malformed or missing data
     */
    async fetchCatalog(): Promise<CatalogEntry[]> {
        let entries: CatalogEntry[] = [];

        let page = 0;
        while (true) {
            const res = await this.send<CatalogPage>({ op: "catalog.read", args: { page } });
            if (!res.result)
                throw new DOMException("Catalog read returned no result", "DataError");

            entries.push(...res.result.resources);

            if (page >= res.result.pages - 1)
                break;

            page++;
        }

        return entries;
    }
    // #endregion

    // #region Helpers
    #parseValueAsJson<T = unknown>(value: DataView): T {
        const str = this.#dec.decode(value);
        return JSON.parse(str) as T;
    }
    // #endregion
}
