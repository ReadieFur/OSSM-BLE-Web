import { CancellationToken, CancellationTokenSource, ICancellationToken } from "./CancellationToken";
import { enforceRange } from "./Helpers";
import * as OssmSchema from "./OssmProtocolSchema";

    // #region Common
    async setSpeed(speed: number, ct?: ICancellationToken): Promise<void> {
        enforceRange(speed, 0, 100);
        await this.#fastWrite(this.#characteristics.common.speed, this._enc.encode(speed.toString()), ct);
    }

    async setMaxDepth(maxDepth: number, ct?: ICancellationToken): Promise<void> {
        enforceRange(maxDepth, 0, 100);
        await this.#fastWrite(this.#characteristics.common.maxDepth, this._enc.encode(maxDepth.toString()), ct);
    }

    async setMinDepth(minDepth: number, ct?: ICancellationToken): Promise<void> {
        enforceRange(minDepth, 0, 100);
        await this.#fastWrite(this.#characteristics.common.minDepth, this._enc.encode(minDepth.toString()), ct);
    }

    async setStreamInput(position: number, duration: number, ct?: ICancellationToken): Promise<void> {
        enforceRange(position, 0, 100, "Position must be between 0 and 100");
        await this.#fastWrite(this.#characteristics.common.streamInput, this._enc.encode(`${position}:${duration}`), ct);
    }

    async setSensation(sensation: number, ct?: ICancellationToken): Promise<void> {
        enforceRange(sensation, 0, 100);
        await this.#fastWrite(this.#characteristics.common.sensation, this._enc.encode(sensation.toString()), ct);
    }

    async setPattern(pattern: number, ct?: ICancellationToken): Promise<void> {
        if (Number.isInteger(pattern)) throw new DOMException("Pattern index must be an integer", "IndexSizeError");
        enforceRange(pattern, 0, Number.MAX_SAFE_INTEGER, "Pattern index must be positive");
        await this.#fastWrite(this.#characteristics.common.pattern, this._enc.encode(pattern.toString()), ct);
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
    #fastWrite(char: BluetoothRemoteGATTCharacteristic, val: BufferSource, ct?: ICancellationToken): Promise<void> {
        const cts = !ct && this.defaultTimeoutMs ? CancellationTokenSource.createWithTimeout(this.defaultTimeoutMs) : undefined;
        ct = ct ?? cts?.token ?? CancellationToken.None;
        return this._taskQueue.enqueue(() => char.writeValueWithoutResponse(val), ct);
    }
    // #endregion
