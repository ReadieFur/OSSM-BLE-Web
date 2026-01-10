// Reference: https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/services/communication/BLE_Protocol.md

export class OssmBle implements Disposable {
    static readonly PRIMARY_SERVICE_UUID = '522b443a-4f53-534d-0001-420badbabe69';
    static readonly DEVICE_NAME = "OSSM";
    static async pairDevice(): Promise<OssmBle> {
        const bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: OssmBle.DEVICE_NAME }],
            optionalServices: [OssmBle.PRIMARY_SERVICE_UUID]
        });

        const ossmBle = new OssmBle(bleDevice);
        return ossmBle;
    }
    private readonly device: BluetoothDevice;
    private constructor(device: BluetoothDevice) {
        this.device = device;
        if (!device.gatt)
            throw new Error("Device is not connectable via GATT.");
    }
    [Symbol.dispose](): void {
        if (this.device.gatt?.connected)
            this.device.gatt.disconnect();
    }
}
