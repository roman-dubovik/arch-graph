import React from 'react';

interface ButtonProps {
    label: string;
    onClick?: () => void;
}

export const Button = ({ label, onClick }: ButtonProps) => (
    <button onClick={onClick}>{label}</button>
);

export default Button;
