import { useTranslations } from 'next-intl';

export const EnOnlyButton = () => {
    const t = useTranslations();
    return <button>{t('common.en_only_key')}</button>;
};
