// I'm fully aware this file is a mess, its just for a development sandbox.

//@ts-ignore
import { KnownPattern, OssmBle, OssmEventType, OssmPage, PatternHelper } from "../dist/ossmBle.js";
import type { OssmPlayData } from "../src/ossmBleTypes";

abstract class Input<T> {
    public readonly container: HTMLDivElement = document.createElement("div");
    private readonly label: HTMLLabelElement = document.createElement("label");
    constructor(
        public readonly tag: string,
        protected value: T,
        public onChange: (value: T) => void
    ) {
        this.label = document.createElement("label");
        this.label.textContent = tag;
        this.container.appendChild(this.label);
    }

    public setValue(value: T): void {
        this.value = value;
    }

    public getValue(): T {
        return this.value;
    }
}

class NumericInput extends Input<number> {
    private readonly input: HTMLInputElement;
    private readonly slider: HTMLInputElement;

    constructor(tag: string, initialValue: number, onChange: (value: number) => void) {
        super(tag, initialValue, onChange);
        
        this.input = document.createElement("input");
        this.input.type = "number";
        this.input.value = this.value.toString();
        this.container.appendChild(this.input);

        this.slider = document.createElement("input");
        this.slider.type = "range";
        this.slider.value = this.value.toString();
        this.container.appendChild(this.slider);

        this.input.addEventListener("change", (e) => {
            const value = Number(this.input.value);
            this.value = value;
            this.slider.value = value.toString();
            onChange(value);
        });
        this.slider.addEventListener("change", (e) => {
            const value = Number(this.slider.value);
            this.value = value;
            this.input.value = value.toString();
            onChange(value);
        });
    }

    override setValue(value: number): void {
        super.setValue(value);
        this.input.value = value.toString();
        this.slider.value = value.toString();
    }
}

class BooleanInput extends Input<boolean> {
    private readonly checkbox: HTMLInputElement;

    constructor(tag: string, initialValue: boolean, onChange: (value: boolean) => void) {
        super(tag, initialValue, onChange);

        this.checkbox = document.createElement("input");
        this.checkbox.type = "checkbox";
        this.checkbox.checked = this.value;
        this.container.appendChild(this.checkbox);

        this.checkbox.addEventListener("change", (e) => {
            const value = this.checkbox.checked;
            this.value = value;
            onChange(value);
        });
    }

    override setValue(value: boolean): void {
        super.setValue(value);
        this.checkbox.checked = value;
    }
}

class RadioInput extends Input<string> {
    private readonly radios: HTMLInputElement[] = [];
    
    constructor(tag: string, options: string[], initialValue: string, onChange: (value: string) => void) {
        super(tag, initialValue, onChange);

        options.forEach(option => {
            const radio = document.createElement("input");
            radio.id = `${tag}-${option}`;
            radio.type = "radio";
            radio.name = tag;
            radio.value = option;
            radio.checked = (option === this.value);
            this.container.appendChild(radio);
            this.radios.push(radio);

            const radioLabel = document.createElement("label");
            radioLabel.htmlFor = radio.id;
            radioLabel.textContent = option;
            this.container.appendChild(radioLabel);

            radio.addEventListener("change", (e) => {
                if (radio.checked) {
                    this.value = option;
                    onChange(option);
                }
            });
        });
    }
}

class ButtonInput extends Input<void> {
    private readonly button: HTMLButtonElement;
    constructor(tag: string, onClick: () => void) {
        super(tag, undefined, () => {});
        this.button = document.createElement("button");
        this.button.textContent = tag;
        this.container.appendChild(this.button);
        this.button.addEventListener("click", (e) => {
            onClick();
        });
    }
}

class Dev {
    ossmBle: OssmBle | null = null;
    domObjects: Input<any>[] = [];
    standardInputObjects: Input<any>[] = [];
    patternInputObjects: Input<any>[] = [];
    updatingProperties: boolean = false;
    pageInput: RadioInput | null = null;
    patternInput: RadioInput | null = null;
    speedInput: NumericInput | null = null;
    strokeInput: NumericInput | null = null;
    depthInput: NumericInput | null = null;
    sensationInput: NumericInput | null = null;
    minDepthInput: NumericInput | null = null;
    maxDepthInput: NumericInput | null = null;
    intensityInput: NumericInput | null = null;
    invertInput: RadioInput | null = null;

