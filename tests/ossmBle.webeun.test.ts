import { OssmBle } from "../dist/ossmBle.js";

const bleButton = document.createElement("button");
bleButton.id = "bleButton";
bleButton.innerText = "Connect to BLE Device";
bleButton.addEventListener("click", async () => {
    // Define ossmBleInstance in the window for test access.
    window.ossmBleInstance = await window.OssmBle.pairDevice();
});
document.body.appendChild(bleButton);

export function event_listeners() {

}
