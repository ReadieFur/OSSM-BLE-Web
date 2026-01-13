import { Assert } from "./test.web.js";
import { OssmBle, OssmEventType } from "../dist/ossmBle.js";
import type { ExposedWindowProperties } from "./ossmBle.test";

interface TestWindow extends Window, ExposedWindowProperties {}
declare const window: TestWindow;

async function CreateOssmBleInstance(): Promise<OssmBle> {
    // Create an invisible button to trigger BLE device selection
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

    // Await the OssmBle instance
    const instance = await bleDevicePromise;
    Assert.exists(instance);

    // Cleanup
    document.body.removeChild(bleButton);

    return instance;
}

export async function testConnectToDevice() {
    await CreateOssmBleInstance();
}

export async function testEvents() {
    const ossmBle = await CreateOssmBleInstance();

    // Setup event listeners
    let connectedFired = false;
    let disconnectedFired = false;
    let stateChangedFired = false;
    ossmBle.addEventListener(0 as OssmEventType, () => connectedFired = true);
    ossmBle.addEventListener(1 as OssmEventType, () => disconnectedFired = true);
    ossmBle.addEventListener(2 as OssmEventType, () => stateChangedFired = true);

    // Connect to the device
    ossmBle.begin();
    await ossmBle.waitForReady();
    Assert.isTrue(connectedFired, "Connected event did not fire");

    // Await for a maximum of 2 seconds for a state change event, they should occur at least every second
    await new Promise<void>(async (resolve, reject) => {
        // Using resolve instead of reject since I want to check against the boolean, not an error
        const timeout = setTimeout(resolve, 2000);
        while (!stateChangedFired)
            await new Promise(r => setTimeout(r, 100));
        clearTimeout(timeout);
        resolve();
    });
    Assert.isTrue(stateChangedFired, "StateChanged event did not fire");

    // Disconnect the device
    ossmBle?.[Symbol.dispose]();
    await new Promise(r => setTimeout(r, 500)); // Wait a bit for the event to fire (dispose is exposed as synchronous but contains async operations)
    Assert.isTrue(disconnectedFired, "Disconnected event did not fire");
}
