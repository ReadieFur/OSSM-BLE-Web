import { BleConnectionHandler, DiscoveredGattService, GattServiceDefinition } from "./BleConnectionHandler";
import { CatalogEntry, CatalogPage, ProtocolInfo } from "./Types";

// #region GATT schema definition
const OSSM_DEVICE_NAME = "OSSM";
// I bless Copilot for this, there are NO ossm docs for this and the firmware source code is frankly a steaming pile of shit
const OSSM_RAD_SERVICE = {
    uuid: '522b443a-4f53-534d-0001-420badbabe69',
    characteristics: {
        // Protocol/version/capability metadata for RAD
        protocolInfo: '522b443a-4f53-534d-0002-420badbabe69',
        // Resource catalog (what paths/resources the device exposes)
        catalog: '522b443a-4f53-534d-0003-420badbabe69',
        // Device name read/write endpoint (RAD-managed name)
        deviceName: '522b443a-4f53-534d-0004-420badbabe69',
        // Device identity/build info
        deviceIdentity: '522b443a-4f53-534d-0005-420badbabe69',
        // Send RAD JSON requests (setting.write, target.set, sensor.read, etc.)
        request: '522b443a-4f53-534d-1000-420badbabe69',
        // Receive command results / staged responses
        response: '522b443a-4f53-534d-1100-420badbabe69',
        // Full state snapshot + state notifications
        state: '522b443a-4f53-534d-2000-420badbabe69',
        // Compact state heartbeat notifications
        essentialState: '522b443a-4f53-534d-2010-420badbabe69',
        // General async events/notifications
        event: '522b443a-4f53-534d-2100-420badbabe69',
        // High-rate sensor/state streaming channel
        stream: '522b443a-4f53-534d-2300-420badbabe69',
        // Button surface channel (read button surface snapshot)
        button: '522b443a-4f53-534d-3000-420badbabe69',
        // Encoder surface channel (read/write encoder value)
        encoder: '522b443a-4f53-534d-3010-420badbabe69',
        // Indicator surface channel (e.g. LED control)
        indicator: '522b443a-4f53-534d-4000-420badbabe69',
        // OTA session control (start/finish/abort, status control plane)
        otaControl: '522b443a-4f53-534d-5000-420badbabe69',
        // OTA firmware chunk upload data channel
        otaData: '522b443a-4f53-534d-5010-420badbabe69',
        // OTA progress/status notifications
        otaStatus: '522b443a-4f53-534d-5020-420badbabe69',
    }
} as const satisfies GattServiceDefinition;
// #endregion

type RadStage = "accepted" | "completed" | "failed";

