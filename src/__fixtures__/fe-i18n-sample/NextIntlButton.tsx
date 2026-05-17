import { useTranslations } from 'next-intl';

export const NextIntlButton = () => {
    const t = useTranslations();
    return <button>{t('common.apply')}</button>;
};
