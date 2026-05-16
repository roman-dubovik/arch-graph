import { useState, useEffect } from 'react';

// Arrow function hook
export const useFetch = (url: string) => {
    const [data, setData] = useState<unknown>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch(url)
            .then((r) => r.json())
            .then((d) => { setData(d); setLoading(false); });
    }, [url]);

    return { data, loading };
};
