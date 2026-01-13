import { Assert } from "./test.web.js";
import { OssmBle } from "../dist/ossmBle.js";
import type { ExposedWindowProperties } from "./ossmBle.test.ts";

document.body.style.backgroundColor = "black";
document.body.style.color = "white";

interface TestWindow extends Window, ExposedWindowProperties {}
declare const window: TestWindow;

async function CreateOssmBleInstance(): Promise<OssmBle> {
    const bleButton = document.createElement("button");
    bleButton.id = `bleButton_${Math.random().toString(36).substring(2)}`;
    bleButton.classList.add("invisible");
    document.body.appendChild(bleButton);

    // Create a promise that wraps onClick event
    const bleDevicePromise = new Promise<OssmBle>((resolve, reject) => {
        bleButton.onclick = async () => {
            try {
                resolve(await OssmBle.pairDevice());
            } catch (error) {
                reject(error);
            }
        };
    });

    // Tell Puppeteer to click the button to trigger device selection
    await window.selectBleDevice(bleButton.id, "OSSM");

    return await bleDevicePromise;
}

export async function testConnectToDevice() {
    const ossmBle = await CreateOssmBleInstance();
    Assert.exists(ossmBle);
}
