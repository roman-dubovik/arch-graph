/**
 * Uses process.env directly — detected by config extractor.
 */
export function getEnvConfig() {
    const nodeEnv = process.env.NODE_ENV ?? 'development';
    const port = process.env.PORT ?? '3000';
    const apiKey = process.env.API_KEY;
    return { nodeEnv, port, apiKey };
}
