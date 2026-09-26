import { defineConfig } from 'tsup';
import { name, version } from './package.json';
import fs from 'fs';
import path from 'path';

function getSourceFiles(dir: string): string[] {
    let results: string[] = [];

    for (const file of fs.readdirSync(dir)) {
        // Skip hidden virtual entry file and ambient declarations
        if (file.startsWith('.') || file.endsWith('.d.ts')) continue;

        const filePath = path.join(dir, file);

        if (fs.statSync(filePath)?.isDirectory())
            results = results.concat(getSourceFiles(filePath));
        else if (file.endsWith('.ts'))
            results.push(filePath);
    }

    return results;
}

function createVirtualEntry(): string {
    const srcDir = path.resolve('./src');
    const files = getSourceFiles(srcDir);

    const exportStatements = files.map((file) => {
        // Get relative path from src/ root
        const relativePath = './' + path.relative(srcDir, file)
            .replace(/\\/g, '/')
            .replace(/\.ts$/, '');

        // Check for top-level export keywords or export statements
        return /\bexport\b/.test(fs.readFileSync(file, 'utf-8'))
            ? `export * from '${relativePath}';` // If the file has exports, re-export them
            : `import '${relativePath}';`; // If the file has no exports, just import it for side effects
    });

    const entryPath = path.resolve('./src/.virtual_entry.ts');
    fs.writeFileSync(entryPath, exportStatements.join('\n') + '\n');
    return entryPath;
}

let watcherInitialized = false;

function setupDirectoryWatcher() {
    if (watcherInitialized) return;
    watcherInitialized = true;

    const srcDir = path.resolve('./src');
    let debounceTimer: NodeJS.Timeout | null = null;

    console.log(`\x1b[34mCLI\x1b[0m Watching "${path.relative(process.cwd(), srcDir).replace(/\\/g, '/')}/**/*.ts" for changes...`);

    // Watch the src directory recursively for added/deleted files
    fs.watch(srcDir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;

        const normalized = filename.replace(/\\/g, '/');
        if (normalized.startsWith('.') || normalized.includes('/.') || normalized.endsWith('.d.ts'))
            return;

        if (normalized.endsWith('.ts')) {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => createVirtualEntry(), 50);
        }
    });
}

export default defineConfig((options) => {
    createVirtualEntry();

    if (options.watch)
        setupDirectoryWatcher();

    return {
        entry: {
            // This custom entry file bundles the library more like a C# class library where there is no main entrypoint
            'ossm-ble-web': './src/.virtual_entry.ts'
        },
        format: ['esm', 'iife'],
        globalName: 'OssmBleWeb',
        dts: true,
        clean: true,
        sourcemap: true,
        minify: !options.watch,
        target: 'esnext',
        define: {
            __VERSION__: JSON.stringify(version), // TODO: Make the 'patch' version CalVer when pushed to branch main
        },
        noExternal: ['crc-32']
    };
});
