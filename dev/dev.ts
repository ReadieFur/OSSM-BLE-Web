import { OssmBle } from "../dist/ossmBle.dev.js";

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

        await this.ossmBle.begin();
        await this.ossmBle.waitForReady();
        console.log("OSSM is ready.");
    }
}
(window as any).dev = new Dev();
