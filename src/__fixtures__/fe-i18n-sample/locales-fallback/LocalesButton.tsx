import { useTranslations } from 'next-intl';

export const LocalesButton = () => {
    const t = useTranslations();
    return <button>{t('common.apply')}</button>;
};
