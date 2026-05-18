// A .tsx file that contains no JSX — tests the isFE && !JSX branch
// This is a type utility file that happens to have .tsx extension
export type Maybe<T> = T | null | undefined;

export function assertDefined<T>(val: T | null | undefined): T {
    if (val === null || val === undefined) {
        throw new Error('Expected defined value');
    }
    return val;
}
