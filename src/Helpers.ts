export function isClientBleCapable() {
    return !(!navigator.bluetooth || !navigator.bluetooth.requestDevice);
}
