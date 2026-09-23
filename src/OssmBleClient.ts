import { RadBleApi } from "./RadBleApi";

// GATT schema definition
const OSSM_SERVICE_UUID = "522b443a-4f53-534d-0001-420badbabe69";

export class OssmBleClient extends RadBleApi {
    /**
     * Prompts the user via the browser to pair with an OSSM BLE device
     * @requires That the page is served over HTTPS or from localhost AND is called by a user gesture
     * @returns A new {@link OssmClient} on successful pairing
     * @throws DOMException if pairing is cancelled or fails
     */
    static async pairDevice(): Promise<OssmBleClient> {
        const bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: "OSSM" }],
            optionalServices: [OSSM_SERVICE_UUID]
        });
        return new OssmBleClient(bleDevice);
    }

    constructor(device: BluetoothDevice) {
        super(OSSM_SERVICE_UUID, device);
    }
}
