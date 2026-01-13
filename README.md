# OSSM BLE Web
OSSM BLE Web is library for communicating with OSSM devices over Bluetooth Low Energy (BLE) using web technologies.

## Requirements
- A modern web browser that supports the Web Bluetooth API (e.g., Google Chrome, Microsoft Edge).
- An OSSM device with BLE capabilities.
- Must be served over HTTPS or from localhost due to Web Bluetooth API security requirements.
- JavaScript enabled in the browser.
- User permission to access Bluetooth devices.

## Installation
You can include OSSM BLE Web in your web project by downloading the [latest release](https://github.com/ReadieFur/OSSM-BLE-Web/releases/latest).

## Example Usage
The library is bundled to a single JavaScript file. To use it in your web application you must import it as a `module`.  
See the exported `.d.ts` file for full type definitions.

#### Importing the Library
```ts
// Import as a module
import { OssmBle } from "./path/to/ossmBle";
```

#### Initialization
```ts
// Must be called in response to a user gesture, e.g., button click
const ossmBle = await OssmBle.pairDevice();
await ossmBle.begin();
await ossmBle.waitForReady();
```

#### Basic usage
```ts
await ossmBle.setSpeedKnobConfig(false);
await ossmBle.navigateTo(OssmPage.StrokeEngine);
await ossmBle.setDepth(80);
await ossmBle.setStroke(60);
await ossmBle.setSpeed(50);
```

#### Using Stroke Engine helper methods
```ts
// Apply a pattern with set stroke boundaries, speed and effect intensity (overloads available)
await ossmBle.runStrokeEnginePattern(new PatternHelper(
    KnownPattern.SimpleStroke,  // Pattern identifier (number)
    20,                         // The minimum depth percentage (0-100)
    80,                         // The maximum depth percentage (0-100)
    15,                         // The speed percentage (0-100)
    100,                        // How pronounced the effect is (0-100)
));

// Set the position absolutely
await ossmBle.setPosition(30, 50); // Set to 30% depth at 50% speed
```

#### Events
```ts
ossmBle.addEventListener(OssmEventType.StateChanged, (data: OSSMEventCallbackParameters) => {});
ossmBle.addEventListener(OssmEventType.Connected, (data: null) => {});
ossmBle.addEventListener(OssmEventType.Disconnected, (data: null) => {});
```
