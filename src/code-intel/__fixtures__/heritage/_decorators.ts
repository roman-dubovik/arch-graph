/**
 * Shim for NestJS decorators used in heritage fixtures.
 * These are no-op decorator factories. The ts-morph AST parser doesn't care
 * about their actual signatures, just that they're defined.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
export function Get(_path?: string): any {
    return function () {
        /* no-op */
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
export function Post(_path?: string): any {
    return function () {
        /* no-op */
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
export function Put(_path?: string): any {
    return function () {
        /* no-op */
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
export function Delete(_path?: string): any {
    return function () {
        /* no-op */
    };
}
