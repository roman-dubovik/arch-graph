import React from 'react';
import { Avatar } from '../../src/components/Avatar';

interface UserPageProps {
    id: string;
}

// Pages Router dynamic: pages/users/[id].tsx → /users/:id
export default function UserPage({ id }: UserPageProps) {
    return (
        <div>
            <h1>User {id}</h1>
            <Avatar src="/avatar.png" alt="User avatar" />
        </div>
    );
}