    constructor() {
        document.addEventListener("DOMContentLoaded", async () => {
            const connectBtn = document.createElement("button");
            connectBtn.addEventListener('click', async () => {
                this.domObjects.forEach(obj => obj.container.remove());
                this.domObjects = [];
                this.standardInputObjects.forEach(obj => obj.container.remove());
                this.standardInputObjects = [];
                this.patternInputObjects.forEach(obj => obj.container.remove());
                this.patternInputObjects = [];

                if (this.ossmBle) {
                    try { this.ossmBle?.[Symbol.dispose](); }
                    catch {}
                    this.ossmBle = null;
                }

                this.ossmBle = await OssmBle.pairDevice();
                this.ossmBle.debug = true;
                console.log("dev.ossmBle:", this.ossmBle);

                this.onDevicePaired();
            });
            connectBtn.textContent = "Connect to BLE Device";
            document.body.appendChild(connectBtn);
        });
    }

    async onDevicePaired(): Promise<void> {
        if (!this.ossmBle)
            throw new Error("Invalid state: No OSSM device connected.");

        this.ossmBle.addEventListener(OssmEventType.Connected, this.onConnected.bind(this));
        this.ossmBle.addEventListener(OssmEventType.Disconnected, this.onDisconnected.bind(this));
        this.ossmBle.addEventListener(OssmEventType.StateChanged, this.onStateChanged.bind(this));

        await this.ossmBle.begin();
        await this.ossmBle.waitForReady();
        console.log("OSSM is ready.");

        await this.ossmBle.setSpeedKnobConfig(false);
        await this.ossmBle.getPatternList();

        // await this.ossmBle.runStrokeEnginePattern(new PatternHelper(KnownPattern.SimpleStroke, 20, 80, 70));
        // await this.ossmBle.runStrokeEnginePattern(new PatternHelper(KnownPattern.TeasingPounding, 20, 80, 20, 100, false));
        // await this.ossmBle.runStrokeEnginePattern(new PatternHelper(KnownPattern.RoboStroke, 30, 70, 15, 0));
        // await this.ossmBle.runStrokeEnginePattern(new PatternHelper(KnownPattern.Insist, 0, 30, 100, 100));

        //#region Setup DOM
        const initialState = await this.ossmBle.getState();

        const stopButton = new ButtonInput(
            "Stop",
            async () => await this.ossmBle?.stop()
        );
        this.domObjects.push(stopButton);

        const speedKnobConfigInput = new BooleanInput(
            "Speed knob as limit",
            await this.ossmBle.getSpeedKnobConfig(),
            async (value) => await this.ossmBle?.setSpeedKnobConfig(value)
        );
        this.domObjects.push(speedKnobConfigInput);

        const usePatternHelperInput = new BooleanInput(
            "Use Pattern helper",
            false,
            async (value) => this.usePatternHelper(value)
        );
        this.domObjects.push(usePatternHelperInput);

        this.pageInput = new RadioInput(
            "Page",
            Object.values(OssmPage),
            await this.ossmBle.getCurrentPage(),
            async (value) => await this.ossmBle?.navigateTo(value as OssmPage)
        );
        this.domObjects.push(this.pageInput);

        this.patternInput = new RadioInput(
            "Pattern",
            this.ossmBle.getCachedPatternList()!.map(p => p.name),
            this.ossmBle.getCachedPatternList()![initialState.pattern].name,
            async (value) => await this.ossmBle?.setPattern(this.ossmBle?.getCachedPatternList()!.findIndex(p => p.name === value)!)
        );
        this.domObjects.push(this.patternInput);

        this.speedInput = new NumericInput(
            "Speed",
            initialState.speed,
            async (value) => await this.ossmBle?.setSpeed(value)
        );
        this.domObjects.push(this.speedInput);

        // Stroke engine inputs
        this.strokeInput = new NumericInput(
            "Stroke",
            initialState.stroke,
            async (value) => await this.ossmBle?.setStroke(value)
        );
        this.standardInputObjects.push(this.strokeInput);

        this.depthInput = new NumericInput(
            "Depth",
            initialState.depth,
            async (value) => await this.ossmBle?.setDepth(value)
        );
        this.standardInputObjects.push(this.depthInput);

        this.sensationInput = new NumericInput(
            "Sensation",
            initialState.sensation,
            async (value) => await this.ossmBle?.setSensation(value)
        );
        this.standardInputObjects.push(this.sensationInput);

        // Pattern helper
        this.minDepthInput = new NumericInput(
            "Pattern Min Depth",
            0,
            async (value) => this.helperPatternUpdate()
        );
        this.patternInputObjects.push(this.minDepthInput);

        this.maxDepthInput = new NumericInput(
            "Pattern Max Depth",
            100,
            async (value) => this.helperPatternUpdate()
        );
        this.patternInputObjects.push(this.maxDepthInput);

        this.intensityInput = new NumericInput(
            "Pattern Intensity",
            100,
            async (value) => this.helperPatternUpdate()
        );
        this.patternInputObjects.push(this.intensityInput);

        this.invertInput = new RadioInput(
            "Pattern Invert",
            ["undefined", "true", "false"],
            "undefined",
            async (value) => this.helperPatternUpdate()
        );
        this.patternInputObjects.push(this.invertInput);

        this.domObjects.forEach(obj => document.body.appendChild(obj.container));
        this.standardInputObjects.forEach(obj => document.body.appendChild(obj.container));
        this.patternInputObjects.forEach(obj => document.body.appendChild(obj.container));

        this.usePatternHelper(usePatternHelperInput.getValue());
        await this.onStateChanged();
        //#endregion
    }

