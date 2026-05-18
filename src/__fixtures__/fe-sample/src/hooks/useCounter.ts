import { useState } from 'react';

// Custom hook: name starts with use[A-Z], calls another hook (useState)
export function useCounter(initial = 0) {
    const [count, setCount] = useState(initial);
    return {
        count,
        increment: () => setCount((n) => n + 1),
        decrement: () => setCount((n) => n - 1),
    };
}
