import type { ConstructorInit } from "./helpers";
import type { OssmPlayData } from "./ossmBleTypes";

//#region Pattern bases
export interface StrokeEnginePattern {
    toPlayData(): OssmPlayData;
    fromPlayData(data: OssmPlayData): void;
};

/**
 * Base class for stroke patterns with common properties and methods.  
 * Provides basic functionality for converting to/from play data.  
 * Allows for setting min/max depth and speed.
 */
export class BasicPattern implements StrokeEnginePattern {   
    /** The pattern identifier */
    readonly patternId: number = -1; //Default to invalid.
    /** The minimum depth percentage (0-100) */
    readonly minDepth: number = 0;
    /** The maximum depth percentage (0-100) */
    readonly maxDepth: number = 100;
    /** The speed percentage (0-100) */
    readonly speed: number = 0;

    /**
     * Empty constructor is intended to be used with {@link fromPlayData} immediately after.
     */
    constructor();

    /**
     * Construct a BasicPattern with required properties.
     */
    constructor(init: ConstructorInit<BasicPattern>);

    /**
     * Not intended to be called directly; use one of the overloaded constructors instead.
     */
    constructor(init?: ConstructorInit<BasicPattern>) {
        if (init)
            Object.assign(this, init);
    }

    toPlayData(): OssmPlayData {
        /* StrokeEngine.SimpleStroke format:
         *
         * - Depth:
         *   Sets the maximum extension limit of the actuator.
         *   The device will extend up to this value (0–100) and will not exceed it.
         *
         * - Stroke:
         *   Sets how far the actuator retracts back from the depth limit.
         *   The actuator will move between:
         *     max = depth
         *     min = depth - stroke
         *
         * Notes:
         * - Motion always occurs backwards from depth (unless dip-switch 6 is set to invert motion).
         * - Stroke is a retraction distance, not a centered range.
         */

        if (this.minDepth < 0 || this.minDepth > 100)
            throw new RangeError("minDepthAbsolute must be between 0 and 100.");
        if (this.maxDepth < 0 || this.maxDepth > 100)
            throw new RangeError("maxDepthAbsolute must be between 0 and 100.");
        if (this.minDepth >= this.maxDepth)
            throw new RangeError("minDepthAbsolute must be less than maxDepthAbsolute.");
        if (this.speed < 0 || this.speed > 100)
            throw new RangeError("Speed must be between 0 and 100.");

        return {
            speed: this.speed,
            depth: this.maxDepth,
            stroke: this.maxDepth - this.minDepth,
            sensation: 100, // Not used by SimpleStroke
            pattern: this.patternId
        };
    }

    fromPlayData(data: OssmPlayData): void {
        Object.assign(this, {
            ...this,
            patternId: data.pattern,
            speed: data.speed,
            maxDepth: data.depth,
            minDepth: data.depth - data.stroke
        } satisfies BasicPattern);
    }
};

/**
 * Base class for configurable stroke patterns with intensity control.
 */
export class ConfigurablePattern extends BasicPattern {
    /** How pronounced the effect is (0-100) */
    readonly intensity: number = 100;

    constructor();
    constructor(init: ConstructorInit<ConfigurablePattern>);
    constructor(init?: ConstructorInit<ConfigurablePattern>) {
        if (init) {
            super(init);
            Object.assign(this, init);
        } else {
            super();
        }
    }

    override toPlayData(): OssmPlayData {
        if (this.intensity < 0 || this.intensity > 100)
            throw new RangeError("Intensity must be between 0 and 100.");

        return {
            ...super.toPlayData(),
            sensation: this.intensity,
            pattern: this.patternId
        };
    }

    override fromPlayData(data: OssmPlayData): void {
        super.fromPlayData(data);
        Object.assign(this, {
            ...this,
            intensity: data.sensation
        } satisfies ConfigurablePattern);
    }
}

/**
 * Base class for reversible stroke patterns with intensity and direction control.
 */
export abstract class ReversiblePattern extends ConfigurablePattern {
    /** When `true`, the pattern direction is reversed; default is `false` */
    readonly invert: boolean = false;

    constructor();
    constructor(init: ConstructorInit<ReversiblePattern>);
    constructor(init?: ConstructorInit<ReversiblePattern>) {
        if (init) {
            super(init);
            Object.assign(this, init);
        } else {
            super();
        }
    }

    override toPlayData(): OssmPlayData {
        if (this.intensity < 0 || this.intensity > 100)
            throw new RangeError("Intensity must be between 0 and 100.");

        // Divide by 2 here since we don't want the added granularity from converting a 0-100 scale to 0-50/50-100 scale
        const sensation = this.invert
            ? 50 - Math.round(this.intensity / 2)
            : 50 + Math.round(this.intensity / 2);

        return {
            ...super.toPlayData(),
            sensation: sensation,
            pattern: KnownPattern.TeasingPounding
        };
    }

    override fromPlayData(data: OssmPlayData): void {
        super.fromPlayData(data);
        Object.assign(this, {
            ...this,
            intensity: Math.abs((data.sensation - 50) * 2),
            invert: data.sensation < 50
        } satisfies ReversiblePattern);
    }
};
//#endregion

//#region Known patterns
enum KnownPattern {
    SimpleStroke = 0,
    TeasingPounding = 1,
    RoboStroke = 2,
    HalfNHalf = 3,
    Deeper = 4,
    StopNGo = 5,
    Insist = 6,
};

new BasicPattern({
    patternId: KnownPattern.SimpleStroke,
    minDepth: 0,
    maxDepth: 100,
    speed: 50,
});