interface RadResponse<T = unknown> {
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

interface RadRequest {
    v: 1;
    id: number;
    op: string;
    path?: string;
    args?: Record<string, unknown>;
    lease?: number;
    ifState?: string;
}

const defaultRadRequestTimeoutMs = 6000;

export class OssmClient extends BleConnectionHandler {
    /**
     * Prompts the user via the browser to pair with an OSSM BLE device
     * @requires that the page is served over HTTPS or from localhost AND is called by a user gesture
     * @returns BluetoothDevice on successful pairing
     * @throws DOMException if pairing is cancelled or fails
     */
    static async pairDevice(): Promise<OssmClient> {
        const bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: OSSM_DEVICE_NAME }],
            optionalServices: [OSSM_RAD_SERVICE.uuid]
        });
        return new OssmClient(bleDevice);
    }

    readonly #enc = new TextEncoder();
    readonly #dec = new TextDecoder();

    #ossmRadService: DiscoveredGattService<typeof OSSM_RAD_SERVICE> | null = null;
    #nextId = 1;
    #leaseToken: number | null = null;
    #pending = new Map<number, {
        resolve: (v: RadResponse) => void;
        reject: (e: Error) => void;
        timer: number;
    }>();

    constructor(device: BluetoothDevice) {
        super(device);
        this.debugLog(this);
    }

    protected async setupServicesAndCharacteristics(gatt: BluetoothRemoteGATTServer): Promise<void> {
        // Discover service
        this.#ossmRadService = await BleConnectionHandler.discoverGattService(gatt, OSSM_RAD_SERVICE);

        // Set up notifications
        this.#ossmRadService.characteristics.response.addEventListener("characteristicvaluechanged", this.#onResponse.bind(this));
        await this.enqueueBleTask(() => this.#ossmRadService!.characteristics.response.startNotifications());

        this.#ossmRadService.characteristics.state.addEventListener("characteristicvaluechanged", this.#onState.bind(this));
        await this.enqueueBleTask(() => this.#ossmRadService!.characteristics.state.startNotifications());

        this.#ossmRadService.characteristics.essentialState.addEventListener("characteristicvaluechanged", this.#onEssentialState.bind(this));
        await this.enqueueBleTask(() => this.#ossmRadService!.characteristics.essentialState.startNotifications());

        this.#ossmRadService.characteristics.event.addEventListener("characteristicvaluechanged", this.#onEvent.bind(this));
        await this.enqueueBleTask(() => this.#ossmRadService!.characteristics.event.startNotifications());

        // Validate protocol
        const info = this.#parseValueAsJson<ProtocolInfo>(
            await this.enqueueBleTask(() => this.#ossmRadService!.characteristics.protocolInfo.readValue()));
        if (!info || info.protocol !== "rad-ble" || info.deviceType !== "OSSM")
            throw new DOMException(`Unexpected protocol info: ${JSON.stringify(info)}`, "NotSupportedError");
    }

    protected override async onBeforeDisconnect(): Promise<void> {
        if (this.#ossmRadService) {
            this.#ossmRadService.characteristics.response.removeEventListener("characteristicvaluechanged", this.#onResponse.bind(this));
            this.#ossmRadService.characteristics.state.removeEventListener("characteristicvaluechanged", this.#onState.bind(this));
            this.#ossmRadService.characteristics.essentialState.removeEventListener("characteristicvaluechanged", this.#onEssentialState.bind(this));
            this.#ossmRadService.characteristics.event.removeEventListener("characteristicvaluechanged", this.#onEvent.bind(this));
        }
    }

    protected override async onDisconnected(wasConnected: boolean): Promise<void> {
        this.#ossmRadService = null;
    }

    #parseValueAsJson<T = unknown>(value: DataView): T {
        const str = this.#dec.decode(value);
        try { return JSON.parse(str) as T; }
        catch (e) { throw new Error(`Failed to parse JSON from value: ${str}`); }
    }

    async #send<T = unknown>(
        req: Omit<RadRequest, "v" | "id" | "lease">,
        needsLease: boolean,
        timeoutMs: number = defaultRadRequestTimeoutMs
    ): Promise<RadResponse<T>> {
        const id = this.#nextId++;
        const request: RadRequest = { v: 1, id, ...req };
        if (needsLease) {
            if (!this.#leaseToken)
                throw new DOMException("No lease token available for request that requires a lease", "InvalidStateError");
            request.lease = this.#leaseToken;
        }

        const payload = this.#enc.encode(JSON.stringify(request));

        const result = await new Promise<RadResponse<T>>((resolve, reject) => {
            const timer = window.setTimeout(() => {
                this.#pending.delete(id);
                reject(new DOMException(`RAD request timeout (id=${id}, op=${req.op})`, "TimeoutError"));
            }, timeoutMs);

            this.#pending.set(id, { resolve: resolve as any, reject, timer });

            this.enqueueBleTask(async () => {
                const requestChar = this.#ossmRadService?.characteristics.request;
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

    #onResponse(event: Event): void {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        const msg = this.#parseValueAsJson<RadResponse>(value);
        this.debugLog("Received RAD response:", msg);
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

    /**
     * Fetches the entire catalog of commands & resources from the OSSM device, handling pagination automatically.
     */
    async fetchCatalog(): Promise<CatalogEntry[]> {
        let entries: CatalogEntry[] = [];

        let page = 0;
        while (true) {
            const res = await this.#send<CatalogPage>({ op: "catalog.read", args: { page } }, false);
            if (!res.result)
                throw new Error("Catalog read returned no result");

            entries.push(...res.result.resources);

            if (page >= res.result.pages - 1)
                break;

            page++;
        }

        return entries;
    }

    async acquireLease(ttlSeconds = 10): Promise<{ lease: number; ttlMs: number }> {
        const res = await this.#send<{ lease: number; ttlMs: number }>({
            op: "control.acquire",
            args: { ttl: ttlSeconds },
        }, false);
        if (!res.result?.lease) throw new Error("Lease acquire returned no token");
        this.#leaseToken = res.result.lease;
        return res.result;
    }

    async renewLease(ttlSeconds = 10): Promise<void> {
        this.#requireLease();
        await this.#send({ op: "control.renew", args: { ttl: ttlSeconds } }, true);
    }

    async releaseLease(): Promise<void> {
        this.#requireLease();
        await this.#send({ op: "control.release" }, true);
        this.#leaseToken = null;
    }

    #requireLease(): void {
        if (!this.#leaseToken) throw new Error("No control lease. Call acquireLease() first.");
    }

    #onState(event: Event): void {
        try {
            const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
            if (!value) return;
            const msg = this.#parseValueAsJson(value);
            this.dispatchEvent("state", msg);
        } catch (e) {
            console.error("Failed to parse RAD state notification:", e);
        }
    }

    #onEssentialState(event: Event): void {
        try {
            const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
            if (!value) return;
            const msg = this.#parseValueAsJson(value);
            this.dispatchEvent("essentialState", msg);
        } catch (e) {
            console.error("Failed to parse RAD essential state notification:", e);
        }
    }

    #onEvent(event: Event): void {
        try {
            const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
            if (!value) return;
            const msg = this.#parseValueAsJson(value);
            this.dispatchEvent("event", msg);
        } catch (e) {
            console.error("Failed to parse RAD event notification:", e);
        }
    }
}
