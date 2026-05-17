import { useTranslation } from 'react-i18next';

export const BlogsComponent = () => {
    const { t } = useTranslation('blogs');
    return <h1>{t('title')}</h1>;
};
