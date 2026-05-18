import React from 'react';
import type { AppProps } from 'next/app';

// Pages Router internal — should NOT be treated as a route
export default function MyApp({ Component, pageProps }: AppProps) {
    return <Component {...pageProps} />;
}
