import React from 'react';

// React.forwardRef wrapper
export const ForwardInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
    (props, ref) => <input {...props} ref={ref} />,
);

ForwardInput.displayName = 'ForwardInput';
