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

function generateVirtualEntry(isWatch: boolean): void | string {
    const srcDir = path.resolve('./src');
    const files = getSourceFiles(srcDir);

    const exportStatements: string[] = [];
    
    // Track globally emitted names and their source files for collision detection
    const emittedValues = new Map<string, string>(); // name:filepath
    const emittedTypes = new Map<string, string>();  // name:filepath
    let collisionError: string | null = null;

    for (const file of files) {
        // Skip the virtual entry file itself if it exists in src
        if (path.resolve(file) === path.resolve('./src/.virtual_entry.ts')) continue;

        const relativePath = './' + path.relative(srcDir, file)
            .replace(/\\/g, '/')
            .replace(/\.ts$/, '');

        // Strip single-line comments and non-JSDoc block comments so commented-out code is ignored while keeping JSDoc comments (/** ... */) intact for '@internal' checks.
        const content = fs.readFileSync(file, 'utf-8')
            .split(/\r?\n/)
            .map(line => {
                const trimmed = line.trim();
                if (trimmed.startsWith('//')) return '';
                const commentIdx = line.indexOf('//');
                return commentIdx !== -1 ? line.substring(0, commentIdx) : line;
            })
            .join('\n')
            .replace(/\/\*(?!\*)[\s\S]*?\*\//g, '');

        // Match value exports (function, const, let, var, class, enum)
        const valueRegex = /(\/\*\*[\s\S]*?\*\/)?\s*export\s+(?:async\s+)?(?:function|const|let|var|class|enum)\s+([a-zA-Z0-9_]+)/g;
        // Match type exports (interface, type)
        const typeRegex = /(\/\*\*[\s\S]*?\*\/)?\s*export\s+(?:type|interface)\s+([a-zA-Z0-9_]+)/g;

        let match;
        const fileValues = new Set<string>();
        const fileTypes = new Set<string>();

        // Process values
        while ((match = valueRegex.exec(content)) !== null) {
            const jsdoc = match[1] || '';
            const name = match[2];
            
            if (jsdoc.includes('@internal')) continue;

            if (emittedValues.has(name) && emittedValues.get(name) !== relativePath) {
                collisionError = `Duplicate value export "${name}" found in "${relativePath}". It is already exported from "${emittedValues.get(name)}".`;
                break;
            }

            fileValues.add(name);
            emittedValues.set(name, relativePath);
        }

        if (collisionError) break;

        // Process types
        while ((match = typeRegex.exec(content)) !== null) {
            const jsdoc = match[1] || '';
            const name = match[2];
            
            if (jsdoc.includes('@internal')) continue;

            const existingValueSource = emittedValues.get(name);
            const existingTypeSource = emittedTypes.get(name);

            if ((existingValueSource && existingValueSource !== relativePath) || (existingTypeSource && existingTypeSource !== relativePath)) {
                const existingSource = existingValueSource || existingTypeSource;
                collisionError = `Duplicate type/value export "${name}" found in "${relativePath}". It is already exported from "${existingSource}".`;
                break;
            }

            fileTypes.add(name);
            emittedTypes.set(name, relativePath);
        }

        if (collisionError) break;

        for (const val of fileValues)
            if (fileTypes.has(val))
                fileTypes.delete(val);

        const pureValues = Array.from(fileValues);
        const pureTypes = Array.from(fileTypes);

        if (pureValues.length > 0)
            exportStatements.push(`export { ${pureValues.join(', ')} } from '${relativePath}';`);
        if (pureTypes.length > 0)
            exportStatements.push(`export type { ${pureTypes.join(', ')} } from '${relativePath}';`);
    }

    const entryPath = path.resolve('./src/.virtual_entry.ts');

    if (collisionError) {
        if (!isWatch) {
            // Production: Poison the entry file so DTS fails hard alongside JS bundles
            fs.writeFileSync(entryPath, `// BUILD FAILED: ${collisionError}\nexport const __BUILD_ERROR__: never = ${JSON.stringify(collisionError)};\n`);
        } else {
            // Watch mode: Write a clean placeholder comment instead of poisoning, keeping watch mode fully responsive
            fs.writeFileSync(entryPath, `// COLLISION DETECTED: ${collisionError}\n`);
        }
        return collisionError;
    }

    fs.writeFileSync(entryPath, exportStatements.join('\n') + '\n');
}

export default defineConfig((options) => {
    const isWatch = !!options.watch;

    // Pre-generate once immediately so the file exists before tsup checks entry paths at startup
    generateVirtualEntry(isWatch);

    return {
        entry: {
            'ossm-ble-web': './src/.virtual_entry.ts'
        },
        format: ['esm', 'iife'],
        globalName: 'OssmBleWeb',
        dts: true,
        clean: true,
        sourcemap: true,
        minify: !isWatch,
        target: 'esnext',
        define: {
            __VERSION__: JSON.stringify(version),
        },
        noExternal: ['crc-32'],
        esbuildPlugins: [
            {
                name: 'virtual-entry-generator',
                setup(build: any) {
                    build.onStart(() => {
                        const errored = generateVirtualEntry(isWatch);
                        if (errored) {
                            return { errors: [{ text: errored }] };
                        }
                    });
                },
            }
        ]
    };
});
