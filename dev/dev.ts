//@ts-ignore
import { OssmBle, OssmEventType } from "../dist/ossmBle.js";

class Dev {
    ossmBle: OssmBle | null = null;
    domObjects: HTMLElement[] = [];

    constructor() {
        document.addEventListener("DOMContentLoaded", async () => {
            const connectBtn = document.createElement("button");
            connectBtn.addEventListener('click', async () => {
                this.domObjects.forEach(obj => obj.remove());
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

    createNumericInput(labelText: string, initialValue: number, onChange: (value: number) => void): HTMLDivElement {
        /* Container layout:
         * label [numeric input] [slider]
         */
        const container = document.createElement("div");

        const label = document.createElement("label");
        label.textContent = labelText;
        container.appendChild(label);
        
        const input = document.createElement("input");
        input.type = "number";
        input.value = initialValue.toString();
        container.appendChild(input);

        const slider = document.createElement("input");
        slider.type = "range";
        slider.value = initialValue.toString();
        container.appendChild(slider);

        input.addEventListener("change", (e) => {
            const value = Number(input.value);
            slider.value = value.toString();
            onChange(value);
        });
        slider.addEventListener("change", (e) => {
            const value = Number(slider.value);
            input.value = value.toString();
            onChange(value);
        });

        return container;
    }

    async onDevicePaired(): Promise<void> {
        if (!this.ossmBle)
            throw new Error("Invalid state: No OSSM device connected.");

        // this.ossmBle.addEventListener(OssmEventType.Connected, () => console.log("OssmEventType.Connected"));
        // this.ossmBle.addEventListener(OssmEventType.Disconnected, () => console.log("OssmEventType.Disconnected"));
        // this.ossmBle.addEventListener(OssmEventType.StateChanged, () => console.log("OssmEventType.StateChanged"));

        await this.ossmBle.begin();
        await this.ossmBle.waitForReady();
        console.log("OSSM is ready.");

        await this.ossmBle.getPatternList();

        //#region Setup DOM
        const initialState = await this.ossmBle.getState();

        const speedInput = this.createNumericInput(
            "Speed",
            initialState.speed,
            async (value) => await this.ossmBle?.setSpeed(value)
        );
        document.body.appendChild(speedInput);
        this.domObjects.push(speedInput);

        const strokeInput = this.createNumericInput(
            "Stroke",
            initialState.stroke,
            async (value) => await this.ossmBle?.setStroke(value)
        );
        document.body.appendChild(strokeInput);
        this.domObjects.push(strokeInput);

        const depthInput = this.createNumericInput(
            "Depth",
            initialState.depth,
            async (value) => await this.ossmBle?.setDepth(value)
        );
        document.body.appendChild(depthInput);
        this.domObjects.push(depthInput);

        const sensationInput = this.createNumericInput(
            "Sensation",
            initialState.sensation,
            async (value) => await this.ossmBle?.setSensation(value)
        );
        document.body.appendChild(sensationInput);
        this.domObjects.push(sensationInput);
        //#endregion
    }
}
(window as any).dev = new Dev();
