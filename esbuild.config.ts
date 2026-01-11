import * as esbuild from "esbuild";
import watcher from "@parcel/watcher";
import fs from "fs";

//#region User configurable build options
// Base build options
const projectBuildOptions: esbuild.BuildOptions = {
    entryPoints: ["src/ossmBle.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: ["esnext"]
};

// Profile overrides
const profiles: Record<string, esbuild.BuildOptions> = {
    release: {
        sourcemap: true,
        sourcesContent: false,
        outfile: "dist/ossmBle.js",
    },
    "release-min": {
        minify: true,
        outfile: "dist/ossmBle.min.js",
    },
    dev: {
        sourcemap: true,
        sourcesContent: false,
        outfile: "dist/ossmBle.dev.js",
    }
};

const devTestingBuildOptions: esbuild.BuildOptions = {
    // entrypoints should be all TS files in dev/
    ...projectBuildOptions,
    entryPoints: await fs.promises.readdir("dev").then(files =>
        files.filter(f => f.endsWith(".ts")).map(f => `dev/${f}`)
    ),
    bundle: false,
    sourcemap: true,
    sourcesContent: false,
    outdir: "dev"
};
//#endregion

//#region Build process
const argv = process.argv.slice(2); // skip node + script path
let profile = argv.find(arg => arg.startsWith("--profile="))?.split("=")[1];
const isDevProfile = profile?.startsWith("dev");
const watchMode = argv.includes("--watch");

if (!profile || !(profile in profiles)) {
    console.log(`Unknown profile "${profile}", falling back to "release"`);
    profile = "release";
} else {
    console.log(`Building with profile: ${profile}`);
}

const buildOptions = {
    ...projectBuildOptions,
    ...profiles[profile]
};

async function build(): Promise<void> {
    try {
        await esbuild.build(buildOptions)
        if (isDevProfile)
            await esbuild.build(devTestingBuildOptions);
        console.log("Build succeeded.");
    } catch (error) {
        throw error;
    }
}

if (watchMode) {
    const DEBOUNCE_MS = 100;
    const FS_DELAY_MS = 100; // Delay a bit to allow fs operations to complete (e.g. multiple writes)

    let lastRun: number = Date.now();

    async function watcherCb(err: Error | null, events: watcher.Event[]): Promise<void> {
        if (err) {
            console.error("Watcher error:", err);
            return;
        }

        const now = Date.now();
        if (now - lastRun < DEBOUNCE_MS)
            return;
        lastRun = now;
        await new Promise(resolve => setTimeout(resolve, FS_DELAY_MS));

        // Strip the path of changed files to only show relative paths
        const eventsRelative = events.map(e => ({
            ...e,
            path: e.path.startsWith(process.cwd()) ? e.path.slice(process.cwd().length + 1) : e.path
        }));
        console.log(`Change detected [${eventsRelative.map(e => e.path).join(", ")}], rebuilding...`);

        try { await build(); }
        catch {}
    }

    try { await build(); } // Initial build
    catch {}
    
    console.log("Watching for changes...");
    watcher.subscribe("src", async (err, events) => watcherCb(err, events), { ignore: ["!**/*.ts"] });
    if (isDevProfile)
        watcher.subscribe("dev", async (err, events) => watcherCb(err, events), { ignore: ["!**/*.ts"] });
} else {
    try { await build(); }
    catch { process.exit(1); }
}
//#endregion
