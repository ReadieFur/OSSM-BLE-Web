# OSSM BLE Web
OSSM BLE Web is library for communicating with [OSSM](https://github.com/KinkyMakers/OSSM-hardware) (and [RAD API](https://github.com/researchanddesire/rad-ble) enabled) devices over Bluetooth Low Energy (BLE) using web technologies, handling all the heavy stuff for you!

## Requirements
- A modern web browser that supports the Web Bluetooth API (e.g., Google Chrome, Microsoft Edge).
- An OSSM device with BLE capabilities.
- Must be served over HTTPS or from localhost due to Web Bluetooth API security requirements.
- JavaScript enabled in the browser.
- User permission to access Bluetooth devices.

## Installation
You can include OSSM BLE Web in your web project by downloading the [latest release](https://github.com/ReadieFur/OSSM-BLE-Web/releases/latest).

## Quick start usage guide
The library is bundled to a single JavaScript file. To use it in your web application you must import either the `ossm-ble-web.global.js` for global scope or as a module using `ossm-ble-web.js`.  

This library has VASTLY far more capabilities than what is listed below.  
See the generated `.d.ts` file for full type definitions.  
The source code is also HEAVILY documented so you can see how it all works in there.  
<details>
<summary><small>And you might want to take a look at my source code...</small></summary>
<small>Since there is no documentation on how the RAD/OSSM BLE API works, what you can find on ResearchAndDesire is way TF outdated so all of this had to be reverse engineered from, what is in my opinion, the steaming pile of **** that is the OSSM firmware lol</small>
</details>

#### Importing the Library
```ts
// Import as a module
import { OssmBleClient } from "ossm-ble-web";
```

#### Initialization
```ts
// Must be called in response to a user gesture, e.g., button click
const client = await OssmBleClient.pairDevice();
await client.begin();
await client.connect();
await client.acquireLease(true); // Required for write operations
```

#### Basic usage
```ts
await client.setSpeedKnobAsLimit(false);
await client.navigateTo(OssmMenu.StrokeEngine);
// Use Promise.all instead of awaiting for each since it is faster (doesn't wait for a response before starting the next call)
await Promise.all([
    client.setDepth(80),
    client.setStroke(60),
    client.setSpeed(50)
]);
```

#### Device information
```ts
await client.getAnalogSnapshot(); // Returns {@see OssmAnalogSnapshot} (e.g. motor current)
await client.getMotionSnapshot(); // Returns {@see OssmMotionSnapshot} (e.g. current position, speed)
await client.getActivePatternIndex();
await Array.fromAsync(await client.getPatterns()); // Returns an async iterator for {@see OssmPattern} (e.g. idx, name, description)
```

#### Events
A note about events, while multiple `surfaces` can be listened to, only one `stream` can be activated at a time.  
Due to how `getSnapshot()` works, if a `stream` is active then `getSnapshot()` cannot be called, and vice-versa.
```ts
// The value passed to [] must be <keyof OssmSurfaceEvents>, ide type hints will constrain the callback parameter
client.onSurface[RadSurface.Motion].subscribe((motionSnapshot: OssmMotionSnapshot) => {});
client.startStream({ surface: RadSurface.Motion, rateHz: 10 });
// client.getXSnapshot() -> Will fail here since a stream has been started
```

A way to work around this is to instead never start a stream and instead set-up your callbacks and run your own loop that calls `getSnapshot()`.  
This is slower and can't report nearly as fast (in testing about a max of 4hz), but will allow you to listen for multiple surfaces since any call to getSnapshot also triggers the `onSurface` callback.
```ts
client.onSurface[RadSurface.Analog].subscribe((analogSnapshot: OssmAnalogSnapshot) => {});
client.onSurface[RadSurface.Motion].subscribe((motionSnapshot: OssmMotionSnapshot) => {});

// Every time this loop runs it will trigger the onSurface callbacks to run
setInterval(async () => {
    // The library internally handles the queuing and interception of stream messages for these calls
    await Promise.all([
        client.getAnalogSnapshot(),
        client.getMotionSnapshot()
    ]);
}, 1000);
```
