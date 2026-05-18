import React from 'react';

interface MemoCardProps {
    title: string;
}

const MemoCardInner = ({ title }: MemoCardProps) => <div>{title}</div>;

// React.memo wrapper
export const MemoCard = React.memo(MemoCardInner);
