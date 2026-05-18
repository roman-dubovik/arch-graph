import { useTranslations } from 'next-intl';

export const ApplyButton = () => {
    const t = useTranslations();
    return <button>{t('common.apply')}</button>;
};
