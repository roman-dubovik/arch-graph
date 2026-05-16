import React from 'react';

interface AvatarProps {
    src: string;
    alt: string;
}

// Class component
class Avatar extends React.Component<AvatarProps> {
    render() {
        return <img src={this.props.src} alt={this.props.alt} />;
    }
}

export { Avatar };
