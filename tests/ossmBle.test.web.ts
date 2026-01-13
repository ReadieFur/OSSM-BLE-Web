import { Assert } from "./test.web.js";
import { OssmBle, OssmEventType, OssmPage, OssmStatus } from "../dist/ossmBle.js";
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

    instance.debug = true;
    return instance;
}

export async function testConnectToDevice() {
    const ossmBle = await CreateOssmBleInstance();
    // Cleanup gracefully
    ossmBle?.[Symbol.dispose]();
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

export async function testSetSpeed() {
    /* Speeds may not be reflected in the real world if the device is not in an engine mode
     * This is fine behavior for the purposes of these tests as we just want to check if the commands are accepted or rejected
     * e.g. Won't run in main menu but will still accept the command
     */

    const ossmBle = await CreateOssmBleInstance();
    await ossmBle.begin();
    await ossmBle.waitForReady();

    // Should pass without error.
    await ossmBle.setSpeed(100);
    await ossmBle.setSpeed(50);
    await ossmBle.setSpeed(0);

    // Should throw errors
    await Assert.throwsAsync(async () => ossmBle.setSpeed(-1), "Setting speed to -1 did not throw");
    await Assert.throwsAsync(async () => ossmBle.setSpeed(101), "Setting speed to 101 did not throw");

    ossmBle?.[Symbol.dispose]();
}

export async function testSetStroke() {
    const ossmBle = await CreateOssmBleInstance();
    await ossmBle.begin();
    await ossmBle.waitForReady();
 
    await ossmBle.setStroke(100);
    await ossmBle.setStroke(50);
    await ossmBle.setStroke(1); // Docs say 0-100 but the device will +1 anything below 100, so 1 is the minimum effective value
 
    await Assert.throwsAsync(async () => ossmBle.setStroke(-1), "Setting stroke to -1 did not throw");
    await Assert.throwsAsync(async () => ossmBle.setStroke(101), "Setting stroke to 101 did not throw");

    ossmBle?.[Symbol.dispose]();
}

export async function testSetDepth() {
    const ossmBle = await CreateOssmBleInstance();
    await ossmBle.begin();
    await ossmBle.waitForReady();

    await ossmBle.setDepth(100);
    await ossmBle.setDepth(50);
    await ossmBle.setDepth(1);

    await Assert.throwsAsync(async () => ossmBle.setDepth(-1), "Setting depth to -1 did not throw");
    await Assert.throwsAsync(async () => ossmBle.setDepth(101), "Setting depth to 101 did not throw");
 
    ossmBle?.[Symbol.dispose]();
}

export async function testSetSensation() {
    const ossmBle = await CreateOssmBleInstance();
    await ossmBle.begin();
    await ossmBle.waitForReady();

    await ossmBle.setSensation(100);
    await ossmBle.setSensation(50);
    await ossmBle.setSensation(1);

    await Assert.throwsAsync(async () => ossmBle.setSensation(-1), "Setting sensation to -1 did not throw");
    await Assert.throwsAsync(async () => ossmBle.setSensation(101), "Setting sensation to 101 did not throw");
    
    ossmBle?.[Symbol.dispose]();
}
