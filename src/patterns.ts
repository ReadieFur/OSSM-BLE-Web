import type { OssmPlayData } from "./ossmBleTypes";

export class PatternHelper implements OssmPlayData {
    //#region OssmPlayData
    readonly speed: number;
    readonly pattern: number;
    readonly stroke: number;
    readonly depth: number;
    readonly sensation: number = 100;
    //#endregion
 
    constructor(
        /** The pattern identifier */
        public readonly patternId: number,
        /** The minimum depth percentage (0-100) */
        public readonly minDepth: number,
        /** The maximum depth percentage (0-100) */
        public readonly maxDepth: number,
        /** The speed percentage (0-100) */
        speed: number,
        /** How pronounced the effect is (0-100) */
        public readonly intensity: number | undefined = undefined,
        /** When `true`, the pattern direction is reversed; default is `false` */
        public readonly invert: boolean | undefined = undefined
    ) {
        //#region OssmPlayData
        this.speed = speed;
        //#endregion

        //#region BasicPattern 
        /*  format:
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

        if (patternId < 0 || !Number.isInteger(patternId))
            throw new RangeError("patternId must be a positive integer.");
        if (this.minDepth < 0 || this.minDepth > 100 || !Number.isInteger(this.minDepth))
            throw new RangeError("minDepthAbsolute must be an integer between 0 and 100.");
        if (this.maxDepth < 0 || this.maxDepth > 100 || !Number.isInteger(this.maxDepth))
            throw new RangeError("maxDepthAbsolute must be an integer between 0 and 100.");
        if (this.minDepth > this.maxDepth)
            throw new RangeError("minDepthAbsolute must be less than maxDepthAbsolute.");
        if (this.speed < 0 || this.speed > 100)
            throw new RangeError("Speed must be between 0 and 100.");

        this.pattern = this.patternId;
        this.speed = this.speed;
        this.depth = this.maxDepth;
        this.stroke = this.maxDepth - this.minDepth;
        //#endregion

        //#region ConfigurablePattern
        if (this.intensity !== undefined) {
            if (this.intensity < 0 || this.intensity > 100 || !Number.isInteger(this.intensity))
                throw new RangeError("Intensity must be an integer between 0 and 100.");

            this.sensation = this.intensity;
        }
        //#endregion

        //#region ReversiblePattern
        if (this.invert !== undefined) {
            if (this.intensity === undefined)
                throw new Error("Intensity must be defined for reversible patterns.");

            this.sensation = this.invert
                ? 50 - Math.round(this.intensity / 2)
                : 50 + Math.round(this.intensity / 2);
        }
    }

    /**
     * Creates a PatternHelper from raw play data
     * @param data play data to convert from
     * @param hasIntensity wether the pattern uses intensity
     * @param canInvert wether the pattern can be inverted
     * @returns a PatternHelper instance
     */
    static fromPlayData(
        data: OssmPlayData,
        hasIntensity: boolean = false,
        canInvert: boolean = false
    ): PatternHelper {
        const maxDepth = data.depth;
        const minDepth = data.depth - data.stroke;
        
        let intensity: number | undefined = undefined;
        let invert: boolean | undefined = undefined;
        
        if (canInvert) {
            intensity = Math.abs((data.sensation - 50) * 2);
            invert = data.sensation < 50;
        } else if (hasIntensity) {
            intensity = data.sensation;
        }

        return new PatternHelper(
            data.pattern,
            minDepth,
            maxDepth,
            data.speed,
            intensity,
            invert
        )
    }
};

export enum KnownPattern {
    /**
     * Acceleration, coasting, deceleration equally split
     * @param hasIntensity `false`
     * @param canInvert `false`
     * @example
     * ```ts
     * // Set a simple stroke from 20% to 80% depth at 70% speed
     * await ossmBle.runStrokeEnginePattern(new PatternHelper(KnownPattern.SimpleStroke, 20, 80, 70));
     * ```
     */
    SimpleStroke = 0,

    /**
     * A rhythmic back-and-forth motion with asymmetric timing. The actuator moves steadily in one direction and quickly in the other
     * @param intensity how pronounced the teasing/pounding effect is
     * @param invert when `true`, the actuator retracts quickly and extends slowly; when `false`, it extends quickly and retracts slowly
     */
    TeasingPounding = 1,

    /**
     * Robotic-style strokes with abrupt starts and stops
     * @param intensity how pronounced the effect is, lower is more robotic, higher is smoother
     * @param canInvert `false`
     */
    RoboStroke = 2,
    
    /**
     * Full and half depth strokes alternate
     * @param intensity how pronounced the half/full depth effect is
     * @param invert when `true`, the pattern starts with a half-depth stroke; when `false`, it starts with a full-depth stroke
     */
    HalfNHalf = 3,
    
    /**
     * Gradually deepens the stroke over a set number of cycles
     * @param intensity multiplier for how many cycles occur before resetting
     * @param canInvert `false`
     */
    Deeper = 4,
    
    /**
     * Pauses between strokes
     * @param intensity pause duration multiplier
     * @param canInvert `false`
     */
    StopNGo = 5,
    
    /**
     * Modifies length, maintains speed; sensation influences direction
     * //TODO: Clarify this description
     * @note Can be used to set the rod to a specific position
     * @example
     * ```ts
     * await ossmBle.runStrokeEnginePattern({
     *    pattern: KnownPattern.Insist,
     *    depth: 30,
     *    speed: 50,
     *    stroke: 100,
     *    sensation: 100
     * });
     * ```
     */
    Insist = 6,
};
