import { BleConnectionHandler, DiscoveredGattService, GattServiceDefinition } from "./BleConnectionHandler";

// #region GATT schema definition
const OSSM_DEVICE_NAME = "OSSM";
const OSSM_PRIMARY_SERVICE = {
    uuid: '522b443a-4f53-534d-0001-420badbabe69',
    characteristics: {
        command: '522b443a-4f53-534d-1000-420badbabe69',
        speedKnobConfiguration: '522b443a-4f53-534d-1010-420badbabe69',
        latencyCompensationConfiguration: '522b443a-4f53-534d-1030-420badbabe69',
        wifi: '522b443a-4f53-534d-1020-420badbabe69',
        currentState: '522b443a-4f53-534d-2000-420badbabe69',
        patternList: '522b443a-4f53-534d-3000-420badbabe69',
        patternDescription: '522b443a-4f53-534d-3010-420badbabe69',
        gpioControl: '522b443a-4f53-534d-4000-420badbabe69'
    }
} as const satisfies GattServiceDefinition;
// #endregion

export class OssmClient extends BleConnectionHandler {
    /**
     * Prompts the user via the browser to pair with an OSSM BLE device
     * @requires that the page is served over HTTPS or from localhost AND is called by a user gesture
     * @returns BluetoothDevice on successful pairing
     * @throws DOMException if pairing is cancelled or fails
     */
    static async pairDevice(): Promise<OssmClient> {
        const bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: OSSM_DEVICE_NAME }],
            optionalServices: [OSSM_PRIMARY_SERVICE.uuid]
        });
        return new OssmClient(bleDevice);
    }

    #ossmPrimaryService: DiscoveredGattService<typeof OSSM_PRIMARY_SERVICE> | null = null;

    /**
     * Sets up the GATT services and characteristics for the OSSM device
     */
    protected async setupServicesAndCharacteristics(gatt: BluetoothRemoteGATTServer): Promise<void> {
        this.#ossmPrimaryService = await BleConnectionHandler.discoverGattService(gatt, OSSM_PRIMARY_SERVICE);
        this.#ossmPrimaryService.characteristics.currentState.addEventListener("characteristicvaluechanged", this.handleCurrentStateChanged.bind(this));
    }

    private handleCurrentStateChanged(event: Event): void {
    }
}
