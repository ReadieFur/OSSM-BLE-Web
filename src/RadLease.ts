import { RadBleApi } from "./RadBleApi";

export abstract class RadLease {
    abstract get token(): number | null;
    abstract get isExpired(): boolean;
    abstract get expiresAt(): number;
}

/**
 * A lease that is manually acquired and renewed on a host device
 */
export class SimpleLease extends RadLease implements Disposable {
    readonly #disconnectSignature = this.onApiDisconnected.bind(this);
    protected readonly api: RadBleApi;
    protected readonly ttlSeconds: number;
    protected _token: number | null = null;
    protected _expiresAt = 0;
    protected _disposed = false;

    /** The current active lease token, or null if unallocated/expired */
    get token(): number | null {
        return this._token;
    }

    /** Epoch timestamp (ms) when this lease expires */
    get expiresAt(): number {
        return this._expiresAt;
    }

    /** Whether the lease token is missing or past its expiration timestamp */
    get isExpired(): boolean {
        if (this._token === null) return true;
        return Date.now() >= this._expiresAt;
    }

    /** Whether an active, non-expired lease is held on a connected host */
    get isAcquired(): boolean {
        return !this.isExpired && this.api.isConnected;
    }

    constructor(api: RadBleApi, ttlSeconds = 10) {
        super();
        this.api = api;
        this.ttlSeconds = ttlSeconds;
        this.api.addEventListener("disconnected", this.#disconnectSignature);
    }

    [Symbol.dispose](): void {
        this.release();
    }

    protected async onApiDisconnected(): Promise<void> {
        // If autoReconnect is disabled then don't poll since it will never succeed, instead invalidate this lease
        if (!this.api.autoReconnect)
            await this.release();
    }

    /**
     * Manually acquires a lease token from the host device.
     */
    async acquire(): Promise<this> {
        if (this._disposed) throw new DOMException("Lease has been released", "InvalidStateError");

        const res = await this.api.send<{ lease: number; ttlMs: number }>({
            op: "control.acquire",
            args: { ttl: this.ttlSeconds },
        });
        if (!res.result?.lease) throw new DOMException("Lease acquire returned no token", "OperationError");

        this._token = res.result.lease;
        this._expiresAt = Date.now() + res.result.ttlMs;
        return this;
    }

    /**
     * Manually renews the current lease token on the host device.
     */
    async renew(): Promise<void> {
        if (this._disposed) throw new DOMException("Lease has been released", "InvalidStateError");
        if (this._token === null|| this.isExpired) throw new DOMException("No active lease token to renew", "InvalidStateError");

        // Tokens do not change on renewal, only the expiration timestamp is updated
        await this.api.send({ op: "control.renew", args: { ttl: this.ttlSeconds } }, this._token);
        this._expiresAt = Date.now() + (this.ttlSeconds * 1000);
    }

    /**
     * Releases the lease on the host device.
     */
    async release(): Promise<void> {
        this._disposed = true;
        const currentToken = this._token;
        this._token = null;
        this._expiresAt = 0;

        if (currentToken !== null && this.api.isConnected) {
            try { await this.api.send({ op: "control.release" }, currentToken); }
            catch { /* Ignore disconnect or teardown errors */ }
        }

        this.api.removeEventListener("disconnected", this.#disconnectSignature);
    }
}

/**
 * A lease that automatically renews itself in the background before it expires
 */
export class AutoLease extends SimpleLease {
    // Renew when x% of the TTL has elapsed
    readonly #autoLeaseRenewalFactor: number;
    #timer: number | null = null;

    /** Remaining time-to-live in milliseconds */
    get remainingMs(): number {
        if (this._token === null) return 0;
        return Math.max(0, this._expiresAt - Date.now());
    }

    constructor(api: RadBleApi, ttlSeconds = 10, autoLeaseRenewalFactor = 0.7) {
        super(api, ttlSeconds);
        if (autoLeaseRenewalFactor <= 0 || autoLeaseRenewalFactor >= 1)
            throw new RangeError("autoLeaseRenewalFactor must be between 0 and 1 (exclusive)");
        this.#autoLeaseRenewalFactor = autoLeaseRenewalFactor;
    }

    /**
     * Starts the auto-lease acquisition and background renewal loop.
     */
    async start(): Promise<this> {
        this._disposed = false;
        await this.#tick();
        return this;
    }

    /**
     * Manually triggers a renewal and resets the auto-renew schedule.
     */
    override async renew(): Promise<void> {
        if (this._disposed) throw new DOMException("Lease has been released", "InvalidStateError");

        if (this._token === null) {
            await this.#tick();
            return;
        }

        try {
            await super.renew();
            this.#scheduleNext(this.ttlSeconds * 1000 * this.#autoLeaseRenewalFactor);
        } catch {
            this._token = null;
            this._expiresAt = 0;
            await this.#tick();
        }
    }

    /**
     * Releases the lease on the host device and cancels background timers.
     */
    override async release(): Promise<void> {
        if (this.#timer !== null) {
            window.clearTimeout(this.#timer);
            this.#timer = null;
        }
        await super.release();
    }

    async #tick(): Promise<number | null> {
        if (this._disposed) return null;

        if (this.#timer !== null) {
            window.clearTimeout(this.#timer);
            this.#timer = null;
        }

        // If host is down, wait before trying again
        if (!this.api.isConnected) {
            this._token = null;
            this._expiresAt = 0;

            this.#scheduleNext(2000);
            return null;
        }

        // Acquire phase (no token or expired)
        if (this._token === null || this.isExpired) {
            try {
                await super.acquire();
                this.#scheduleNext(this.remainingMs * this.#autoLeaseRenewalFactor);
                return this._token;
            } catch {
                this._token = null;
                this._expiresAt = 0;
                this.#scheduleNext(2000);
                return null;
            }
        }

        // Renewal phase (active lease, not expired)
        try {
            await super.renew();
            this.#scheduleNext(this.ttlSeconds * 1000 * this.#autoLeaseRenewalFactor);
            return this._token;
        } catch {
            this._token = null;
            this._expiresAt = 0;
            return await this.#tick();
        }
    }

    #scheduleNext(delayMs: number): void {
        if (this._disposed) return;
        this.#timer = window.setTimeout(() => this.#tick().catch(() => {}), delayMs);
    }
}
