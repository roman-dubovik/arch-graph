import React from 'react';
import { Button } from './Button';

interface CardProps {
    title: string;
}

// Function declaration component
function Card({ title }: CardProps) {
    return (
        <div className="card">
            <h2>{title}</h2>
            <Button label="Click me" />
        </div>
    );
}

export default Card;
