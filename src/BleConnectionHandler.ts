import { AsyncFunctionQueue } from "./AsyncQueue";
import { SingleEvent, SingleEventSource } from "./SingleEvent";

export enum BleConnectionState {
    Disconnected = "disconnected",
    Connecting = "connecting",
    Connected = "connected",
    Reconnecting = "reconnecting",
    Disconnecting = "disconnecting",
}

export interface GattServiceDefinition {
    uuid: BluetoothServiceUUID;
    characteristics: Record<string, BluetoothCharacteristicUUID>;
}

export type DiscoveredGattService<TDef extends GattServiceDefinition> = {
    service: BluetoothRemoteGATTService;
    characteristics: {
        -readonly [K in keyof TDef["characteristics"]]: BluetoothRemoteGATTCharacteristic;
    };
};

/**
 * Generic web-bluetooth connection handler
 */
export abstract class BleConnectionHandler implements Disposable {
    readonly #handleGattDisconnectedSignature = this.#handleGattDisconnected.bind(this);

    #connectionState: BleConnectionState = BleConnectionState.Disconnected;

    protected readonly _device: BluetoothDevice;
    protected readonly _taskQueue = new AsyncFunctionQueue();

    readonly connectedEvent: SingleEvent = new SingleEventSource();
    readonly disconnectedEvent: SingleEvent = new SingleEventSource();
    readonly reconnectingEvent: SingleEvent = new SingleEventSource();

    debug: boolean = window?.location?.hostname === "localhost" || new URLSearchParams(window?.location?.search).has("dev");
    autoReconnect: boolean = true;
    reconnectTimeoutMs: number = 5000;
    reconnectRetryDelayMs: number = 250;

    get connectionState(): BleConnectionState {return this.#connectionState; }
    get isConnected(): boolean { return this.#connectionState === BleConnectionState.Connected && !!this._device.gatt?.connected; }

    constructor(device: BluetoothDevice) {
        this._device = device;
        if (!this._device.gatt)
            throw new DOMException("Device is not connectable via GATT.", "NotSupportedError");

        this._device.addEventListener("gattserverdisconnected", this.#handleGattDisconnectedSignature);
    }

    [Symbol.dispose](): void {
        this.disconnect();
        /* Event cleanup is required here since the _device object managed by the browser is persistent within the session
         * and so can cause this to be called over and over every time a new implimentation using the same device is made.
         */
        this._device.removeEventListener("gattserverdisconnected", this.#handleGattDisconnectedSignature);
    }

    //#region Connection lifecycle
    /**
     * Begins automatic connection and lifecycle management
     */
    async begin(): Promise<void> {
        try { await this._connect(); }
        catch (error) { this._debugLog("Initial connection attempt failed.", error); }
    }

    /**
     * Gracefully disconnects from the device and halts auto-reconnection
     */
    async disconnect(): Promise<void> {
        this.autoReconnect = false;
        this.#connectionState = BleConnectionState.Disconnecting;
        this._taskQueue.clearQueue("Disconnecting from device.");

        await this._onBeforeDisconnect();

        if (this._device.gatt?.connected)
            this._device.gatt.disconnect();

        this.#connectionState = BleConnectionState.Disconnected;
        (this.disconnectedEvent as SingleEventSource).dispatch();
    }

    protected async _connect(): Promise<void> {
        if (this._device.gatt?.connected && this.#connectionState === BleConnectionState.Connected)
            return;

        this.#connectionState = BleConnectionState.Connecting;
        this._taskQueue.clearQueue("Initiating new connection, clearing stale tasks.");

        this._debugLog("Connecting GATT server...");
        let gattServer = await this._taskQueue.enqueue(() => this._device.gatt!.connect());
        await this._setupServicesAndCharacteristics(gattServer);

        this.#connectionState = BleConnectionState.Connected;
        this._debugLog("Connected");
        (this.connectedEvent as SingleEventSource).dispatch();
    }

    async #handleGattDisconnected(): Promise<void> {
        const wasConnected = this.#connectionState === BleConnectionState.Connected;
        this.#connectionState = BleConnectionState.Disconnected;
        this._debugLog("Disconnected");

        (this.disconnectedEvent as SingleEventSource).dispatch();

        await this._onDisconnected(wasConnected);

        if (this.autoReconnect)
            await this.#runReconnectLoop();
    }

    async #runReconnectLoop(): Promise<void> {
        this.#connectionState = BleConnectionState.Reconnecting;
        this._debugLog("Reconnecting...");
        (this.reconnectingEvent as SingleEventSource).dispatch();

        let attempt = 0;

        while (this.autoReconnect && !this.isConnected) {
            try {
                attempt++;
                this._debugLog(`Reconnection attempt ${attempt}...`);
                await this._connect();
                break;
            } catch (error) {
                this._debugLog(`Reconnection attempt ${attempt} failed:`, error);
                await new Promise((resolve) => setTimeout(resolve, this.reconnectRetryDelayMs));
            }
        }

        if (this.isConnected)
            await this._onReconnected();
    }
    //#endregion

    //#region Template methods for derived classes
    /**
     * Override to perform GATT service/characteristic discovery and notification subscriptions
     */
    protected abstract _setupServicesAndCharacteristics(gatt: BluetoothRemoteGATTServer): Promise<void>;

    /**
     * Executed upon reconnection after a disconnection event
     */
    protected async _onReconnected(): Promise<void> {}

    /**
     * Executed prior to explicit disconnection
     */
    protected async _onBeforeDisconnect(): Promise<void> {}

    /**
     * Executed when disconnection occurs
     */
    protected async _onDisconnected(wasConnected: boolean): Promise<void> {}
    //#endregion

    //#region Task queue & helpers
    /**
     * Discovers and initializes a single GATT service and all its characteristics
     */
    static async discoverGattService<TDef extends GattServiceDefinition>(
        gatt: BluetoothRemoteGATTServer,
        serviceDef: TDef
    ): Promise<DiscoveredGattService<TDef>> {
        const service = await gatt.getPrimaryService(serviceDef.uuid);
        const characteristics = {} as Record<string, BluetoothRemoteGATTCharacteristic>;

        for (const [charName, charUuid] of Object.entries(serviceDef.characteristics))
            characteristics[charName] = await service.getCharacteristic(charUuid);

        return {
            service,
            characteristics: characteristics as DiscoveredGattService<TDef>["characteristics"],
        };
    }

    async enqueueBleTask<T>(fn: () => Promise<T>): Promise<T> { return this._taskQueue.enqueue(fn); }
    async prependBleTask<T>(fn: () => Promise<T>): Promise<T> { return this._taskQueue.prepend(fn); }
    clearBleTaskQueue(reason?: Error | string): void { this._taskQueue.clearQueue(reason); }

    protected _debugLog(...args: any[]): void {
        if (this.debug)
            console.log(`[${this._device.id}]`, ...args);
    }
    //#endregion
}
