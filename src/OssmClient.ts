import { RadBleApi, RadServiceDefinition } from "./RadBleApi";

// GATT schema definition
const OSSM_RAD_SERVICE = {
    uuid: '522b443a-4f53-534d-0001-420badbabe69',
    characteristics: {
        // Common service characteristics (see RadBleApi.ts for details)
        protocolInfo: '522b443a-4f53-534d-0002-420badbabe69',
        catalog: '522b443a-4f53-534d-0003-420badbabe69',
        deviceName: '522b443a-4f53-534d-0004-420badbabe69',
        deviceIdentity: '522b443a-4f53-534d-0005-420badbabe69',
        request: '522b443a-4f53-534d-1000-420badbabe69',
        response: '522b443a-4f53-534d-1100-420badbabe69',
        state: '522b443a-4f53-534d-2000-420badbabe69',
        essentialState: '522b443a-4f53-534d-2010-420badbabe69',
        event: '522b443a-4f53-534d-2100-420badbabe69',
        stream: '522b443a-4f53-534d-2300-420badbabe69',
        otaControl: '522b443a-4f53-534d-5000-420badbabe69',
        otaData: '522b443a-4f53-534d-5010-420badbabe69',
        otaStatus: '522b443a-4f53-534d-5020-420badbabe69',

        // OSSM specific characteristics
        button: '522b443a-4f53-534d-3000-420badbabe69',     // Button surface channel (read button surface snapshot)
        encoder: '522b443a-4f53-534d-3010-420badbabe69',    // Encoder surface channel (read/write encoder value)
        indicator: '522b443a-4f53-534d-4000-420badbabe69',  // Indicator surface channel (e.g. LED control)
    }
} as const satisfies RadServiceDefinition;

export class OssmClient extends RadBleApi {
    /**
     * Prompts the user via the browser to pair with an OSSM BLE device
     * @requires That the page is served over HTTPS or from localhost AND is called by a user gesture
     * @returns A new {@link OssmClient} on successful pairing
     * @throws DOMException if pairing is cancelled or fails
     */
    static async pairDevice(): Promise<OssmClient> {
        const bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: "OSSM" }],
            optionalServices: [OSSM_RAD_SERVICE.uuid]
        });
        return new OssmClient(OSSM_RAD_SERVICE, bleDevice);
    }
}