    usePatternHelper(value: boolean): void {
        if (value) {
            this.standardInputObjects.forEach(obj => obj.container.setAttribute("disabled", "true"));
            this.patternInputObjects.forEach(obj => obj.container.removeAttribute("disabled"));
        } else {
            this.standardInputObjects.forEach(obj => obj.container.removeAttribute("disabled"));
            this.patternInputObjects.forEach(obj => obj.container.setAttribute("disabled", "true"));
        }
    }

    async helperPatternUpdate(): Promise<void> {
        if (!this.ossmBle || this.updatingProperties)
            return;

        await this.ossmBle?.runStrokeEnginePattern(new PatternHelper(
            this.ossmBle!.getCachedPatternList()!.findIndex(p => p.name === this.patternInput!.getValue()),
            this.minDepthInput!.getValue(),
            this.maxDepthInput!.getValue(),
            this.speedInput!.getValue(),
            this.intensityInput!.getValue(),
            this.invertInput!.getValue() === "undefined" ? undefined : (this.invertInput!.getValue() === "true")
        ));
    }

    async onConnected(): Promise<void> {
        this.domObjects.forEach(obj => obj.container.attributes.removeNamedItem("disabled"));
    }

    async onDisconnected(): Promise<void> {
        this.domObjects.forEach(obj => obj.container.attributes.setNamedItem(document.createAttribute("disabled")));
    }

    async onStateChanged(): Promise<void> {
        if (!this.ossmBle || this.updatingProperties)
            return;

        this.updatingProperties = true;

        const state = await this.ossmBle.getState();
        
        this.pageInput?.setValue(await this.ossmBle.getCurrentPage());
        this.patternInput?.setValue(this.ossmBle.getCachedPatternList()![state.pattern].name);
        this.speedInput?.setValue(state.speed);
        this.strokeInput?.setValue(state.stroke);
        this.depthInput?.setValue(state.depth);
        this.sensationInput?.setValue(state.sensation);

        try {
            const pattern = PatternHelper.fromPlayData(state, state.sensation !== 100, false);
            this.minDepthInput?.setValue(pattern.minDepth);
            this.maxDepthInput?.setValue(pattern.maxDepth);
            if (pattern.intensity !== undefined)
                this.intensityInput?.setValue(pattern.intensity);
        } catch (error) {
            console.error(error);
        }

        this.updatingProperties = false;
    }
}
(window as any).dev = new Dev();
