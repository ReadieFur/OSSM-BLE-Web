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

    protected readonly device: BluetoothDevice;
    protected readonly taskQueue = new AsyncFunctionQueue();

    readonly connectedEvent: SingleEvent = new SingleEventSource();
    readonly disconnectedEvent: SingleEvent = new SingleEventSource();
    readonly reconnectingEvent: SingleEvent = new SingleEventSource();

    debug: boolean = window?.location?.hostname === "localhost" || new URLSearchParams(window?.location?.search).has("dev");
    autoReconnect: boolean = true;
    reconnectTimeoutMs: number = 5000;
    reconnectRetryDelayMs: number = 250;

    get connectionState(): BleConnectionState {return this.#connectionState; }
    get isConnected(): boolean { return this.#connectionState === BleConnectionState.Connected && !!this.device.gatt?.connected; }

    constructor(device: BluetoothDevice) {
        this.device = device;
        if (!this.device.gatt)
            throw new DOMException("Device is not connectable via GATT.", "NotSupportedError");

        this.device.addEventListener("gattserverdisconnected", this.#handleGattDisconnectedSignature);
    }

    [Symbol.dispose](): void {
        this.disconnect();
    }

    //#region Connection lifecycle
    /**
     * Begins automatic connection and lifecycle management
     */
    async begin(): Promise<void> {
        try { await this.connect(); }
        catch (error) { this.debugLog("Initial connection attempt failed.", error); }
    }

    /**
     * Gracefully disconnects from the device and halts auto-reconnection
     */
    async disconnect(): Promise<void> {
        this.autoReconnect = false;
        this.#connectionState = BleConnectionState.Disconnecting;
        this.taskQueue.clearQueue("Disconnecting from device.");

        await this.onBeforeDisconnect();

        if (this.device.gatt?.connected)
            this.device.gatt.disconnect();

        this.#connectionState = BleConnectionState.Disconnected;
        (this.disconnectedEvent as SingleEventSource).dispatch();
    }

    protected async connect(): Promise<void> {
        if (this.device.gatt?.connected && this.#connectionState === BleConnectionState.Connected)
            return;

        this.#connectionState = BleConnectionState.Connecting;
        this.taskQueue.clearQueue("Initiating new connection, clearing stale tasks.");

        this.debugLog("Connecting GATT server...");
        let gattServer = await this.taskQueue.enqueue(() => this.device.gatt!.connect());
        await this.setupServicesAndCharacteristics(gattServer);

        this.#connectionState = BleConnectionState.Connected;
        this.debugLog("Connected");
        (this.connectedEvent as SingleEventSource).dispatch();
    }

    async #handleGattDisconnected(): Promise<void> {
        const wasConnected = this.#connectionState === BleConnectionState.Connected;
        this.#connectionState = BleConnectionState.Disconnected;
        this.debugLog("Disconnected");

        (this.disconnectedEvent as SingleEventSource).dispatch();

        await this.onDisconnected(wasConnected);

        if (this.autoReconnect)
            await this.#runReconnectLoop();
    }

    async #runReconnectLoop(): Promise<void> {
        this.#connectionState = BleConnectionState.Reconnecting;
        this.debugLog("Reconnecting...");
        (this.reconnectingEvent as SingleEventSource).dispatch();

        let attempt = 0;

        while (this.autoReconnect && !this.isConnected) {
            try {
                attempt++;
                this.debugLog(`Reconnection attempt ${attempt}...`);
                await this.connect();
                break;
            } catch (error) {
                this.debugLog(`Reconnection attempt ${attempt} failed:`, error);
                await new Promise((resolve) => setTimeout(resolve, this.reconnectRetryDelayMs));
            }
        }

        if (this.isConnected)
            await this.onReconnected();
    }
    //#endregion

    //#region Template methods for derived classes
    /**
     * Override to perform GATT service/characteristic discovery and notification subscriptions
     */
    protected abstract setupServicesAndCharacteristics(gatt: BluetoothRemoteGATTServer): Promise<void>;

    /**
     * Executed upon reconnection after a disconnection event
     */
    protected async onReconnected(): Promise<void> {}

    /**
     * Executed prior to explicit disconnection
     */
    protected async onBeforeDisconnect(): Promise<void> {}

    /**
     * Executed when disconnection occurs
     */
    protected async onDisconnected(wasConnected: boolean): Promise<void> {}
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

    async enqueueBleTask<T>(fn: () => Promise<T>): Promise<T> { return await this.taskQueue.enqueue(fn); }
    async prependBleTask<T>(fn: () => Promise<T>): Promise<T> { return await this.taskQueue.prepend(fn); }
    clearBleTaskQueue(reason?: Error | string): void { this.taskQueue.clearQueue(reason); }

    protected debugLog(...args: any[]): void {
        if (this.debug)
            console.log(`[${this.device.id}]`, ...args);
    }
    //#endregion
}
