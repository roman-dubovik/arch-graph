import React from 'react';
import { Button } from '../src/components/Button';
import Card from '../src/components/Card';

// Pages Router: pages/index.tsx → /
export default function HomePage() {
    return (
        <main>
            <h1>Home</h1>
            <Card title="Welcome" />
            <Button label="Get Started" />
        </main>
    );
}
