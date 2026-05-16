import React from 'react';

// App Router dynamic: app/users/[id]/page.tsx → /users/:id
export default function UserDetailPage({ params }: { params: { id: string } }) {
    return <div>User {params.id}</div>;
}
