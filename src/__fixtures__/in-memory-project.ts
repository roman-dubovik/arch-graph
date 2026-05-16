import { Project } from 'ts-morph';

/**
 * Build a ts-morph `Project` backed by an in-memory FS, seeded with the given
 * file map. Path keys must look like absolute POSIX paths.
 *
 * Used across extractor tests — see `__fixtures__/README.md` for the pattern.
 */
export function inMemoryProject(files: Record<string, string>): Project {
    const project = new Project({
        useInMemoryFileSystem: true,
        compilerOptions: {
            target: 99,
            module: 99,
            moduleResolution: 100,
            strict: true,
            esModuleInterop: true,
        },
    });
    for (const [path, src] of Object.entries(files)) {
        project.createSourceFile(path, src);
    }
    return project;
}
