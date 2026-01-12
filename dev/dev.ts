//@ts-ignore
import { OssmBle, OssmEventType } from "../dist/ossmBle.js";

class Dev {
    ossmBle: OssmBle | null = null;

    constructor() {
        document.addEventListener("DOMContentLoaded", async () => {
            const connectBtn = document.createElement("button");
            connectBtn.addEventListener('click', async () => {
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

        this.ossmBle.addEventListener(OssmEventType.Connected, () => console.log("OssmEventType.Connected"));
        this.ossmBle.addEventListener(OssmEventType.Disconnected, () => console.log("OssmEventType.Disconnected"));
        this.ossmBle.addEventListener(OssmEventType.StateChanged, () => console.log("OssmEventType.StateChanged"));

        await this.ossmBle.begin();
        await this.ossmBle.waitForReady();
        console.log("OSSM is ready.");
    }
}
(window as any).dev = new Dev();
