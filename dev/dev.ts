//@ts-ignore
import { OssmBle, OssmEventType, OssmPage } from "../dist/ossmBle.js";

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

class Dev {
    ossmBle: OssmBle | null = null;
    domObjects: Input<any>[] = [];

    constructor() {
        document.addEventListener("DOMContentLoaded", async () => {
            const connectBtn = document.createElement("button");
            connectBtn.addEventListener('click', async () => {
                this.domObjects.forEach(obj => obj.container.remove());
                this.domObjects = [];

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

        //#region Setup DOM
        const initialState = await this.ossmBle.getState();

        const speedKnobConfigInput = new BooleanInput(
            "Speed knob as limit",
            await this.ossmBle.getSpeedKnobConfig(),
            async (value) => await this.ossmBle?.setSpeedKnobConfig(value)
        );
        document.body.appendChild(speedKnobConfigInput.container);
        this.domObjects.push(speedKnobConfigInput);

        const pageInput = new RadioInput(
            "Page",
            Object.values(OssmPage),
            await this.ossmBle.getCurrentPage(),
            async (value) => await this.ossmBle?.navigateTo(value as OssmPage)
        );
        document.body.appendChild(pageInput.container);
        this.domObjects.push(pageInput);

        const speedInput = new NumericInput(
            "Speed",
            initialState.speed,
            async (value) => await this.ossmBle?.setSpeed(value)
        );
        document.body.appendChild(speedInput.container);
        this.domObjects.push(speedInput);

        const strokeInput = new NumericInput(
            "Stroke",
            initialState.stroke,
            async (value) => await this.ossmBle?.setStroke(value)
        );
        document.body.appendChild(strokeInput.container);
        this.domObjects.push(strokeInput);

        const depthInput = new NumericInput(
            "Depth",
            initialState.depth,
            async (value) => await this.ossmBle?.setDepth(value)
        );
        document.body.appendChild(depthInput.container);
        this.domObjects.push(depthInput);

        const sensationInput = new NumericInput(
            "Sensation",
            initialState.sensation,
            async (value) => await this.ossmBle?.setSensation(value)
        );
        document.body.appendChild(sensationInput.container);
        this.domObjects.push(sensationInput);

        const patternInput = new RadioInput(
            "Pattern",
            this.ossmBle.getCachedPatternList()!.map(p => p.name),
            this.ossmBle.getCachedPatternList()![initialState.pattern].name,
            async (value) => await this.ossmBle?.setPattern(this.ossmBle?.getCachedPatternList()!.findIndex(p => p.name === value)!)
        );
        document.body.appendChild(patternInput.container);
        this.domObjects.push(patternInput);
        //#endregion
    }

    async onConnected(): Promise<void> {
        this.domObjects.forEach(obj => obj.container.attributes.removeNamedItem("disabled"));
    }

    async onDisconnected(): Promise<void> {
        this.domObjects.forEach(obj => obj.container.attributes.setNamedItem(document.createAttribute("disabled")));
    }

    async onStateChanged(): Promise<void> {
        if (!this.ossmBle)
            return;

        const state = await this.ossmBle.getState();
    }
}
(window as any).dev = new Dev();
